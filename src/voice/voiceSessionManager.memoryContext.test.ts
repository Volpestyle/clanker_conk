import { test } from "bun:test";
import assert from "node:assert/strict";
import { VoiceSessionManager } from "./voiceSessionManager.ts";

function createManager({ memory = null } = {}) {
  const logs = [];
  const client = {
    on() {},
    off() {},
    guilds: { cache: new Map() },
    users: { cache: new Map() },
    user: { id: "bot-user", username: "clanker conk" }
  };
  const store = {
    logAction(entry) {
      logs.push(entry);
    },
    getSettings() {
      return {
        botName: "clanker conk"
      };
    }
  };

  const manager = new VoiceSessionManager({
    client,
    store,
    appConfig: {},
    llm: {
      async generate() {
        return {
          text: "NO"
        };
      }
    },
    memory
  });

  return { manager, logs, client };
}

function createSession(overrides = {}) {
  return {
    id: "session-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    mode: "openai_realtime",
    ending: false,
    recentVoiceTurns: [],
    focusedSpeakerUserId: null,
    focusedSpeakerAt: 0,
    settingsSnapshot: {
      botName: "clanker conk"
    },
    ...overrides
  };
}

test("voice decision history formatting and turn recording dedupe behavior", () => {
  const { manager } = createManager();
  const session = createSession();

  manager.resolveVoiceSpeakerName = (_session, userId) => `user-${String(userId || "")}`;
  manager.recordVoiceTurn(session, {
    role: "user",
    userId: "a",
    text: "first turn"
  });
  manager.recordVoiceTurn(session, {
    role: "user",
    userId: "a",
    text: "first turn"
  });
  manager.recordVoiceTurn(session, {
    role: "assistant",
    text: "second turn"
  });

  assert.equal(session.recentVoiceTurns.length, 2);
  const formatted = manager.formatVoiceDecisionHistory(session, 6);
  assert.equal(formatted.includes("user-a"), true);
  assert.equal(formatted.includes("clanker conk"), true);
});

test("updateFocusedSpeakerWindow sets, preserves, and expires focused speaker", () => {
  const { manager } = createManager();
  const session = createSession({
    focusedSpeakerUserId: "old-user",
    focusedSpeakerAt: Date.now() - 40_000
  });

  manager.updateFocusedSpeakerWindow({
    session,
    userId: "user-1",
    allow: true,
    directAddressed: true,
    reason: "llm_yes"
  });
  assert.equal(session.focusedSpeakerUserId, "user-1");

  manager.updateFocusedSpeakerWindow({
    session,
    userId: "user-2",
    allow: false,
    directAddressed: false,
    reason: "llm_no"
  });
  assert.equal(session.focusedSpeakerUserId, "user-1");

  session.focusedSpeakerAt = Date.now() - 50_000;
  manager.updateFocusedSpeakerWindow({
    session,
    userId: "user-2",
    allow: false,
    directAddressed: false,
    reason: "llm_no"
  });
  assert.equal(session.focusedSpeakerUserId, null);
  assert.equal(session.focusedSpeakerAt, 0);
});

test("countHumanVoiceParticipants uses channel members and guild fallback paths", () => {
  const { manager, client } = createManager();
  client.guilds.cache.set("guild-1", {
    channels: {
      cache: new Map([
        [
          "voice-1",
          {
            members: new Map([
              [
                "u1",
                {
                  user: { bot: false }
                }
              ],
              [
                "u2",
                {
                  user: { bot: true }
                }
              ]
            ])
          }
        ]
      ])
    }
  });

  const direct = manager.countHumanVoiceParticipants(createSession());
  assert.equal(direct, 1);

  client.guilds.cache.set("guild-2", {
    channels: {
      cache: new Map()
    },
    members: {
      cache: new Map([
        [
          "m1",
          {
            user: { bot: false },
            voice: { channelId: "voice-2" }
          }
        ],
        [
          "m2",
          {
            user: { bot: false },
            voice: { channelId: "voice-x" }
          }
        ]
      ])
    }
  });

  const fallback = manager.countHumanVoiceParticipants(
    createSession({
      guildId: "guild-2",
      voiceChannelId: "voice-2"
    })
  );
  assert.equal(fallback, 1);
});

test("buildVoiceDecisionMemoryContext returns formatted hints and logs failures", async () => {
  let decisionMemoryCall = null;
  const successMemory = {
    async buildPromptMemorySlice(payload) {
      decisionMemoryCall = payload;
      return {
        userFacts: [
          {
            fact: "prefers quick answers"
          }
        ],
        relevantFacts: [
          {
            fact: "asked about launch windows"
          }
        ]
      };
    }
  };
  const success = createManager({
    memory: successMemory
  });
  const ctx = await success.manager.buildVoiceDecisionMemoryContext({
    session: createSession(),
    settings: {
      memory: {
        enabled: true
      }
    },
    userId: "user-1",
    transcript: "what is the launch window?",
    source: "voice_turn"
  });
  assert.equal(typeof ctx, "string");
  assert.equal(ctx.length > 0, true);
  assert.equal(String(decisionMemoryCall?.channelId || ""), "chan-1");

  const failing = createManager({
    memory: {
      async buildPromptMemorySlice() {
        throw new Error("memory service down");
      }
    }
  });
  const failedCtx = await failing.manager.buildVoiceDecisionMemoryContext({
    session: createSession(),
    settings: {
      memory: {
        enabled: true
      }
    },
    userId: "user-1",
    transcript: "hello",
    source: "voice_turn"
  });
  assert.equal(failedCtx, "");
  assert.equal(failing.logs.some((entry) => String(entry.content).includes("voice_reply_decision_memory_failed")), true);
});

test("buildOpenAiRealtimeMemorySlice handles build errors safely", async () => {
  const { manager, logs } = createManager({
    memory: {
      async buildPromptMemorySlice() {
        throw new Error("slice failed");
      }
    }
  });
  manager.resolveVoiceSpeakerName = () => "alice";

  const result = await manager.buildOpenAiRealtimeMemorySlice({
    session: createSession(),
    settings: {
      memory: {
        enabled: true
      }
    },
    userId: "user-1",
    transcript: "check this",
    captureReason: "stream_end"
  });

  assert.deepEqual(result, {
    userFacts: [],
    relevantFacts: []
  });
  assert.equal(logs.some((entry) => String(entry.content).includes("voice_realtime_memory_slice_failed")), true);
});
