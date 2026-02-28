import { test } from "bun:test";
import assert from "node:assert/strict";
import { VoiceSessionManager, resolveRealtimeTurnTranscriptionPlan } from "./voiceSessionManager.ts";

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
    transcript: "clanker"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "direct_address_wake_ping");
  assert.equal(decision.directAddressed, true);
  assert.equal(callCount, 0);
});

test("reply decider allows short clanker wake ping", async () => {
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
    transcript: "yo clanker"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "direct_address_wake_ping");
  assert.equal(decision.directAddressed, true);
  assert.equal(callCount, 0);
});

test("reply decider routes join-window greetings through llm with join context", async () => {
  let callCount = 0;
  const joinContextFlags = [];
  const greetings = [
    "what up",
    "what's up",
    "hola",
    "مرحبا",
    "こんにちは"
  ];
  const greetingSet = new Set(greetings.map((entry) => entry.toLowerCase()));
  const manager = createManager({
    generate: async (payload) => {
      callCount += 1;
      const prompt = String(payload?.userPrompt || "");
      joinContextFlags.push(prompt.includes("Join window active: yes."));
      const transcriptMatch = prompt.match(/Transcript:\s*"([^"]*)"/u);
      const transcript = String(transcriptMatch?.[1] || "").toLowerCase();
      return { text: greetingSet.has(transcript) ? "YES" : "NO" };
    }
  });
  const session = {
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    botTurnOpen: false,
    startedAt: Date.now() - 7_000
  };
  for (const transcript of greetings) {
    const decision = await manager.evaluateVoiceReplyDecision({
      session,
      userId: "speaker-1",
      settings: baseSettings(),
      transcript
    });

    assert.equal(decision.allow, true, transcript);
    assert.equal(decision.reason, "llm_yes", transcript);
    assert.equal(decision.directAddressed, false, transcript);
  }

  assert.equal(callCount, greetings.length);
  assert.equal(joinContextFlags.every(Boolean), true);
});

test("reply decider keeps low-signal greetings out of llm once join window is stale", async () => {
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
      startedAt: Date.now() - 90_000
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "hola"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "low_signal_fragment");
  assert.equal(decision.directAddressed, false);
  assert.equal(callCount, 0);
});

test("reply decider only treats join-window what-up greetings as llm-eligible when join window is fresh", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "NO" };
    }
  });
  for (const transcript of ["what up", "what's up"]) {
    const decision = await manager.evaluateVoiceReplyDecision({
      session: {
        guildId: "guild-1",
        textChannelId: "chan-1",
        voiceChannelId: "voice-1",
        botTurnOpen: false,
        startedAt: Date.now() - 90_000
      },
      userId: "speaker-1",
      settings: baseSettings(),
      transcript
    });

    assert.equal(decision.allow, false);
    assert.equal(decision.reason, "llm_no");
    assert.equal(decision.directAddressed, false);
  }
  assert.equal(callCount, 2);
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

