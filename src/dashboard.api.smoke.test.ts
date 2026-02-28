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

async function withDashboardServer({ dashboardToken = "" } = {}, run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-dashboard-smoke-"));
  const dbPath = path.join(dir, "clanker.db");
  const store = new Store(dbPath);
  store.init();
  let dashboard = null;
  let serverClosed = false;

  try {
    const bot = {
      appliedSettings: [],
      async applyRuntimeSettings(nextSettings) {
        this.appliedSettings.push(nextSettings);
      },
      getRuntimeState() {
        return {
          connected: true,
          replyQueuePending: 0
        };
      },
      async ingestVoiceStreamFrame() {
        return {
          accepted: false,
          reason: "not_configured"
        };
      }
    };

    const memory = {
      async readMemoryMarkdown() {
        return "# memory\n";
      },
      async refreshMemoryMarkdown() {
        return true;
      },
      async searchDurableFacts() {
        return [];
      }
    };

    const appConfig = {
      dashboardHost: "127.0.0.1",
      dashboardPort: 0,
      dashboardToken,
      publicApiToken: ""
    };

    dashboard = createDashboardServer({
      appConfig,
      store,
      bot,
      memory,
      publicHttpsEntrypoint: null,
      screenShareSessionManager: null
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
      throw new Error("dashboard test server did not provide a valid port");
    }
    const baseUrl = `http://127.0.0.1:${port}`;

    await run({ baseUrl, bot, store });
  } catch (error) {
    if (isListenPermissionError(error)) {
      return { skipped: true, reason: "listen_permission_denied" };
    }
    throw error;
  } finally {
    if (dashboard?.server && !serverClosed) {
      await new Promise((resolve) => {
        dashboard.server.close(() => {
          serverClosed = true;
          resolve();
        });
      }).catch(() => undefined);
    }
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }

  return { skipped: false };
}

test("dashboard API smoke: health/settings/actions/stats endpoints", async () => {
  const result = await withDashboardServer({}, async ({ baseUrl, bot, store }) => {
    const healthResponse = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthResponse.status, 200);
    const healthJson = await healthResponse.json();
    assert.equal(healthJson.ok, true);

    const settingsResponse = await fetch(`${baseUrl}/api/settings`);
    assert.equal(settingsResponse.status, 200);
    const settingsJson = await settingsResponse.json();
    assert.equal(typeof settingsJson.activity?.replyLevelInitiative, "number");
    assert.equal(typeof settingsJson.activity?.replyLevelNonInitiative, "number");
    assert.equal(typeof settingsJson.replyFollowupLlm?.enabled, "boolean");

    const updatePayload = {
      activity: {
        replyLevelInitiative: 62,
        replyLevelNonInitiative: 14
      },
      replyFollowupLlm: {
        enabled: true,
        provider: "anthropic",
        model: "claude-haiku-4-5"
      }
    };
    const updateResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(updatePayload)
    });
    assert.equal(updateResponse.status, 200);
    const updatedSettings = await updateResponse.json();
    assert.equal(updatedSettings.activity.replyLevelInitiative, 62);
    assert.equal(updatedSettings.activity.replyLevelNonInitiative, 14);
    assert.equal(updatedSettings.replyFollowupLlm.enabled, true);
    assert.equal(updatedSettings.replyFollowupLlm.provider, "anthropic");
    assert.equal(updatedSettings.replyFollowupLlm.model, "claude-haiku-4-5");
    assert.equal(bot.appliedSettings.length, 1);

    const persisted = store.getSettings();
    assert.equal(persisted.activity.replyLevelInitiative, 62);
    assert.equal(persisted.activity.replyLevelNonInitiative, 14);
    assert.equal(persisted.replyFollowupLlm.enabled, true);

    const actionsResponse = await fetch(`${baseUrl}/api/actions?limit=25`);
    assert.equal(actionsResponse.status, 200);
    const actionsJson = await actionsResponse.json();
    assert.equal(Array.isArray(actionsJson), true);

    const statsResponse = await fetch(`${baseUrl}/api/stats`);
    assert.equal(statsResponse.status, 200);
    const statsJson = await statsResponse.json();
    assert.equal(typeof statsJson.stats, "object");
    assert.equal(typeof statsJson.stats.performance, "object");
    assert.equal(typeof statsJson.runtime, "object");
  });
  if (result?.skipped) {
    return;
  }
});

test("dashboard API smoke: dashboard token auth gates /api routes", async () => {
  const result = await withDashboardServer({ dashboardToken: "smoke-token" }, async ({ baseUrl }) => {
    const unauthorized = await fetch(`${baseUrl}/api/settings`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${baseUrl}/api/settings`, {
      headers: {
        "x-dashboard-token": "smoke-token"
      }
    });
    assert.equal(authorized.status, 200);
  });
  if (result?.skipped) {
    return;
  }
});
