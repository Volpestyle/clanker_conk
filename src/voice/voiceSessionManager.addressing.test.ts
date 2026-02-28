import { test } from "bun:test";
import assert from "node:assert/strict";
import { VoiceSessionManager, resolveRealtimeTurnTranscriptionPlan } from "./voiceSessionManager.ts";
import { STT_TURN_QUEUE_MAX, VOICE_TURN_MIN_ASR_CLIP_MS } from "./voiceSessionManager.constants.ts";

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
      model: "claude-haiku-4-5"
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

test("reply decider uses configured advanced classifier system prompt override", async () => {
  const seenSystemPrompts = [];
  const manager = createManager({
    generate: async (payload) => {
      seenSystemPrompts.push(String(payload?.systemPrompt || ""));
      return { text: "NO" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "guild-1",
      textChannelId: "chan-1",
      voiceChannelId: "voice-1",
      botTurnOpen: false
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5",
          maxAttempts: 1,
          prompts: {
            wakeVariantHint: "custom wake hint for {{botName}}",
            systemPromptCompact: "compact override for {{botName}}",
            systemPromptFull: "full override for {{botName}}",
            systemPromptStrict: "strict override for {{botName}}"
          }
        }
      }
    }),
    transcript: "how should we do this"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "llm_no");
  assert.equal(seenSystemPrompts.length, 1);
  assert.equal(seenSystemPrompts[0], "compact override for clanker conk");
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

test("reply decider allows same-speaker followup after recent bot reply when focus window is stale", async () => {
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
      focusedSpeakerAt: Date.now() - 60_000,
      lastAudioDeltaAt: Date.now() - 4_000
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "show them you man"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "bot_recent_reply_followup");
  assert.equal(callCount, 0);
});

test("smoke: focused speaker followup defers to llm when turn vocatively targets another participant", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "NO" };
    }
  });
  manager.getVoiceChannelParticipants = () => [{ displayName: "alice" }, { displayName: "joey" }];
  manager.resolveVoiceSpeakerName = () => "alice";
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
    transcript: "hey joey guess what game i'm playing"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "llm_no");
  assert.equal(decision.directAddressed, false);
  assert.equal(callCount, 1);
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

test("shouldPersistUserTranscriptTimelineTurn suppresses low-signal non-addressed fragments", () => {
  const manager = createManager();
  const session = {
    settingsSnapshot: baseSettings()
  };
  const keep = manager.shouldPersistUserTranscriptTimelineTurn({
    session,
    settings: session.settingsSnapshot,
    transcript: "Przyjaciele"
  });
  assert.equal(keep, false);
});

test("shouldPersistUserTranscriptTimelineTurn keeps low-signal direct wake-word turns", () => {
  const manager = createManager();
  const session = {
    settingsSnapshot: baseSettings()
  };
  const keep = manager.shouldPersistUserTranscriptTimelineTurn({
    session,
    settings: session.settingsSnapshot,
    transcript: "yo clanker"
  });
  assert.equal(keep, true);
});

test("reply decider routes join-window greetings through llm with join context", async () => {
  let callCount = 0;
  const joinContextFlags = [];
  const joinBiasFlags = [];
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
      joinBiasFlags.push(
        prompt.includes(
          "Join-window bias rule: if Join window active is yes and this turn is a short greeting/check-in, default to YES unless another human target is explicit."
        )
      );
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
  assert.equal(joinBiasFlags.every(Boolean), true);
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

test("formatVoiceDecisionHistory keeps newest turns within total char budget", () => {
  const manager = createManager();
  const session = {
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    botTurnOpen: false,
    settingsSnapshot: baseSettings(),
    recentVoiceTurns: Array.from({ length: 6 }, (_row, index) => ({
      role: "user",
      userId: `speaker-${index + 1}`,
      speakerName: `speaker-${index + 1}`,
      text: `turn-${index + 1} ${"x".repeat(220)}`,
      at: Date.now() - (6 - index) * 500
    }))
  };

  const history = manager.formatVoiceDecisionHistory(session, 6, 460);
  assert.equal(history.length <= 460, true);
  assert.equal(history.includes("turn-6"), true);
  assert.equal(history.includes("turn-1"), false);
  assert.equal(history.split("\n").filter(Boolean).length <= 6, true);
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

test("reply decider retries hard failures and accepts YES", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("temporary classifier provider error");
      }
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
      startedAt: Date.now() - 5_000,
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
          model: "claude-haiku-4-5",
          maxAttempts: 1
        }
      }
    }),
    transcript: "hola"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "llm_no");
  assert.equal(decision.llmProvider, "openai");
  assert.equal(decision.llmModel, "claude-haiku-4-5");
  assert.equal(seenDecisionLlmSettings.length, 1);
  assert.equal(seenDecisionLlmSettings[0]?.provider, "openai");
  assert.equal(seenDecisionLlmSettings[0]?.model, "claude-haiku-4-5");
  assert.equal(seenDecisionLlmSettings[0]?.maxOutputTokens, 2);
});

