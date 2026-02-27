import test from "node:test";
import assert from "node:assert/strict";
import { VoiceSessionManager } from "./voice/voiceSessionManager.ts";

function createManager({
  participantCount = 2,
  generate = async () => ({ text: "NO" })
} = {}) {
  const fakeClient = {
    on() {},
    off() {},
    guilds: { cache: new Map() },
    users: { cache: new Map() },
    user: { id: "bot-user", username: "clanker conk" }
  };
  const fakeStore = {
    logAction() {},
    getSettings() {
      return {
        botName: "clanker conk"
      };
    }
  };
  const manager = new VoiceSessionManager({
    client: fakeClient,
    store: fakeStore,
    appConfig: {},
    llm: {
      generate
    }
  });
  manager.countHumanVoiceParticipants = () => participantCount;
  return manager;
}

function baseSettings(overrides = {}) {
  return {
    botName: "clanker conk",
    memory: {
      enabled: false
    },
    llm: {
      provider: "openai",
      model: "gpt-4.1-mini"
    },
    voice: {
      replyEagerness: 60,
      eagerCooldownSeconds: 45,
      replyDecisionLlm: {
        provider: "anthropic",
        model: "claude-haiku-4-5"
      }
    },
    ...overrides
  };
}

test("reply decider blocks turns when transcript is missing", async () => {
  const manager = createManager();
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false,
      lastUnaddressedReplyAt: 0
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: ""
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "missing_transcript");
});

test("reply decider blocks unaddressed turns when eagerness is disabled", async () => {
  const manager = createManager();
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false,
      lastUnaddressedReplyAt: 0
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 0,
        eagerCooldownSeconds: 45,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    transcript: "what do you think about this"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "eagerness_disabled_without_direct_address");
});

test("reply decider allows unaddressed turn when model says YES", async () => {
  const manager = createManager({
    generate: async () => ({ text: "YES" })
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false,
      lastUnaddressedReplyAt: 0
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "that reminds me of yesterday, what happened again?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "llm_yes");
  assert.equal(decision.directAddressed, false);
});

test("reply decider retries contract violation output and accepts YES", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      if (callCount === 1) return { text: "Let me check my memory files first." };
      return { text: "YES" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false,
      lastUnaddressedReplyAt: 0
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "clanky what's up?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "llm_yes_retry");
  assert.equal(decision.directAddressed, true);
  assert.equal(callCount, 2);
});

test("reply decider uses JSON schema contract for claude-code and accepts structured YES", async () => {
  const seenSchemas = [];
  const manager = createManager({
    generate: async (payload) => {
      seenSchemas.push(String(payload?.jsonSchema || ""));
      return { text: '{"decision":"YES"}', provider: "claude-code", model: "haiku" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false,
      lastUnaddressedReplyAt: 0
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60,
        eagerCooldownSeconds: 45,
        replyDecisionLlm: {
          provider: "claude-code",
          model: "haiku"
        }
      }
    }),
    transcript: "clanky what's up?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "llm_yes");
  assert.equal(decision.directAddressed, true);
  assert.equal(seenSchemas.length > 0, true);
  assert.equal(seenSchemas[0].includes('"decision"'), true);
  assert.equal(seenSchemas[0].includes('"YES"'), true);
  assert.equal(seenSchemas[0].includes('"NO"'), true);
});

test("reply decider blocks contract violations after bounded retries", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "maybe later" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false,
      lastUnaddressedReplyAt: 0
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "clanky what's up?"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "llm_contract_violation");
  assert.equal(decision.directAddressed, true);
  assert.equal(callCount, 3);
});

test("reply decider respects cooldown for unaddressed turns", async () => {
  const manager = createManager({
    generate: async () => ({ text: "YES" })
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false,
      lastUnaddressedReplyAt: Date.now()
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "can you jump in on this"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "unaddressed_cooldown");
});

test("direct address falls back to allow when decider LLM is unavailable", async () => {
  const fakeClient = {
    on() {},
    off() {},
    guilds: { cache: new Map() },
    users: { cache: new Map() },
    user: { id: "bot-user", username: "clanker conk" }
  };
  const fakeStore = {
    logAction() {},
    getSettings() {
      return { botName: "clanker conk" };
    }
  };
  const manager = new VoiceSessionManager({
    client: fakeClient,
    store: fakeStore,
    appConfig: {},
    llm: {}
  });
  manager.countHumanVoiceParticipants = () => 3;

  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false,
      lastUnaddressedReplyAt: 0
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "clanky can you explain that"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "direct_address_no_decider");
  assert.equal(decision.directAddressed, true);
});
