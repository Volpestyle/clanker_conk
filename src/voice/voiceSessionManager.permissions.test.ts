import { test } from "bun:test";
import assert from "node:assert/strict";
import { VoiceSessionManager } from "./voiceSessionManager.ts";

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