test("reply decider uses higher max output tokens for openai gpt-5 models", async () => {
  const seenDecisionLlmSettings = [];
  const manager = createManager({
    generate: async (payload) => {
      seenDecisionLlmSettings.push(payload?.settings?.llm || {});
      return { text: "YES", provider: "openai", model: "gpt-5-mini" };
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
          model: "gpt-5-mini",
          maxAttempts: 1
        }
      }
    }),
    transcript: "what should we do next?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "llm_yes");
  assert.equal(seenDecisionLlmSettings.length, 1);
  assert.equal(seenDecisionLlmSettings[0]?.provider, "openai");
  assert.equal(seenDecisionLlmSettings[0]?.model, "gpt-5-mini");
  assert.equal(seenDecisionLlmSettings[0]?.maxOutputTokens, 64);
  assert.equal(seenDecisionLlmSettings[0]?.reasoningEffort, "minimal");
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

test("reply decider can skip classifier call in realtime brain mode when disabled", async () => {
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

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "classifier_disabled_merged_with_generation");
  assert.equal(callCount, 0);
});

test("reply decider blocks ambiguous realtime native turns when classifier is disabled", async () => {
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
        realtimeReplyStrategy: "native",
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

test("reply decider blocks contract violations without retrying", async () => {
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

test("runRealtimeTurn in voice_agent retries full ASR model after empty mini transcript", async () => {
  const runtimeLogs = [];
  const attemptedModels = [];
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.llm.isAsrReady = () => true;
  manager.llm.transcribeAudio = async () => ({ text: "unused" });
  manager.transcribePcmTurn = async ({ model }) => {
    attemptedModels.push(String(model || ""));
    if (model === "gpt-4o-mini-transcribe") return "";
    return "fallback transcript";
  };
  manager.evaluateVoiceReplyDecision = async ({ transcript }) => ({
    allow: false,
    reason: "llm_no",
    participantCount: 2,
    directAddressed: false,
    transcript
  });

  const session = {
    id: "session-voice-agent-fallback-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "voice_agent",
    ending: false,
    pendingRealtimeInputBytes: 0,
    realtimeInputSampleRateHz: 24000,
    realtimeClient: {
      appendInputAudioPcm() {}
    },
    settingsSnapshot: baseSettings()
  };

  await manager.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.alloc(96_000, 1),
    captureReason: "stream_end"
  });

  assert.deepEqual(attemptedModels, ["gpt-4o-mini-transcribe", "gpt-4o-transcribe"]);
  const addressingLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "voice_turn_addressing"
  );
  assert.equal(Boolean(addressingLog), true);
  assert.equal(addressingLog?.metadata?.transcriptionModelFallback, "gpt-4o-transcribe");
  assert.equal(addressingLog?.metadata?.transcriptionPlanReason, "mini_with_full_fallback_runtime");
  assert.equal(addressingLog?.metadata?.transcript, "fallback transcript");
});

test("runRealtimeTurn skips ASR on very short speaking_end clips", async () => {
  const runtimeLogs = [];
  let transcribeCalls = 0;
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.llm.isAsrReady = () => true;
  manager.llm.transcribeAudio = async () => ({ text: "unused" });
  manager.transcribePcmTurn = async () => {
    transcribeCalls += 1;
    return "should-not-happen";
  };
  manager.evaluateVoiceReplyDecision = async ({ transcript }) => ({
    allow: false,
    reason: transcript ? "llm_no" : "missing_transcript",
    participantCount: 2,
    directAddressed: false,
    transcript
  });

  const session = {
    id: "session-short-clip-skip-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "voice_agent",
    ending: false,
    pendingRealtimeInputBytes: 0,
    realtimeInputSampleRateHz: 24000,
    realtimeClient: {
      appendInputAudioPcm() {}
    },
    settingsSnapshot: baseSettings()
  };

  await manager.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([1, 2, 3, 4]),
    captureReason: "speaking_end"
  });

  assert.equal(transcribeCalls, 0);
  assert.equal(
    runtimeLogs.some(
      (row) => row?.kind === "voice_runtime" && row?.content === "realtime_turn_transcription_skipped_short_clip"
    ),
    true
  );
  const addressingLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "voice_turn_addressing"
  );
  assert.equal(Boolean(addressingLog), true);
  assert.equal(addressingLog?.metadata?.asrSkippedShortClip, true);
});

