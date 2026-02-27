import test from "node:test";
import assert from "node:assert/strict";
import { VoiceSessionManager } from "./voice/voiceSessionManager.ts";

function createManager() {
  return new VoiceSessionManager({
    client: {
      on() {},
      off() {},
      guilds: { cache: new Map() },
      users: { cache: new Map() },
      user: { id: "bot-user", username: "clanker conk" }
    },
    store: {
      logAction() {},
      getSettings() {
        return {
          botName: "clanker conk"
        };
      }
    },
    appConfig: {},
    llm: {
      async generate() {
        return {
          text: "NO"
        };
      }
    },
    memory: null
  });
}

test("getMissingJoinPermissionInfo reports when bot member is unavailable", () => {
  const manager = createManager();
  const info = manager.getMissingJoinPermissionInfo({
    guild: {
      members: {
        me: null
      }
    },
    voiceChannel: {}
  });
  assert.deepEqual(info, {
    reason: "bot_member_unavailable",
    missingPermissions: []
  });
});

test("getMissingJoinPermissionInfo reports connect/speak permissions and null when all are present", () => {
  const manager = createManager();
  const missing = manager.getMissingJoinPermissionInfo({
    guild: {
      members: {
        me: { id: "bot-user" }
      }
    },
    voiceChannel: {
      permissionsFor() {
        return {
          has() {
            return false;
          }
        };
      }
    }
  });
  assert.equal(missing?.reason, "missing_voice_permissions");
  assert.deepEqual(missing?.missingPermissions, ["CONNECT", "SPEAK"]);

  const noneMissing = manager.getMissingJoinPermissionInfo({
    guild: {
      members: {
        me: { id: "bot-user" }
      }
    },
    voiceChannel: {
      permissionsFor() {
        return {
          has() {
            return true;
          }
        };
      }
    }
  });
  assert.equal(noneMissing, null);
});

test("composeMissingPermissionFallback formats clear responses", () => {
  const manager = createManager();
  assert.equal(manager.composeMissingPermissionFallback(null), "");
  assert.equal(
    manager.composeMissingPermissionFallback({
      reason: "bot_member_unavailable",
      missingPermissions: []
    }),
    "can't resolve my voice permissions in this server yet."
  );
  assert.equal(
    manager.composeMissingPermissionFallback({
      reason: "missing_voice_permissions",
      missingPermissions: []
    }),
    "i need voice permissions in that vc before i can join."
  );
  assert.equal(
    manager.composeMissingPermissionFallback({
      reason: "missing_voice_permissions",
      missingPermissions: ["CONNECT", "SPEAK"]
    }),
    "i need CONNECT and SPEAK permissions in that vc before i can join."
  );
});