test("reply decider routes wake-like variants through llm admission", async () => {
  const cases = [
    { text: "Yo, what's up, Clink?", expected: true },
    { text: "yo plink", expected: true },
    { text: "hi clunky", expected: true },
    { text: "is that u clank?", expected: true },
    { text: "is that you clinker?", expected: true },
    { text: "did i just hear a clanka?", expected: true },
    { text: "blinker conk.", expected: true },
    { text: "I love the clankers of the world", expected: true },
    { text: "clunker", expected: true },
    { text: "yo clunker", expected: true },
    { text: "yo clunker can you answer this?", expected: true },
    { text: "yo clanky can you answer this?", expected: true },
    { text: "yo clakers can you answer this?", expected: true },
    { text: "yo clankers can you answer this?", expected: true },
    { text: "i think clunker can you answer this?", expected: true },
    { text: "clankerton can you jump in?", expected: true },
    { text: "clunkeroni can you jump in?", expected: true },
    { text: "i sent you a link yesterday", expected: false },
    { text: "i pulled a prank on him!", expected: false },
    { text: "pranked ya", expected: false },
    { text: "get pranked", expected: false },
    { text: "get stanked", expected: false },
    { text: "its stinky in here", expected: false },
    { text: "Hi cleaner.", expected: false },
    { text: "cleaner can you jump in?", expected: false },
    { text: "cleaners can you jump in?", expected: false },
    { text: "the cleaner is broken again", expected: false },
    { text: "Very big step up from Paldea. Pretty excited to see what they cook up", expected: false }
  ];
  const expectedByTranscript = new Map(cases.map((row) => [row.text, row.expected]));
  let callCount = 0;
  const manager = createManager({
    generate: async (payload) => {
      const prompt = String(payload?.userPrompt || "");
      const transcriptMatch = prompt.match(/Transcript:\s*"([^"]*)"/u);
      const transcript = transcriptMatch?.[1] || "";
      const expected = expectedByTranscript.get(transcript);
      callCount += 1;
      return { text: expected ? "YES" : "NO" };
    }
  });

  for (const row of cases) {
    const decision = await manager.evaluateVoiceReplyDecision({
      session: {
        guildId: "guild-1",
        textChannelId: "chan-1",
        voiceChannelId: "voice-1",
        botTurnOpen: false,
      },
      userId: "speaker-1",
      settings: baseSettings(),
      transcript: row.text
    });

    assert.equal(decision.allow, row.expected, row.text);
    if (row.expected) {
      const reason = String(decision.reason || "");
      assert.equal(
        ["direct_address_fast_path", "direct_address_wake_ping", "llm_yes", "llm_yes_retry"].includes(reason),
        true,
        row.text
      );
      if (reason === "direct_address_fast_path" || reason === "direct_address_wake_ping") {
        assert.equal(decision.directAddressed, true, row.text);
      }
    } else {
      assert.equal(decision.directAddressed, false, row.text);
      assert.equal(decision.reason, "llm_no", row.text);
    }
  }

  assert.equal(callCount > 0, true);
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
  assert.match(seenSystemPrompt, /Treat near-phonetic or misspelled tokens that appear to target the bot name as direct address\./);
  assert.match(seenSystemPrompt, /When uncertain and the utterance is a clear question, prefer YES\./);
  assert.match(seenUserPrompt, /Treat near-phonetic or misspelled tokens that appear to target the bot name as direct address\./);
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

test("reply decider uses direct-address fast path without memory lookup", async () => {
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
    transcript: "clanker what do i usually watch?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.directAddressed, true);
  assert.equal(decision.reason, "direct_address_fast_path");
  assert.equal(memoryCallCount, 0);
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
    transcript: "what's up with this queue?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "llm_yes_retry");
  assert.equal(decision.directAddressed, false);
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
    transcript: "what's up with this queue?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "llm_yes");
  assert.equal(decision.directAddressed, false);
  assert.equal(seenSchemas.length > 0, true);
  assert.equal(seenSchemas[0].includes('"decision"'), true);
  assert.equal(seenSchemas[0].includes('"YES"'), true);
  assert.equal(seenSchemas[0].includes('"NO"'), true);
});

test("reply decider in stt pipeline uses configured voice decider provider/model", async () => {
  const seenDecisionLlmSettings = [];
  const manager = createManager({
    generate: async (payload) => {
      seenDecisionLlmSettings.push(payload?.settings?.llm || {});
      return { text: "NO" };
    }
  });

  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      mode: "stt_pipeline",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings({
      llm: {
        provider: "claude-code",
        model: "sonnet"
      },
      voice: {
        replyEagerness: 60,
        replyDecisionLlm: {
          provider: "openai",
          model: "gpt-4.1-mini",
          maxAttempts: 1
        }
      }
    }),
    transcript: "what should we do next?"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "llm_no");
  assert.equal(decision.llmProvider, "openai");
  assert.equal(decision.llmModel, "gpt-4.1-mini");
  assert.equal(seenDecisionLlmSettings.length, 1);
  assert.equal(seenDecisionLlmSettings[0]?.provider, "openai");
  assert.equal(seenDecisionLlmSettings[0]?.model, "gpt-4.1-mini");
});

