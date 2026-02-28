import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDashboardServer } from "./dashboard.ts";
import { Store } from "./store.ts";

function isListenPermissionError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "");
  return (
    code === "EPERM" ||
    code === "EACCES" ||
    (code === "EADDRINUSE" && /port\s+0\s+in\s+use/i.test(message)) ||
    /listen\s+EPERM|listen\s+EACCES/i.test(message)
  );
}

async function withDashboardServer(
  {
    appConfigOverrides = {},
    publicHttpsState = null,
    botOverrides = {},
    memoryOverrides = {},
    screenShareSessionManager = null
  } = {},
  run
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-dashboard-routes-"));
  const dbPath = path.join(dir, "clanker.db");
  const store = new Store(dbPath);
  store.init();

  let dashboard = null;
  let closed = false;
  try {
    const ingestCalls = [];
    const bot = {
      async applyRuntimeSettings() {},
      getRuntimeState() {
        return {
          connected: true,
          replyQueuePending: 0
        };
      },
      async ingestVoiceStreamFrame(payload) {
        ingestCalls.push(payload);
        return {
          accepted: true,
          reason: "ok"
        };
      },
      ...botOverrides
    };

    const memoryCalls = [];
    const memory = {
      async readMemoryMarkdown() {
        return "# memory";
      },
      async refreshMemoryMarkdown() {
        return true;
      },
      async searchDurableFacts(payload) {
        memoryCalls.push(payload);
        return [{ fact: "remember this" }];
      },
      ...memoryOverrides
    };

    const appConfig = {
      dashboardHost: "127.0.0.1",
      dashboardPort: 0,
      dashboardToken: "",
      publicApiToken: "",
      ...appConfigOverrides
    };

    const publicHttpsEntrypoint = publicHttpsState
      ? {
          getState() {
            return publicHttpsState;
          }
        }
      : null;

    dashboard = createDashboardServer({
      appConfig,
      store,
      bot,
      memory,
      publicHttpsEntrypoint,
      screenShareSessionManager
    });

    if (!dashboard.server.listening) {
      await new Promise((resolve, reject) => {
        const onListening = () => {
          dashboard.server.off("error", onError);
          resolve();
        };
        const onError = (error) => {
          dashboard.server.off("listening", onListening);
          reject(error);
        };
        dashboard.server.once("listening", onListening);
        dashboard.server.once("error", onError);
      });
    }

    const address = dashboard.server.address();
    const port = typeof address === "object" && address ? address.port : null;
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error("dashboard test server did not expose a valid port");
    }

    await run({
      baseUrl: `http://127.0.0.1:${port}`,
      store,
      bot,
      memory,
      ingestCalls,
      memoryCalls
    });
  } catch (error) {
    if (isListenPermissionError(error)) {
      return { skipped: true, reason: "listen_permission_denied" };
    }
    throw error;
  } finally {
    if (dashboard?.server && !closed) {
      await new Promise((resolve) => {
        dashboard.server.close(() => {
          closed = true;
          resolve();
        });
      }).catch(() => undefined);
    }
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }

  return { skipped: false };
}

test("dashboard memory search handles missing params and valid lookups", async () => {
  const result = await withDashboardServer({}, async ({ baseUrl, memoryCalls }) => {
    const missing = await fetch(`${baseUrl}/api/memory/search?guildId=guild-1`);
    assert.equal(missing.status, 200);
    const missingJson = await missing.json();
    assert.deepEqual(missingJson.results, []);
    assert.equal(missingJson.limit, 0);

    const found = await fetch(
      `${baseUrl}/api/memory/search?q=launch+plan&guildId=guild-1&channelId=chan-2&limit=4`
    );
    assert.equal(found.status, 200);
    const foundJson = await found.json();
    assert.equal(foundJson.results.length, 1);
    assert.equal(memoryCalls.length, 1);
    assert.equal(memoryCalls[0]?.guildId, "guild-1");
    assert.equal(memoryCalls[0]?.channelId, "chan-2");
    assert.equal(memoryCalls[0]?.queryText, "launch plan");
    assert.equal(memoryCalls[0]?.limit, 4);
  });

  if (result?.skipped) {
    return;
  }
});

