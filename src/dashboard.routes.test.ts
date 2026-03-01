import { test } from "bun:test";
import assert from "node:assert/strict";
import { withDashboardServer } from "./testHelpers.ts";

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

test("dashboard voice join returns unavailable when bot does not expose join helper", async () => {
  const result = await withDashboardServer({}, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/voice/join`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        guildId: "guild-1"
      })
    });

    assert.equal(response.status, 503);
    const json = await response.json();
    assert.equal(json.ok, false);
    assert.equal(json.reason, "voice_join_unavailable");
  });

  if (result?.skipped) {
    return;
  }
});

test("dashboard settings refresh reapplies runtime settings and reports active sessions", async () => {
  const applyCalls = [];
  const result = await withDashboardServer(
    {
      botOverrides: {
        async applyRuntimeSettings(settings) {
          applyCalls.push(settings);
        },
        getRuntimeState() {
          return {
            connected: true,
            replyQueuePending: 0,
            voice: {
              activeCount: 2
            }
          };
        }
      }
    },
    async ({ baseUrl, store }) => {
      const response = await fetch(`${baseUrl}/api/settings/refresh`, {
        method: "POST"
      });
      assert.equal(response.status, 200);
      const json = await response.json();
      assert.equal(json.ok, true);
      assert.equal(json.reason, "settings_refreshed");
      assert.equal(json.activeVoiceSessions, 2);
      assert.equal(applyCalls.length, 1);
      assert.deepEqual(applyCalls[0], store.getSettings());
    }
  );

  if (result?.skipped) {
    return;
  }
});

test("dashboard settings refresh returns unavailable when bot runtime apply is missing", async () => {
  const result = await withDashboardServer(
    {
      botOverrides: {
        applyRuntimeSettings: null
      }
    },
    async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/settings/refresh`, {
        method: "POST"
      });
      assert.equal(response.status, 503);
      const json = await response.json();
      assert.equal(json.ok, false);
      assert.equal(json.reason, "settings_refresh_unavailable");
    }
  );

  if (result?.skipped) {
    return;
  }
});

test("dashboard voice join forwards payload to bot helper", async () => {
  const joinCalls = [];
  const result = await withDashboardServer(
    {
      botOverrides: {
        async requestVoiceJoinFromDashboard(payload) {
          joinCalls.push(payload);
          return {
            ok: true,
            reason: "joined",
            guildId: payload.guildId || "guild-1",
            voiceChannelId: "voice-1",
            textChannelId: "text-1",
            requesterUserId: payload.requesterUserId || "user-1"
          };
        }
      }
    },
    async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/voice/join`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          guildId: "guild-99",
          requesterUserId: "user-42",
          textChannelId: "chan-77",
          source: "test_case"
        })
      });

      assert.equal(response.status, 200);
      const json = await response.json();
      assert.equal(json.ok, true);
      assert.equal(json.reason, "joined");
      assert.equal(joinCalls.length, 1);
      assert.equal(joinCalls[0]?.guildId, "guild-99");
      assert.equal(joinCalls[0]?.requesterUserId, "user-42");
      assert.equal(joinCalls[0]?.textChannelId, "chan-77");
      assert.equal(joinCalls[0]?.source, "test_case");
    }
  );

  if (result?.skipped) {
    return;
  }
});