test("reply decider can skip classifier call in stt pipeline when disabled", async () => {
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
      mode: "stt_pipeline",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60,
        replyDecisionLlm: {
          enabled: false,
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    transcript: "what should we do next?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "classifier_disabled_merged_with_generation");
  assert.equal(callCount, 0);
});

test("reply decider blocks ambiguous realtime turns when classifier is disabled", async () => {
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
      mode: "openai_realtime",
      botTurnOpen: false,
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60,
        replyDecisionLlm: {
          enabled: false,
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    transcript: "what should we do next?"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "classifier_disabled");
  assert.equal(callCount, 0);
});

test("reply decider bypasses LLM for direct-addressed turns", async () => {
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
    transcript: "clanker can you help with this"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "direct_address_fast_path");
  assert.equal(decision.directAddressed, true);
  assert.equal(callCount, 0);
});

test("reply decider treats merged bot-name token as direct-addressed fast path", async () => {
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
    transcript: "clankerconk can you help with this"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "direct_address_fast_path");
  assert.equal(decision.directAddressed, true);
  assert.equal(callCount, 0);
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

test("direct address stays fast-path when decider LLM is unavailable", async () => {
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
    transcript: "clanker can you explain that"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "direct_address_fast_path");
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

test("runRealtimeTurn does not forward audio when reply decision denies turn", async () => {
  const runtimeLogs = [];
  let appendedAudioCalls = 0;
  let releaseMemoryIngest = () => undefined;
  let memoryIngestCalls = 0;
  const manager = createManager({
    memory: {
      async ingestMessage() {
        memoryIngestCalls += 1;
        await new Promise((resolve) => {
          releaseMemoryIngest = resolve;
        });
      }
    }
  });
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.llm.isAsrReady = () => true;
  manager.llm.transcribeAudio = async () => ({ text: "side chatter" });
  manager.transcribePcmTurn = async () => "side chatter";
  manager.evaluateVoiceReplyDecision = async () => ({
    allow: false,
    reason: "llm_no",
    participantCount: 2,
    directAddressed: false,
    transcript: "side chatter"
  });

  const session = {
    id: "session-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "voice_agent",
    ending: false,
    pendingRealtimeInputBytes: 0,
    settingsSnapshot: baseSettings({
      memory: {
        enabled: true
      }
    }),
    realtimeClient: {
      appendInputAudioPcm() {
        appendedAudioCalls += 1;
      }
    }
  };

  const turnRun = manager.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([1, 2, 3, 4]),
    captureReason: "stream_end"
  });
  const runOutcome = await Promise.race([
    turnRun.then(() => "done"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 80))
  ]);

  assert.equal(runOutcome, "done");
  releaseMemoryIngest();
  assert.equal(appendedAudioCalls, 0);
  const addressingLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "voice_turn_addressing"
  );
  assert.equal(Boolean(addressingLog), true);
  assert.equal(Boolean(addressingLog?.metadata?.allow), false);
  assert.equal(addressingLog?.metadata?.reason, "llm_no");
  assert.equal(memoryIngestCalls, 1);
});

test("runRealtimeTurn queues direct-addressed bot-turn-open turns for deferred flush", async () => {
  const runtimeLogs = [];
  const deferredTurns = [];
  let appendedAudioCalls = 0;
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.queueDeferredBotTurnOpenTurn = (payload) => {
    deferredTurns.push(payload);
  };
  manager.evaluateVoiceReplyDecision = async () => ({
    allow: false,
    reason: "bot_turn_open",
    participantCount: 2,
    directAddressed: true,
    transcript: "clanker are you there"
  });

  const session = {
    id: "session-defer-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    pendingRealtimeInputBytes: 0,
    realtimeClient: {
      appendInputAudioPcm() {
        appendedAudioCalls += 1;
      }
    },
    settingsSnapshot: baseSettings()
  };

  await manager.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([1, 2, 3, 4]),
    captureReason: "stream_end"
  });

  assert.equal(appendedAudioCalls, 0);
  assert.equal(deferredTurns.length, 1);
  assert.equal(deferredTurns[0]?.session, session);
  assert.equal(Boolean(deferredTurns[0]?.directAddressed), true);
  const addressingLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "voice_turn_addressing"
  );
  assert.equal(Boolean(addressingLog), true);
  assert.equal(Boolean(addressingLog?.metadata?.allow), false);
  assert.equal(addressingLog?.metadata?.reason, "bot_turn_open");
  assert.equal(Boolean(addressingLog?.metadata?.directAddressed), true);
});