test("dashboard automations and share-session routes validate params and unavailable manager states", async () => {
  const result = await withDashboardServer({}, async ({ baseUrl, store }) => {
    store.createAutomation({
      guildId: "guild-1",
      channelId: "chan-1",
      createdByUserId: "user-1",
      createdByName: "alice",
      title: "daily post",
      instruction: "post summary",
      schedule: { kind: "interval", everyMinutes: 15 },
      nextRunAt: new Date(Date.now() + 15 * 60_000).toISOString()
    });

    const missingGuild = await fetch(`${baseUrl}/api/automations`);
    assert.equal(missingGuild.status, 400);

    const list = await fetch(`${baseUrl}/api/automations?guildId=guild-1&status=active,paused&q=daily`);
    assert.equal(list.status, 200);
    const listJson = await list.json();
    assert.equal(Array.isArray(listJson.rows), true);
    assert.equal(listJson.rows.length, 1);

    const invalidRuns = await fetch(`${baseUrl}/api/automations/runs?guildId=guild-1&automationId=0`);
    assert.equal(invalidRuns.status, 400);

    const shareCreate = await fetch(`${baseUrl}/api/voice/share-session`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        guildId: "guild-1",
        channelId: "chan-1",
        requesterUserId: "user-1"
      })
    });
    assert.equal(shareCreate.status, 503);

    const shareFrame = await fetch(`${baseUrl}/api/voice/share-session/token1234567890/frame`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        mimeType: "image/jpeg",
        dataBase64: "abc"
      })
    });
    assert.equal(shareFrame.status, 503);

    const shareStop = await fetch(`${baseUrl}/api/voice/share-session/token1234567890/stop`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ reason: "manual" })
    });
    assert.equal(shareStop.status, 503);

    const sharePage = await fetch(`${baseUrl}/share/token1234567890`);
    assert.equal(sharePage.status, 503);
    const shareText = await sharePage.text();
    assert.equal(shareText.includes("Screen share link unavailable"), true);
  });

  if (result?.skipped) {
    return;
  }
});

test("dashboard public tunnel and public API token gates are enforced", async () => {
  const result = await withDashboardServer(
    {
      appConfigOverrides: {
        dashboardToken: "dash-token",
        publicApiToken: "public-token"
      },
      publicHttpsState: {
        enabled: true,
        publicUrl: "https://fancy-cat.trycloudflare.com"
      }
    },
    async ({ baseUrl, ingestCalls }) => {
      const blockedSettings = await fetch(`${baseUrl}/api/settings`, {
        headers: {
          "x-forwarded-host": "fancy-cat.trycloudflare.com"
        }
      });
      assert.equal(blockedSettings.status, 404);

      const wrongPublicToken = await fetch(`${baseUrl}/api/voice/stream-ingest/frame`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-public-api-token": "wrong"
        },
        body: JSON.stringify({
          guildId: "guild-1",
          dataBase64: "abc"
        })
      });
      assert.equal(wrongPublicToken.status, 401);
      const wrongPublicJson = await wrongPublicToken.json();
      assert.equal(wrongPublicJson.reason, "unauthorized_public_api_token");

      const okPublicToken = await fetch(`${baseUrl}/api/voice/stream-ingest/frame`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-public-api-token": "public-token"
        },
        body: JSON.stringify({
          guildId: "guild-1",
          streamerUserId: "user-7",
          mimeType: "image/jpeg",
          dataBase64: "abc123"
        })
      });
      assert.equal(okPublicToken.status, 200);
      const okPublicJson = await okPublicToken.json();
      assert.equal(okPublicJson.accepted, true);
      assert.equal(ingestCalls.length, 1);
      assert.equal(ingestCalls[0]?.guildId, "guild-1");
    }
  );

  if (result?.skipped) {
    return;
  }
});

test("dashboard public ingest requires at least one dashboard/public token", async () => {
  const result = await withDashboardServer({}, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/voice/stream-ingest/frame`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        guildId: "guild-1",
        dataBase64: "frame"
      })
    });

    assert.equal(response.status, 503);
    const json = await response.json();
    assert.equal(json.reason, "dashboard_or_public_api_token_required");
  });

  if (result?.skipped) {
    return;
  }
});