test("runRealtimeTurn transcribes speaking_end clips above minimum duration threshold", async () => {
  const runtimeLogs = [];
  let transcribeCalls = 0;
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.llm.isAsrReady = () => true;
  manager.llm.transcribeAudio = async () => ({ text: "unused" });
  manager.transcribePcmTurn = async () => {
    transcribeCalls += 1;
    return "yo";
  };
  manager.evaluateVoiceReplyDecision = async ({ transcript }) => ({
    allow: false,
    reason: transcript ? "llm_no" : "missing_transcript",
    participantCount: 2,
    directAddressed: false,
    transcript
  });

  const session = {
    id: "session-short-clip-strong-signal-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "voice_agent",
    ending: false,
    pendingRealtimeInputBytes: 0,
    realtimeInputSampleRateHz: 24000,
    realtimeClient: {
      appendInputAudioPcm() {}
    },
    settingsSnapshot: baseSettings()
  };

  const sampleRateHz = 24000;
  const minAsrClipBytes = Math.max(
    2,
    Math.ceil(((VOICE_TURN_MIN_ASR_CLIP_MS / 1000) * sampleRateHz * 2))
  );
  const aboveThresholdClip = Buffer.alloc(minAsrClipBytes + 2, 10);

  await manager.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: aboveThresholdClip,
    captureReason: "speaking_end"
  });

  assert.equal(transcribeCalls, 1);
  assert.equal(
    runtimeLogs.some(
      (row) => row?.kind === "voice_runtime" && row?.content === "realtime_turn_transcription_skipped_short_clip"
    ),
    false
  );
  const addressingLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "voice_turn_addressing"
  );
  assert.equal(Boolean(addressingLog), true);
  assert.equal(addressingLog?.metadata?.asrSkippedShortClip, false);
  assert.equal(addressingLog?.metadata?.transcript, "yo");
});

test("runRealtimeTurn drops near-silent clips before ASR", async () => {
  const runtimeLogs = [];
  let transcribeCalls = 0;
  let decisionCalls = 0;
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.llm.isAsrReady = () => true;
  manager.llm.transcribeAudio = async () => ({ text: "unused" });
  manager.transcribePcmTurn = async () => {
    transcribeCalls += 1;
    return "hello";
  };
  manager.evaluateVoiceReplyDecision = async () => {
    decisionCalls += 1;
    return {
      allow: false,
      reason: "llm_no",
      participantCount: 2,
      directAddressed: false,
      transcript: "hello"
    };
  };

  const session = {
    id: "session-silence-gate-rt-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "voice_agent",
    ending: false,
    pendingRealtimeInputBytes: 0,
    realtimeInputSampleRateHz: 24000,
    realtimeClient: {
      appendInputAudioPcm() {}
    },
    settingsSnapshot: baseSettings()
  };

  await manager.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.alloc(96_000, 0),
    captureReason: "speaking_end"
  });

  assert.equal(transcribeCalls, 0);
  assert.equal(decisionCalls, 0);
  const silenceDrop = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "voice_turn_dropped_silence_gate"
  );
  assert.equal(Boolean(silenceDrop), true);
  assert.equal(silenceDrop?.metadata?.source, "realtime");
});

test("transcribePcmTurn escalates repeated empty transcripts after configured threshold", async () => {
  const runtimeLogs = [];
  const errorLogs = [];
  const manager = createManager();
  manager.store.logAction = (row) => {
    if (row?.kind === "voice_runtime") runtimeLogs.push(row);
    if (row?.kind === "voice_error") errorLogs.push(row);
  };
  manager.llm.transcribeAudio = async () => {
    throw new Error("ASR returned empty transcript.");
  };

  const session = {
    id: "session-empty-streak-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "voice_agent",
    ending: false
  };

  for (let index = 0; index < 3; index += 1) {
    const transcript = await manager.transcribePcmTurn({
      session,
      userId: "speaker-1",
      pcmBuffer: Buffer.alloc(48_000, 1),
      model: "gpt-4o-mini-transcribe",
      sampleRateHz: 24000,
      captureReason: "speaking_end",
      traceSource: "voice_realtime_turn_decider",
      errorPrefix: "voice_realtime_transcription_failed",
      emptyTranscriptRuntimeEvent: "voice_realtime_transcription_empty",
      emptyTranscriptErrorStreakThreshold: 3
    });
    assert.equal(transcript, "");
  }

  assert.equal(
    runtimeLogs.filter((row) => row?.content === "voice_realtime_transcription_empty").length,
    2
  );
  const escalated = errorLogs.filter((row) =>
    String(row?.content || "").startsWith("voice_realtime_transcription_failed:")
  );
  assert.equal(escalated.length, 1);
  assert.equal(escalated[0]?.metadata?.emptyTranscriptStreak, 3);
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

test("queueRealtimeTurn keeps only one merged pending turn while realtime drain is active", () => {
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
    ["r4"]
  );
  assert.equal(Buffer.isBuffer(session.pendingRealtimeTurns[0]?.pcmBuffer), true);
  assert.equal(session.pendingRealtimeTurns[0]?.pcmBuffer.equals(Buffer.from([1, 2, 3, 4])), true);
  const coalescedLogs = runtimeLogs.filter(
    (row) => row?.kind === "voice_runtime" && row?.content === "realtime_turn_coalesced"
  );
  assert.equal(coalescedLogs.length > 0, true);
  assert.equal(coalescedLogs.at(-1)?.metadata?.maxQueueDepth, 1);
});

test("queueRealtimeTurn coalesces queued turns even when speaker or reason changes", () => {
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
    userId: "speaker-2",
    pcmBuffer: Buffer.from([4, 5]),
    captureReason: "idle_timeout"
  });

  assert.equal(session.pendingRealtimeTurns.length, 1);
  assert.equal(Buffer.isBuffer(session.pendingRealtimeTurns[0]?.pcmBuffer), true);
  assert.equal(session.pendingRealtimeTurns[0]?.pcmBuffer.equals(Buffer.from([1, 2, 3, 4, 5])), true);
  assert.equal(session.pendingRealtimeTurns[0]?.userId, "speaker-2");
  assert.equal(session.pendingRealtimeTurns[0]?.captureReason, "idle_timeout");
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

test("runRealtimeTurn uses brain reply generation when admission allows turn", async () => {
  const brainPayloads = [];
  const manager = createManager();
  manager.evaluateVoiceReplyDecision = async () => ({
    allow: true,
    reason: "llm_yes",
    participantCount: 2,
    directAddressed: false,
    transcript: "tell me more"
  });
  manager.runRealtimeBrainReply = async (payload) => {
    brainPayloads.push(payload);
    return true;
  };

  const session = {
    id: "session-2",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    pendingRealtimeInputBytes: 0,
    realtimeClient: {},
    settingsSnapshot: baseSettings()
  };

  await manager.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([8, 9, 10, 11]),
    captureReason: "stream_end"
  });

  assert.equal(brainPayloads.length, 1);
  assert.equal(brainPayloads[0]?.session, session);
  assert.equal(brainPayloads[0]?.transcript, "");
  assert.equal(brainPayloads[0]?.directAddressed, false);
  assert.equal(brainPayloads[0]?.source, "realtime");
});