test("runRealtimeTurn queues non-direct bot-turn-open turns for deferred flush", async () => {
  const deferredTurns = [];
  const manager = createManager();
  manager.queueDeferredBotTurnOpenTurn = (payload) => {
    deferredTurns.push(payload);
  };
  manager.evaluateVoiceReplyDecision = async () => ({
    allow: false,
    reason: "bot_turn_open",
    participantCount: 2,
    directAddressed: false,
    transcript: "hold up, one sec"
  });

  const session = {
    id: "session-defer-2",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    pendingRealtimeInputBytes: 0,
    realtimeClient: {
      appendInputAudioPcm() {}
    },
    settingsSnapshot: baseSettings()
  };

  await manager.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([8, 9, 10, 11]),
    captureReason: "stream_end"
  });

  assert.equal(deferredTurns.length, 1);
  assert.equal(Boolean(deferredTurns[0]?.directAddressed), false);
});

test("queueRealtimeTurn keeps a bounded FIFO backlog while realtime drain is active", () => {
  const runtimeLogs = [];
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  const session = {
    id: "session-queue-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    realtimeTurnDrainActive: true,
    pendingRealtimeTurns: []
  };

  manager.queueRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([1]),
    captureReason: "r1"
  });
  manager.queueRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([2]),
    captureReason: "r2"
  });
  manager.queueRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([3]),
    captureReason: "r3"
  });
  manager.queueRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([4]),
    captureReason: "r4"
  });

  assert.deepEqual(
    session.pendingRealtimeTurns.map((turn) => turn.captureReason),
    ["r2", "r3", "r4"]
  );
  const supersededLogs = runtimeLogs.filter(
    (row) => row?.kind === "voice_runtime" && row?.content === "realtime_turn_superseded"
  );
  assert.equal(supersededLogs.length, 1);
  assert.equal(supersededLogs[0]?.metadata?.replacedCaptureReason, "r1");
  assert.equal(supersededLogs[0]?.metadata?.maxQueueDepth, 3);
});

test("queueRealtimeTurn coalesces adjacent queued turns from the same speaker", () => {
  const manager = createManager();
  const session = {
    id: "session-queue-coalesce-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    realtimeTurnDrainActive: true,
    pendingRealtimeTurns: []
  };

  manager.queueRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([1, 2, 3]),
    captureReason: "speaking_end"
  });
  manager.queueRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([4, 5]),
    captureReason: "speaking_end"
  });

  assert.equal(session.pendingRealtimeTurns.length, 1);
  assert.equal(Buffer.isBuffer(session.pendingRealtimeTurns[0]?.pcmBuffer), true);
  assert.equal(session.pendingRealtimeTurns[0]?.pcmBuffer.equals(Buffer.from([1, 2, 3, 4, 5])), true);
});

test("runRealtimeTurn skips stale queued turns when newer backlog exists", async () => {
  let transcribeCalls = 0;
  let decisionCalls = 0;
  const runtimeLogs = [];
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.transcribePcmTurn = async () => {
    transcribeCalls += 1;
    return "hello there";
  };
  manager.evaluateVoiceReplyDecision = async () => {
    decisionCalls += 1;
    return {
      allow: true,
      reason: "llm_yes",
      participantCount: 2,
      directAddressed: false,
      transcript: "hello there"
    };
  };

  const session = {
    id: "session-stale-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    pendingRealtimeInputBytes: 0,
    pendingRealtimeTurns: [{ queuedAt: Date.now(), pcmBuffer: Buffer.from([9, 9]), captureReason: "speaking_end" }],
    realtimeClient: {
      appendInputAudioPcm() {}
    },
    settingsSnapshot: baseSettings()
  };

  await manager.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([1, 2, 3, 4]),
    captureReason: "speaking_end",
    queuedAt: Date.now() - 5_000
  });

  assert.equal(transcribeCalls, 0);
  assert.equal(decisionCalls, 0);
  const staleSkipLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "realtime_turn_skipped_stale"
  );
  assert.equal(Boolean(staleSkipLog), true);
});

