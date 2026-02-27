import test from "node:test";
import assert from "node:assert/strict";
import { VoiceSessionManager, resolveRealtimeTurnTranscriptionPlan } from "./voice/voiceSessionManager.ts";

function createManager({
  participantCount = 2,
  generate = async () => ({ text: "NO" }),
  memory = null
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
    },
    memory
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
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: ""
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "missing_transcript");
});

test("reply decider skips llm for low-signal unaddressed fragments", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "YES" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "yo"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "low_signal_fragment");
  assert.equal(callCount, 0);
});

test("reply decider treats multilingual question punctuation as high-signal", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "YES" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "ماذا؟"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "llm_yes");
  assert.equal(callCount, 1);
});

test("reply decider sends short three-word complaint turns to llm", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "NO" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "so much lag"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "llm_no");
  assert.equal(callCount, 1);
});

test("reply decider allows focused speaker followup without another direct address", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "NO" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false,
      focusedSpeakerUserId: "speaker-1",
      focusedSpeakerAt: Date.now()
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "what about the one before that"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "focused_speaker_followup");
  assert.equal(callCount, 0);
});

test("reply decider keeps focused speaker followup window for longer turns", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "NO" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false,
      focusedSpeakerUserId: "speaker-1",
      focusedSpeakerAt: Date.now() - 15_000
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "you still owe us the answer"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "focused_speaker_followup");
  assert.equal(callCount, 0);
});

test("reply decider blocks low-signal focused speaker followup", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "YES" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false,
      focusedSpeakerUserId: "speaker-1",
      focusedSpeakerAt: Date.now()
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "Ha!"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "low_signal_fragment");
  assert.equal(callCount, 0);
});

test("reply decider allows low-signal direct wake-word pings", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "YES" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "clunker"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "direct_address_wake_ping");
  assert.equal(decision.directAddressed, true);
  assert.equal(callCount, 0);
});

test("reply decider allows short clunker wake ping", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "YES" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "yo clunker"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "direct_address_wake_ping");
  assert.equal(decision.directAddressed, true);
  assert.equal(callCount, 0);
});

test("reply decider blocks unaddressed turns when eagerness is disabled", async () => {
  const manager = createManager();
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 0,
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
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "that reminds me of yesterday, what happened again?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "llm_yes");
  assert.equal(decision.directAddressed, false);
});

test("reply decider uses richer compact prompt guidance on first attempt", async () => {
  let seenSystemPrompt = "";
  let seenUserPrompt = "";
  const manager = createManager({
    generate: async (payload) => {
      seenSystemPrompt = String(payload?.systemPrompt || "");
      seenUserPrompt = String(payload?.userPrompt || "");
      return { text: "YES" };
    }
  });
  manager.getVoiceChannelParticipants = () => [{ displayName: "alice" }, { displayName: "bob" }];
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false,
      recentVoiceTurns: [
        { role: "user", userId: "speaker-2", speakerName: "alice", text: "can you hear me?", at: Date.now() - 1500 },
        { role: "assistant", userId: "bot-user", speakerName: "clanker conk", text: "yeah i hear you", at: Date.now() - 900 }
      ]
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "what should we do next?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "llm_yes");
  assert.match(seenSystemPrompt, /When uncertain and the utterance is a clear question, prefer YES\./);
  assert.match(seenUserPrompt, /Current speaker:/);
  assert.match(seenUserPrompt, /Known participants: alice, bob\./);
  assert.match(seenUserPrompt, /Recent turns:/);
});

test("reply decider skips memory retrieval for unaddressed turns", async () => {
  let memoryCallCount = 0;
  const manager = createManager({
    generate: async () => ({ text: "YES" }),
    memory: {
      async buildPromptMemorySlice() {
        memoryCallCount += 1;
        return {
          userFacts: [],
          relevantFacts: []
        };
      }
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings({
      memory: {
        enabled: true
      }
    }),
    transcript: "can you jump in for this topic?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.directAddressed, false);
  assert.equal(memoryCallCount, 0);
});

test("reply decider can load memory hints for direct-address turns", async () => {
  let memoryCallCount = 0;
  const manager = createManager({
    generate: async () => ({ text: "YES" }),
    memory: {
      async buildPromptMemorySlice() {
        memoryCallCount += 1;
        return {
          userFacts: [{ fact: "likes hockey", fact_type: "preference" }],
          relevantFacts: []
        };
      }
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings({
      memory: {
        enabled: true
      }
    }),
    transcript: "clanky what do i usually watch?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.directAddressed, true);
  assert.equal(memoryCallCount, 1);
});

test("reply decider still uses LLM in one-human sessions", async () => {
  let callCount = 0;
  const manager = createManager({
    participantCount: 1,
    generate: async () => {
      callCount += 1;
      return { text: "YES" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "you hear this one?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "llm_yes");
  assert.equal(decision.directAddressed, false);
  assert.equal(callCount, 1);
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
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5",
          maxAttempts: 2
        }
      }
    }),
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
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60,
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

test("reply decider fails open when direct-addressed turn gets explicit NO", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "NO", provider: "anthropic", model: "claude-haiku-4-5" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5",
          maxAttempts: 1
        }
      }
    }),
    transcript: "clanky can you help with this"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "direct_address_override_llm_no");
  assert.equal(decision.directAddressed, true);
  assert.equal(callCount, 1);
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
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5",
          maxAttempts: 3
        }
      }
    }),
    transcript: "maybe later maybe not"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "llm_contract_violation");
  assert.equal(decision.directAddressed, false);
  assert.equal(callCount, 3);
});

test("direct address fails open when decider returns contract violations", async () => {
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
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "clanky what happened"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "direct_address_contract_fallback");
  assert.equal(decision.directAddressed, true);
  assert.equal(callCount, 1);
});

test("direct address fails open when decider throws errors", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      throw new Error("decider unavailable");
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "clanky can you respond"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "direct_address_llm_error_fallback");
  assert.equal(decision.directAddressed, true);
  assert.equal(callCount, 1);
});

test("reply decider does not gate unaddressed turns behind cooldown", async () => {
  const manager = createManager({
    generate: async () => ({ text: "YES" })
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "can you jump in on this"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "llm_yes");
  assert.equal(decision.directAddressed, false);
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
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "clanky can you explain that"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "direct_address_no_decider");
  assert.equal(decision.directAddressed, true);
});

test("realtime transcription plan upgrades short mini clips to full model", () => {
  const plan = resolveRealtimeTurnTranscriptionPlan({
    mode: "openai_realtime",
    configuredModel: "gpt-4o-mini-transcribe",
    pcmByteLength: 22080,
    sampleRateHz: 24000
  });

  assert.equal(plan.primaryModel, "gpt-4o-transcribe");
  assert.equal(plan.fallbackModel, null);
  assert.equal(plan.reason, "short_clip_prefers_full_model");
});

test("realtime transcription plan keeps mini with full fallback on longer clips", () => {
  const plan = resolveRealtimeTurnTranscriptionPlan({
    mode: "openai_realtime",
    configuredModel: "gpt-4o-mini-transcribe",
    pcmByteLength: 160000,
    sampleRateHz: 24000
  });

  assert.equal(plan.primaryModel, "gpt-4o-mini-transcribe");
  assert.equal(plan.fallbackModel, "gpt-4o-transcribe");
  assert.equal(plan.reason, "mini_with_full_fallback");
});