test("smoke: runRealtimeBrainReply passes join-window context into generation", async () => {
  const generationPayloads = [];
  const manager = createManager();
  manager.resolveSoundboardCandidates = async () => ({
    candidates: []
  });
  manager.getVoiceChannelParticipants = () => [
    { userId: "speaker-1", displayName: "alice" },
    { userId: "speaker-2", displayName: "bob" }
  ];
  manager.prepareOpenAiRealtimeTurnContext = async () => {};
  manager.requestRealtimeTextUtterance = () => true;
  manager.generateVoiceTurn = async (payload) => {
    generationPayloads.push(payload);
    return {
      text: "yo what's good"
    };
  };

  const session = {
    id: "session-join-greeting-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    startedAt: Date.now() - 2_000,
    realtimeClient: {},
    recentVoiceTurns: [],
    membershipEvents: [
      {
        userId: "speaker-2",
        displayName: "bob",
        eventType: "join",
        at: Date.now() - 1_200
      }
    ],
    settingsSnapshot: baseSettings()
  };

  const result = await manager.runRealtimeBrainReply({
    session,
    settings: session.settingsSnapshot,
    userId: "speaker-1",
    transcript: "yo, what's up?",
    directAddressed: false,
    source: "realtime"
  });

  assert.equal(result, true);
  assert.equal(generationPayloads.length, 1);
  assert.equal(Boolean(generationPayloads[0]?.isEagerTurn), true);
  assert.equal(Boolean(generationPayloads[0]?.joinWindowActive), true);
  assert.equal(
    Number.isFinite(Number(generationPayloads[0]?.joinWindowAgeMs)),
    true
  );
  assert.deepEqual(
    generationPayloads[0]?.participantRoster?.map((entry) => entry?.displayName),
    ["alice", "bob"]
  );
  assert.equal(generationPayloads[0]?.recentMembershipEvents?.length, 1);
  assert.equal(generationPayloads[0]?.recentMembershipEvents?.[0]?.eventType, "join");
  assert.equal(generationPayloads[0]?.recentMembershipEvents?.[0]?.displayName, "bob");
});

test("runRealtimeBrainReply ends VC when model requests leave directive", async () => {
  const manager = createManager();
  const endCalls = [];
  manager.resolveSoundboardCandidates = async () => ({
    candidates: []
  });
  manager.getVoiceChannelParticipants = () => [{ userId: "speaker-1", displayName: "alice" }];
  manager.prepareOpenAiRealtimeTurnContext = async () => {};
  manager.requestRealtimeTextUtterance = () => true;
  manager.generateVoiceTurn = async () => ({
    text: "",
    leaveVoiceChannelRequested: true
  });
  manager.endSession = async (payload) => {
    endCalls.push(payload);
    return true;
  };

  const session = {
    id: "session-realtime-leave-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    startedAt: Date.now() - 5_000,
    maxEndsAt: Date.now() + 90_000,
    inactivityEndsAt: Date.now() + 25_000,
    realtimeClient: {},
    recentVoiceTurns: [],
    membershipEvents: [],
    settingsSnapshot: baseSettings()
  };

  const result = await manager.runRealtimeBrainReply({
    session,
    settings: session.settingsSnapshot,
    userId: "speaker-1",
    transcript: "we can wrap this up now",
    directAddressed: true,
    source: "realtime"
  });

  assert.equal(result, true);
  assert.equal(endCalls.length, 1);
  assert.equal(endCalls[0]?.reason, "assistant_leave_directive");
});