test("runRealtimeTurn forwards audio and prepares openai context when reply decision allows turn", async () => {
  let appendedAudioCalls = 0;
  let preparedContextCalls = 0;
  let scheduledResponseCalls = 0;
  const manager = createManager();
  manager.evaluateVoiceReplyDecision = async () => ({
    allow: true,
    reason: "llm_yes",
    participantCount: 2,
    directAddressed: false,
    transcript: "tell me more"
  });
  manager.prepareOpenAiRealtimeTurnContext = async () => {
    preparedContextCalls += 1;
  };
  manager.scheduleResponseFromBufferedAudio = () => {
    scheduledResponseCalls += 1;
  };

  const session = {
    id: "session-2",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    pendingRealtimeInputBytes: 0,
    realtimeClient: {
      appendInputAudioPcm() {
        appendedAudioCalls += 1;
      }
    },
    settingsSnapshot: baseSettings()
  };

  await manager.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([8, 9, 10, 11]),
    captureReason: "stream_end"
  });

  assert.equal(appendedAudioCalls, 1);
  assert.equal(preparedContextCalls, 1);
  assert.equal(scheduledResponseCalls, 1);
  assert.equal(session.pendingRealtimeInputBytes, 4);
});

test("bindRealtimeHandlers logs OpenAI realtime response.done usage cost", () => {
  const runtimeLogs = [];
  const handlerMap = new Map();
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };

  const session = {
    id: "session-realtime-cost-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    pendingResponse: null,
    responseDoneGraceTimer: null,
    settingsSnapshot: baseSettings({
      voice: {
        replyEagerness: 60,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        },
        openaiRealtime: {
          model: "gpt-realtime-mini"
        }
      }
    }),
    realtimeClient: {
      sessionConfig: {
        model: "gpt-realtime-mini"
      },
      on(eventName, handler) {
        handlerMap.set(eventName, handler);
      },
      off(eventName, handler) {
        if (handlerMap.get(eventName) === handler) {
          handlerMap.delete(eventName);
        }
      }
    },
    cleanupHandlers: []
  };

  manager.bindRealtimeHandlers(session, session.settingsSnapshot);

  const onResponseDone = handlerMap.get("response_done");
  assert.equal(typeof onResponseDone, "function");
  onResponseDone({
    type: "response.done",
    response: {
      id: "resp_001",
      status: "completed",
      model: "gpt-realtime-mini",
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        total_tokens: 1500,
        input_token_details: {
          cached_tokens: 100,
          audio_tokens: 700,
          text_tokens: 300
        },
        output_token_details: {
          audio_tokens: 350,
          text_tokens: 150
        }
      }
    }
  });

  assert.equal(runtimeLogs.length, 1);
  assert.equal(runtimeLogs[0]?.kind, "voice_runtime");
  assert.equal(runtimeLogs[0]?.content, "openai_realtime_response_done");
  assert.equal(runtimeLogs[0]?.usdCost, 0.001806);
  assert.equal(runtimeLogs[0]?.metadata?.responseModel, "gpt-realtime-mini");
  assert.deepEqual(runtimeLogs[0]?.metadata?.responseUsage, {
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1500,
    cacheReadTokens: 100,
    inputAudioTokens: 700,
    inputTextTokens: 300,
    outputAudioTokens: 350,
    outputTextTokens: 150
  });
});

