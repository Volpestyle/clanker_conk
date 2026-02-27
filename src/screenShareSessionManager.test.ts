import test from "node:test";
import assert from "node:assert/strict";
import { ScreenShareSessionManager } from "./screenShareSessionManager.ts";

function createHarness({
  isUserInSessionVoiceChannel = () => true,
  enableWatchStreamForUser = async () => ({ ok: true })
} = {}) {
  const actions = [];
  let ingestCalls = 0;
  const store = {
    getSettings() {
      return {
        voice: {
          streamWatch: {
            enabled: true
          }
        }
      };
    },
    logAction(action) {
      actions.push(action);
    }
  };
  const bot = {
    voiceSessionManager: {
      enableWatchStreamForUser,
      getSession() {
        return {
          guildId: "guild-1",
          voiceChannelId: "vc-1",
          ending: false
        };
      },
      isUserInSessionVoiceChannel
    },
    async ingestVoiceStreamFrame() {
      ingestCalls += 1;
      return {
        accepted: true,
        reason: "ok"
      };
    }
  };
  const publicHttpsEntrypoint = {
    getState() {
      return {
        enabled: true,
        status: "ready",
        publicUrl: "https://fancy-cat.trycloudflare.com"
      };
    }
  };
  const manager = new ScreenShareSessionManager({
    appConfig: {},
    store,
    bot,
    publicHttpsEntrypoint
  });
  return {
    actions,
    manager,
    getIngestCalls: () => ingestCalls
  };
}

test("createSession logs share host only (not full share URL token)", async () => {
  const { actions, manager } = createHarness();
  const created = await manager.createSession({
    guildId: "guild-1",
    channelId: "channel-1",
    requesterUserId: "user-1",
    requesterDisplayName: "volpe",
    targetUserId: "user-1",
    source: "test"
  });

  assert.equal(created.ok, true);
  const action = actions.find((entry) => String(entry?.content || "") === "screen_share_session_created");
  assert.ok(action);
  assert.equal(action.metadata.shareHost, "fancy-cat.trycloudflare.com");
  assert.equal("shareUrl" in (action.metadata || {}), false);
});

test("ingestFrameByToken rejects and stops session when requester leaves VC", async () => {
  const { actions, manager, getIngestCalls } = createHarness({
    isUserInSessionVoiceChannel({ userId }) {
      return String(userId || "") !== "user-1";
    }
  });
  const created = await manager.createSession({
    guildId: "guild-1",
    channelId: "channel-1",
    requesterUserId: "user-1",
    requesterDisplayName: "volpe",
    targetUserId: "user-1",
    source: "test"
  });
  assert.equal(created.ok, true);

  const result = await manager.ingestFrameByToken({
    token: created.token,
    mimeType: "image/jpeg",
    dataBase64: "dGVzdA==",
    source: "test"
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "requester_not_in_same_vc");
  assert.equal(getIngestCalls(), 0);
  assert.equal(manager.getSessionByToken(created.token), null);
  const stopAction = [...actions]
    .reverse()
    .find((entry) => String(entry?.content || "") === "screen_share_session_stopped");
  assert.ok(stopAction);
  assert.equal(stopAction.metadata.reason, "requester_not_in_same_vc");
});

test("ingestFrameByToken rejects and stops session when target leaves VC", async () => {
  const { actions, manager, getIngestCalls } = createHarness({
    isUserInSessionVoiceChannel({ userId }) {
      return String(userId || "") !== "target-9";
    }
  });
  const created = await manager.createSession({
    guildId: "guild-1",
    channelId: "channel-1",
    requesterUserId: "user-1",
    requesterDisplayName: "volpe",
    targetUserId: "target-9",
    source: "test"
  });
  assert.equal(created.ok, true);

  const result = await manager.ingestFrameByToken({
    token: created.token,
    mimeType: "image/jpeg",
    dataBase64: "dGVzdA==",
    source: "test"
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "target_user_not_in_same_vc");
  assert.equal(getIngestCalls(), 0);
  assert.equal(manager.getSessionByToken(created.token), null);
  const stopAction = [...actions]
    .reverse()
    .find((entry) => String(entry?.content || "") === "screen_share_session_stopped");
  assert.ok(stopAction);
  assert.equal(stopAction.metadata.reason, "target_user_not_in_same_vc");
});