test("runRealtimeBrainReply treats engaged thread turns as non-eager even without direct address", async () => {
  const generationPayloads = [];
  const manager = createManager();
  manager.resolveSoundboardCandidates = async () => ({
    candidates: []
  });
  manager.getVoiceChannelParticipants = () => [{ userId: "speaker-1", displayName: "alice" }];
  manager.prepareOpenAiRealtimeTurnContext = async () => {};
  manager.requestRealtimeTextUtterance = () => true;
  manager.generateVoiceTurn = async (payload) => {
    generationPayloads.push(payload);
    return {
      text: "on it"
    };
  };

  const session = {
    id: "session-engaged-thread-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    startedAt: Date.now() - 28_000,
    realtimeClient: {},
    recentVoiceTurns: [],
    membershipEvents: [],
    settingsSnapshot: baseSettings()
  };

  const result = await manager.runRealtimeBrainReply({
    session,
    settings: session.settingsSnapshot,
    userId: "speaker-1",
    transcript: "open that first article",
    directAddressed: false,
    conversationContext: {
      engagementState: "engaged",
      engaged: true,
      engagedWithCurrentSpeaker: false
    },
    source: "realtime"
  });

  assert.equal(result, true);
  assert.equal(generationPayloads.length, 1);
  assert.equal(Boolean(generationPayloads[0]?.isEagerTurn), false);
});

test("runRealtimeTurn uses native realtime forwarding when strategy is native", async () => {
  const brainPayloads = [];
  const forwardedPayloads = [];
  const manager = createManager();
  manager.evaluateVoiceReplyDecision = async () => ({
    allow: true,
    reason: "llm_yes",
    participantCount: 2,
    directAddressed: false,
    transcript: "say it native"
  });
  manager.runRealtimeBrainReply = async (payload) => {
    brainPayloads.push(payload);
    return true;
  };
  manager.forwardRealtimeTurnAudio = async (payload) => {
    forwardedPayloads.push(payload);
    return true;
  };

  const session = {
    id: "session-native-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    pendingRealtimeInputBytes: 0,
    realtimeClient: {},
    settingsSnapshot: baseSettings({
      voice: {
        replyEagerness: 60,
        realtimeReplyStrategy: "native",
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    })
  };

  const pcmBuffer = Buffer.from([8, 9, 10, 11]);
  await manager.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer,
    captureReason: "stream_end"
  });

  assert.equal(brainPayloads.length, 0);
  assert.equal(forwardedPayloads.length, 1);
  assert.equal(forwardedPayloads[0]?.session, session);
  assert.equal(forwardedPayloads[0]?.pcmBuffer, pcmBuffer);
  assert.equal(forwardedPayloads[0]?.transcript, "");
});