test("runSttPipelineTurn exits before generation when turn admission denies speaking", async () => {
  const runtimeLogs = [];
  let generateVoiceTurnCalls = 0;
  let releaseMemoryIngest = () => undefined;
  let memoryIngestCalls = 0;
  const manager = createManager({
    memory: {
      async ingestMessage() {
        memoryIngestCalls += 1;
        await new Promise((resolve) => {
          releaseMemoryIngest = resolve;
        });
      }
    }
  });
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.llm.transcribeAudio = async () => ({ text: "any update?" });
  manager.llm.synthesizeSpeech = async () => ({ audioBuffer: Buffer.from([1, 2, 3]) });
  manager.transcribePcmTurn = async () => "any update?";
  manager.evaluateVoiceReplyDecision = async () => ({
    allow: false,
    reason: "llm_no",
    participantCount: 2,
    directAddressed: false,
    transcript: "any update?"
  });
  manager.generateVoiceTurn = async () => {
    generateVoiceTurnCalls += 1;
    return { text: "should not run" };
  };
  manager.touchActivity = () => {};

  const session = {
    id: "session-3",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "stt_pipeline",
    ending: false,
    sttContextMessages: [],
    settingsSnapshot: baseSettings({
      memory: {
        enabled: true
      }
    })
  };

  const turnRun = manager.runSttPipelineTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([4, 5, 6, 7]),
    captureReason: "stream_end"
  });
  const runOutcome = await Promise.race([
    turnRun.then(() => "done"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 80))
  ]);

  assert.equal(runOutcome, "done");
  releaseMemoryIngest();
  assert.equal(generateVoiceTurnCalls, 0);
  assert.equal(memoryIngestCalls, 1);
  const addressingLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "voice_turn_addressing"
  );
  assert.equal(Boolean(addressingLog), true);
  assert.equal(Boolean(addressingLog?.metadata?.allow), false);
  assert.equal(addressingLog?.metadata?.reason, "llm_no");
});

test("runSttPipelineTurn queues bot-turn-open transcripts for deferred flush", async () => {
  const queuedTurns = [];
  let runSttPipelineReplyCalls = 0;
  const manager = createManager();
  manager.llm.transcribeAudio = async () => ({ text: "clanker wait for this point" });
  manager.llm.synthesizeSpeech = async () => ({ audioBuffer: Buffer.from([1, 2, 3]) });
  manager.transcribePcmTurn = async () => "clanker wait for this point";
  manager.evaluateVoiceReplyDecision = async () => ({
    allow: false,
    reason: "bot_turn_open",
    participantCount: 2,
    directAddressed: true,
    transcript: "clanker wait for this point"
  });
  manager.queueDeferredBotTurnOpenTurn = (payload) => {
    queuedTurns.push(payload);
  };
  manager.runSttPipelineReply = async () => {
    runSttPipelineReplyCalls += 1;
  };
  manager.touchActivity = () => {};

  const session = {
    id: "session-stt-defer-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "stt_pipeline",
    ending: false,
    sttContextMessages: [],
    settingsSnapshot: baseSettings()
  };

  await manager.runSttPipelineTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([4, 5, 6, 7]),
    captureReason: "stream_end"
  });

  assert.equal(runSttPipelineReplyCalls, 0);
  assert.equal(queuedTurns.length, 1);
  assert.equal(queuedTurns[0]?.source, "stt_pipeline");
  assert.equal(queuedTurns[0]?.transcript, "clanker wait for this point");
});

test("flushDeferredBotTurnOpenTurns waits for silence before admission", async () => {
  let decisionCalls = 0;
  let scheduledFlushCalls = 0;
  const manager = createManager();
  manager.scheduleDeferredBotTurnOpenFlush = () => {
    scheduledFlushCalls += 1;
  };
  manager.evaluateVoiceReplyDecision = async () => {
    decisionCalls += 1;
    return {
      allow: false,
      reason: "llm_no",
      participantCount: 2,
      directAddressed: false,
      transcript: "ignored"
    };
  };
  const session = {
    id: "session-stt-defer-2",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "stt_pipeline",
    ending: false,
    botTurnOpen: false,
    userCaptures: new Map([["speaker-1", {}]]),
    pendingDeferredTurns: [
      {
        userId: "speaker-1",
        transcript: "clanker what about this",
        pcmBuffer: null,
        captureReason: "speaking_end",
        source: "stt_pipeline",
        directAddressed: true,
        queuedAt: Date.now()
      }
    ]
  };

  await manager.flushDeferredBotTurnOpenTurns({ session });

  assert.equal(decisionCalls, 0);
  assert.equal(scheduledFlushCalls, 1);
  assert.equal(session.pendingDeferredTurns.length, 1);
});