test("runRealtimeTurn uses brain strategy when soundboard is enabled", async () => {
  const brainPayloads = [];
  const forwardedPayloads = [];
  const manager = createManager();
  manager.evaluateVoiceReplyDecision = async () => ({
    allow: true,
    reason: "llm_yes",
    participantCount: 2,
    directAddressed: false,
    transcript: "say it native"
  });
  manager.runRealtimeBrainReply = async (payload) => {
    brainPayloads.push(payload);
    return true;
  };
  manager.forwardRealtimeTurnAudio = async (payload) => {
    forwardedPayloads.push(payload);
    return true;
  };

  const session = {
    id: "session-native-soundboard-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    pendingRealtimeInputBytes: 0,
    realtimeClient: {},
    settingsSnapshot: baseSettings({
      voice: {
        replyEagerness: 60,
        realtimeReplyStrategy: "native",
        soundboard: {
          enabled: true
        },
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    })
  };

  const pcmBuffer = Buffer.from([8, 9, 10, 11]);
  await manager.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer,
    captureReason: "stream_end"
  });

  assert.equal(brainPayloads.length, 1);
  assert.equal(forwardedPayloads.length, 0);
  assert.equal(brainPayloads[0]?.session, session);
  assert.equal(brainPayloads[0]?.source, "realtime");
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

test("runSttPipelineReply triggers soundboard even when generated speech is empty", async () => {
  const manager = createManager();
  const soundboardCalls = [];
  const spokenLines = [];
  manager.llm.synthesizeSpeech = async () => ({ audioBuffer: Buffer.from([1, 2, 3]) });
  manager.resolveSoundboardCandidates = async () => ({
    source: "preferred",
    candidates: [
      {
        reference: "airhorn@123",
        soundId: "airhorn",
        sourceGuildId: "123",
        name: "airhorn"
      }
    ]
  });
  manager.generateVoiceTurn = async () => ({
    text: "",
    soundboardRef: "airhorn@123"
  });
  manager.speakVoiceLineWithTts = async (payload) => {
    spokenLines.push(payload);
    return true;
  };
  manager.maybeTriggerAssistantDirectedSoundboard = async (payload) => {
    soundboardCalls.push(payload);
  };

  const session = {
    id: "session-stt-soundboard-only-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "stt_pipeline",
    ending: false,
    recentVoiceTurns: [],
    settingsSnapshot: baseSettings({
      voice: {
        replyEagerness: 60,
        soundboard: {
          enabled: true
        }
      }
    })
  };

  await manager.runSttPipelineReply({
    session,
    settings: session.settingsSnapshot,
    userId: "speaker-1",
    transcript: "drop a sound",
    directAddressed: true
  });

  assert.equal(spokenLines.length, 0);
  assert.equal(soundboardCalls.length, 1);
  assert.equal(soundboardCalls[0]?.requestedRef, "airhorn@123");
});

test("runSttPipelineReply ends VC when model requests leave directive", async () => {
  const manager = createManager();
  const endCalls = [];
  manager.llm.synthesizeSpeech = async () => ({ audioBuffer: Buffer.from([1, 2, 3]) });
  manager.resolveSoundboardCandidates = async () => ({
    source: "preferred",
    candidates: []
  });
  manager.generateVoiceTurn = async () => ({
    text: "aight i'm heading out",
    leaveVoiceChannelRequested: true
  });
  manager.speakVoiceLineWithTts = async () => true;
  manager.endSession = async (payload) => {
    endCalls.push(payload);
    return true;
  };

  const session = {
    id: "session-stt-leave-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "stt_pipeline",
    ending: false,
    maxEndsAt: Date.now() + 80_000,
    inactivityEndsAt: Date.now() + 30_000,
    recentVoiceTurns: [],
    settingsSnapshot: baseSettings()
  };

  await manager.runSttPipelineReply({
    session,
    settings: session.settingsSnapshot,
    userId: "speaker-1",
    transcript: "anything else before we stop?",
    directAddressed: true
  });

  assert.equal(endCalls.length, 1);
  assert.equal(endCalls[0]?.reason, "assistant_leave_directive");
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

test("runSttPipelineTurn retries full ASR model after empty mini transcript", async () => {
  const runtimeLogs = [];
  const attemptedModels = [];
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.llm.transcribeAudio = async () => ({ text: "unused" });
  manager.llm.synthesizeSpeech = async () => ({ audioBuffer: Buffer.from([1, 2, 3]) });
  manager.transcribePcmTurn = async ({ model }) => {
    attemptedModels.push(String(model || ""));
    if (model === "gpt-4o-mini-transcribe") return "";
    return "fallback stt transcript";
  };
  manager.evaluateVoiceReplyDecision = async ({ transcript }) => ({
    allow: false,
    reason: "llm_no",
    participantCount: 2,
    directAddressed: false,
    transcript
  });

  const session = {
    id: "session-stt-fallback-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "stt_pipeline",
    ending: false,
    recentVoiceTurns: [],
    settingsSnapshot: baseSettings()
  };

  await manager.runSttPipelineTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.alloc(96_000, 1),
    captureReason: "stream_end"
  });

  assert.deepEqual(attemptedModels, ["gpt-4o-mini-transcribe", "gpt-4o-transcribe"]);
  const addressingLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "voice_turn_addressing"
  );
  assert.equal(Boolean(addressingLog), true);
  assert.equal(addressingLog?.metadata?.mode, "stt_pipeline");
  assert.equal(addressingLog?.metadata?.transcriptionModelFallback, "gpt-4o-transcribe");
  assert.equal(addressingLog?.metadata?.transcriptionPlanReason, "mini_with_full_fallback_runtime");
  assert.equal(addressingLog?.metadata?.transcript, "fallback stt transcript");
});

test("runSttPipelineTurn drops near-silent clips before ASR", async () => {
  const runtimeLogs = [];
  let transcribeCalls = 0;
  let decisionCalls = 0;
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.llm.transcribeAudio = async () => ({ text: "unused" });
  manager.llm.synthesizeSpeech = async () => ({ audioBuffer: Buffer.from([1, 2, 3]) });
  manager.transcribePcmTurn = async () => {
    transcribeCalls += 1;
    return "hello";
  };
  manager.evaluateVoiceReplyDecision = async () => {
    decisionCalls += 1;
    return {
      allow: false,
      reason: "llm_no",
      participantCount: 2,
      directAddressed: false,
      transcript: "hello"
    };
  };

  const session = {
    id: "session-silence-gate-stt-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "stt_pipeline",
    ending: false,
    recentVoiceTurns: [],
    settingsSnapshot: baseSettings()
  };

  await manager.runSttPipelineTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.alloc(96_000, 0),
    captureReason: "speaking_end"
  });

  assert.equal(transcribeCalls, 0);
  assert.equal(decisionCalls, 0);
  const silenceDrop = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "voice_turn_dropped_silence_gate"
  );
  assert.equal(Boolean(silenceDrop), true);
  assert.equal(silenceDrop?.metadata?.source, "stt_pipeline");
});

test("runSttPipelineTurn empty transcripts escalate after streak threshold", async () => {
  const runtimeLogs = [];
  const errorLogs = [];
  const manager = createManager();
  manager.store.logAction = (row) => {
    if (row?.kind === "voice_runtime") runtimeLogs.push(row);
    if (row?.kind === "voice_error") errorLogs.push(row);
  };
  manager.llm.transcribeAudio = async () => {
    throw new Error("ASR returned empty transcript.");
  };
  manager.llm.synthesizeSpeech = async () => ({ audioBuffer: Buffer.from([1, 2, 3]) });

  const session = {
    id: "session-stt-empty-streak-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "stt_pipeline",
    ending: false,
    recentVoiceTurns: [],
    settingsSnapshot: baseSettings()
  };

  for (let index = 0; index < 3; index += 1) {
    await manager.runSttPipelineTurn({
      session,
      userId: "speaker-1",
      pcmBuffer: Buffer.alloc(48_000, 1),
      captureReason: "speaking_end"
    });
  }

  assert.equal(
    runtimeLogs.filter((row) => row?.content === "voice_stt_transcription_empty").length,
    2
  );
  const escalated = errorLogs.filter((row) =>
    String(row?.content || "").startsWith("stt_pipeline_transcription_failed:")
  );
  assert.equal(escalated.length, 1);
  assert.equal(escalated[0]?.metadata?.emptyTranscriptStreak, 3);
});

test("queueSttPipelineTurn keeps a bounded FIFO backlog while a turn is running", async () => {
  const runtimeLogs = [];
  const seenCaptureReasons = [];
  let releaseFirstTurn = () => undefined;
  let firstTurnStarted = false;
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.runSttPipelineTurn = async ({ captureReason }) => {
    seenCaptureReasons.push(captureReason);
    if (!firstTurnStarted) {
      firstTurnStarted = true;
      await new Promise((resolve) => {
        releaseFirstTurn = resolve;
      });
    }
  };

  const session = {
    id: "session-stt-queue-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "stt_pipeline",
    ending: false,
    pendingSttTurns: 0,
    sttTurnDrainActive: false,
    pendingSttTurnsQueue: []
  };

  manager.queueSttPipelineTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([1, 2, 3]),
    captureReason: "first"
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const queuedCount = STT_TURN_QUEUE_MAX + 2;
  for (let index = 0; index < queuedCount; index += 1) {
    manager.queueSttPipelineTurn({
      session,
      userId: "speaker-1",
      pcmBuffer: Buffer.from([4 + index, 5 + index, 6 + index]),
      captureReason: `queued-${index + 1}`
    });
  }
  const expectedQueuedReasons = Array.from({ length: queuedCount }, (_row, index) => `queued-${index + 1}`).slice(
    -STT_TURN_QUEUE_MAX
  );

  assert.deepEqual(
    session.pendingSttTurnsQueue.map((turn) => turn.captureReason),
    expectedQueuedReasons
  );
  assert.equal(session.pendingSttTurns, 1 + STT_TURN_QUEUE_MAX);
  const supersededLogs = runtimeLogs.filter((row) => row?.content === "stt_pipeline_turn_superseded");
  assert.equal(
    supersededLogs.length,
    2
  );
  assert.equal(supersededLogs[0]?.metadata?.replacedCaptureReason, "queued-1");
  assert.equal(supersededLogs[1]?.metadata?.replacedCaptureReason, "queued-2");
  assert.equal(supersededLogs[0]?.metadata?.maxQueueDepth, STT_TURN_QUEUE_MAX);

  releaseFirstTurn();
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(seenCaptureReasons, ["first", ...expectedQueuedReasons]);
  assert.equal(session.pendingSttTurns, 0);
});

test("queueSttPipelineTurn coalesces adjacent queued STT turns from the same speaker", () => {
  const runtimeLogs = [];
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };

  const now = Date.now();
  const session = {
    id: "session-stt-coalesce-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "stt_pipeline",
    ending: false,
    pendingSttTurns: 2,
    sttTurnDrainActive: true,
    pendingSttTurnsQueue: [
      {
        session: null,
        userId: "speaker-1",
        pcmBuffer: Buffer.from([1, 2, 3]),
        captureReason: "speaking_end",
        queuedAt: now - 200
      }
    ]
  };
  session.pendingSttTurnsQueue[0].session = session;

  manager.queueSttPipelineTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([4, 5, 6, 7]),
    captureReason: "speaking_end"
  });

  assert.equal(session.pendingSttTurnsQueue.length, 1);
  assert.equal(
    session.pendingSttTurnsQueue[0]?.pcmBuffer.equals(Buffer.from([1, 2, 3, 4, 5, 6, 7])),
    true
  );
  assert.equal(
    runtimeLogs.some((row) => row?.kind === "voice_runtime" && row?.content === "stt_pipeline_turn_coalesced"),
    true
  );
});