test("flushDeferredBotTurnOpenTurns coalesces deferred transcripts into one admission", async () => {
  const decisionPayloads = [];
  const replyPayloads = [];
  const manager = createManager();
  manager.evaluateVoiceReplyDecision = async (payload) => {
    decisionPayloads.push(payload);
    return {
      allow: true,
      reason: "llm_yes",
      participantCount: 2,
      directAddressed: true,
      transcript: payload.transcript
    };
  };
  manager.runSttPipelineReply = async (payload) => {
    replyPayloads.push(payload);
  };
  const session = {
    id: "session-stt-defer-3",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "stt_pipeline",
    ending: false,
    botTurnOpen: false,
    userCaptures: new Map(),
    settingsSnapshot: baseSettings(),
    pendingDeferredTurns: [
      {
        userId: "speaker-1",
        transcript: "clanker hold on",
        pcmBuffer: null,
        captureReason: "speaking_end",
        source: "stt_pipeline",
        directAddressed: true,
        queuedAt: Date.now() - 20
      },
      {
        userId: "speaker-2",
        transcript: "what about the rust panic trace",
        pcmBuffer: null,
        captureReason: "speaking_end",
        source: "stt_pipeline",
        directAddressed: false,
        queuedAt: Date.now()
      }
    ]
  };

  await manager.flushDeferredBotTurnOpenTurns({ session });

  assert.equal(decisionPayloads.length, 1);
  assert.equal(
    decisionPayloads[0]?.transcript,
    "clanker hold on what about the rust panic trace"
  );
  assert.equal(replyPayloads.length, 1);
  assert.equal(
    replyPayloads[0]?.transcript,
    "clanker hold on what about the rust panic trace"
  );
  assert.equal(session.pendingDeferredTurns.length, 0);
});

test("flushDeferredBotTurnOpenTurns forwards coalesced realtime audio after one admission", async () => {
  const decisionPayloads = [];
  const forwardedPayloads = [];
  const manager = createManager();
  manager.evaluateVoiceReplyDecision = async (payload) => {
    decisionPayloads.push(payload);
    return {
      allow: true,
      reason: "llm_yes",
      participantCount: 2,
      directAddressed: false,
      transcript: payload.transcript
    };
  };
  manager.forwardRealtimeTurnAudio = async (payload) => {
    forwardedPayloads.push(payload);
  };
  const session = {
    id: "session-realtime-defer-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    botTurnOpen: false,
    userCaptures: new Map(),
    settingsSnapshot: baseSettings(),
    pendingDeferredTurns: [
      {
        userId: "speaker-1",
        transcript: "clanker hold up",
        pcmBuffer: Buffer.from([1, 2]),
        captureReason: "speaking_end",
        source: "realtime",
        directAddressed: true,
        queuedAt: Date.now() - 30
      },
      {
        userId: "speaker-2",
        transcript: "add this too",
        pcmBuffer: Buffer.from([3, 4, 5]),
        captureReason: "speaking_end",
        source: "realtime",
        directAddressed: false,
        queuedAt: Date.now()
      }
    ]
  };

  await manager.flushDeferredBotTurnOpenTurns({ session });

  assert.equal(decisionPayloads.length, 1);
  assert.equal(decisionPayloads[0]?.transcript, "clanker hold up add this too");
  assert.equal(forwardedPayloads.length, 1);
  assert.equal(forwardedPayloads[0]?.captureReason, "bot_turn_open_deferred_flush");
  assert.equal(forwardedPayloads[0]?.transcript, "clanker hold up add this too");
  assert.equal(Buffer.isBuffer(forwardedPayloads[0]?.pcmBuffer), true);
  assert.equal(forwardedPayloads[0]?.pcmBuffer.equals(Buffer.from([1, 2, 3, 4, 5])), true);
  assert.equal(session.pendingDeferredTurns.length, 0);
});