test("runSttPipelineTurn drops stale queued turns before ASR when backlog exists", async () => {
  const runtimeLogs = [];
  let transcribeCalls = 0;
  let decisionCalls = 0;
  let runReplyCalls = 0;
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.llm.transcribeAudio = async () => ({ text: "old turn" });
  manager.llm.synthesizeSpeech = async () => ({ audioBuffer: Buffer.from([1, 2, 3]) });
  manager.transcribePcmTurn = async () => {
    transcribeCalls += 1;
    return "old turn";
  };
  manager.evaluateVoiceReplyDecision = async () => {
    decisionCalls += 1;
    return {
      allow: true,
      reason: "llm_yes",
      participantCount: 2,
      directAddressed: false,
      transcript: "old turn"
    };
  };
  manager.runSttPipelineReply = async () => {
    runReplyCalls += 1;
  };

  const session = {
    id: "session-stt-stale-backlog-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "stt_pipeline",
    ending: false,
    recentVoiceTurns: [],
    pendingSttTurnsQueue: [
      { userId: "speaker-2", pcmBuffer: Buffer.from([9]), captureReason: "speaking_end" },
      { userId: "speaker-3", pcmBuffer: Buffer.from([10]), captureReason: "speaking_end" }
    ],
    settingsSnapshot: baseSettings()
  };

  await manager.runSttPipelineTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([1, 2, 3, 4]),
    captureReason: "stream_end",
    queuedAt: Date.now() - 5_200
  });

  assert.equal(transcribeCalls, 0);
  assert.equal(decisionCalls, 0);
  assert.equal(runReplyCalls, 0);
  assert.equal(session.recentVoiceTurns.length, 0);
  const staleLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "stt_pipeline_turn_skipped_stale"
  );
  assert.equal(Boolean(staleLog), true);
  assert.equal(staleLog?.metadata?.droppedBeforeAsr, true);
});

test("runSttPipelineTurn transcribes stale queued turns for context but skips reply generation", async () => {
  const runtimeLogs = [];
  let transcribeCalls = 0;
  let decisionCalls = 0;
  let runReplyCalls = 0;
  const manager = createManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.llm.transcribeAudio = async () => ({ text: "stale context turn" });
  manager.llm.synthesizeSpeech = async () => ({ audioBuffer: Buffer.from([1, 2, 3]) });
  manager.transcribePcmTurn = async () => {
    transcribeCalls += 1;
    return "stale context turn";
  };
  manager.evaluateVoiceReplyDecision = async () => {
    decisionCalls += 1;
    return {
      allow: true,
      reason: "llm_yes",
      participantCount: 2,
      directAddressed: false,
      transcript: "stale context turn"
    };
  };
  manager.runSttPipelineReply = async () => {
    runReplyCalls += 1;
  };

  const session = {
    id: "session-stt-stale-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "stt_pipeline",
    ending: false,
    recentVoiceTurns: [],
    settingsSnapshot: baseSettings()
  };

  await manager.runSttPipelineTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([1, 2, 3, 4]),
    captureReason: "stream_end",
    queuedAt: Date.now() - 5_200
  });

  assert.equal(transcribeCalls, 1);
  assert.equal(decisionCalls, 0);
  assert.equal(runReplyCalls, 0);
  assert.equal(session.recentVoiceTurns.length, 1);
  assert.equal(session.recentVoiceTurns[0]?.role, "user");
  assert.equal(session.recentVoiceTurns[0]?.text, "stale context turn");
  assert.equal(
    runtimeLogs.some((row) => row?.kind === "voice_runtime" && row?.content === "stt_pipeline_turn_skipped_stale"),
    true
  );
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

test("flushDeferredBotTurnOpenTurns runs brain realtime reply after one admission", async () => {
  const decisionPayloads = [];
  const realtimeReplyPayloads = [];
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
  manager.runRealtimeBrainReply = async (payload) => {
    realtimeReplyPayloads.push(payload);
    return true;
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
  assert.equal(realtimeReplyPayloads.length, 1);
  assert.equal(realtimeReplyPayloads[0]?.transcript, "clanker hold up add this too");
  assert.equal(realtimeReplyPayloads[0]?.source, "bot_turn_open_deferred_flush");
  assert.equal(realtimeReplyPayloads[0]?.directAddressed, false);
  assert.equal(session.pendingDeferredTurns.length, 0);
});

test("flushDeferredBotTurnOpenTurns forwards native realtime audio after one admission", async () => {
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
    return true;
  };
  manager.runRealtimeBrainReply = async () => {
    throw new Error("should_not_use_brain_path");
  };

  const firstPcm = Buffer.from([1, 2]);
  const secondPcm = Buffer.from([3, 4, 5]);
  const session = {
    id: "session-realtime-native-defer-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    botTurnOpen: false,
    userCaptures: new Map(),
    settingsSnapshot: baseSettings({
      voice: {
        replyEagerness: 60,
        realtimeReplyStrategy: "native",
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    pendingDeferredTurns: [
      {
        userId: "speaker-1",
        transcript: "clanker hold up",
        pcmBuffer: firstPcm,
        captureReason: "speaking_end",
        source: "realtime",
        directAddressed: true,
        queuedAt: Date.now() - 30
      },
      {
        userId: "speaker-2",
        transcript: "add this too",
        pcmBuffer: secondPcm,
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
  assert.equal(forwardedPayloads[0]?.transcript, "clanker hold up add this too");
  const forwardedPcm = Buffer.isBuffer(forwardedPayloads[0]?.pcmBuffer)
    ? forwardedPayloads[0].pcmBuffer
    : Buffer.alloc(0);
  assert.deepEqual([...forwardedPcm], [...Buffer.concat([firstPcm, secondPcm])]);
  assert.equal(forwardedPayloads[0]?.captureReason, "bot_turn_open_deferred_flush");
  assert.equal(session.pendingDeferredTurns.length, 0);
});
