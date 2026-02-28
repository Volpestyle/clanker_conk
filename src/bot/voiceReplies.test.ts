import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  composeVoiceOperationalMessage,
  generateVoiceTurnReply
} from "./voiceReplies.ts";

function baseSettings(overrides = {}) {
  const base = {
    botName: "clanker conk",
    persona: {
      flavor: "casual",
      hardLimits: []
    },
    llm: {
      provider: "openai",
      model: "claude-haiku-4-5",
      temperature: 0.8,
      maxOutputTokens: 160
    },
    memory: {
      enabled: false
    },
    webSearch: {
      enabled: false
    },
    voice: {
      generationLlm: {
        provider: "openai",
        model: "claude-haiku-4-5"
      },
      soundboard: {
        enabled: false
      }
    }
  };

  return {
    ...base,
    ...overrides,
    persona: {
      ...base.persona,
      ...(overrides.persona || {})
    },
    llm: {
      ...base.llm,
      ...(overrides.llm || {})
    },
    memory: {
      ...base.memory,
      ...(overrides.memory || {})
    },
    webSearch: {
      ...base.webSearch,
      ...(overrides.webSearch || {})
    },
    voice: {
      ...base.voice,
      ...(overrides.voice || {}),
      generationLlm: {
        ...base.voice.generationLlm,
        ...(overrides.voice?.generationLlm || {})
      },
      soundboard: {
        ...base.voice.soundboard,
        ...(overrides.voice?.soundboard || {})
      }
    }
  };
}

function createVoiceBot({
  generationText = "all good",
  generationError = null,
  generationSequence = null,
  searchConfigured = true,
  recentLookupContext = [],
  screenShareCapability = {
    enabled: false,
    status: "disabled",
    publicUrl: ""
  },
  offerScreenShare = async () => ({ offered: true }),
  runWebSearch = async ({ webSearch, query }) => ({
    ...(webSearch || {}),
    requested: true,
    query: String(query || "").trim(),
    used: true,
    results: [
      {
        title: "sample result",
        url: "https://example.com",
        domain: "example.com",
        snippet: "sample",
        pageSummary: "sample summary"
      }
    ]
  })
} = {}) {
  const logs = [];
  const ingests = [];
  const remembers = [];
  const webSearchCalls = [];
  const lookupMemorySearchCalls = [];
  const lookupMemoryWrites = [];
  const screenShareCalls = [];
  const generationPayloads = [];
  let generationCalls = 0;

  const guild = {
    members: {
      cache: new Map([
        [
          "user-1",
          {
            displayName: "alice",
            user: { username: "alice_user" }
          }
        ]
      ])
    }
  };

  const bot = {
    llm: {
      async generate(payload) {
        generationCalls += 1;
        generationPayloads.push(payload);
        if (generationError) throw generationError;
        if (Array.isArray(generationSequence) && generationCalls <= generationSequence.length) {
          return {
            text: String(generationSequence[generationCalls - 1] || "")
          };
        }
        return {
          text: generationText
        };
      }
    },
    memory: {
      async ingestMessage(payload) {
        ingests.push(payload);
      },
      async rememberDirectiveLine(payload) {
        remembers.push(payload);
      }
    },
    store: {
      logAction(entry) {
        logs.push(entry);
      }
    },
    async loadRelevantMemoryFacts() {
      return [];
    },
    buildMediaMemoryFacts() {
      return [];
    },
    async loadPromptMemorySlice() {
      return {
        userFacts: [],
        relevantFacts: []
      };
    },
    loadRecentLookupContext(payload) {
      lookupMemorySearchCalls.push(payload);
      return recentLookupContext;
    },
    rememberRecentLookupContext(payload) {
      lookupMemoryWrites.push(payload);
      return true;
    },
    buildWebSearchContext(settings) {
      return {
        requested: false,
        configured: true,
        enabled: Boolean(settings?.webSearch?.enabled),
        used: false,
        blockedByBudget: false,
        optedOutByUser: false,
        error: null,
        query: "",
        results: [],
        fetchedPages: 0,
        providerUsed: null,
        providerFallbackUsed: false,
        budget: {
          canSearch: true
        }
      };
    },
    async runModelRequestedWebSearch(payload) {
      webSearchCalls.push(payload);
      return await runWebSearch(payload);
    },
    getVoiceScreenShareCapability() {
      return screenShareCapability;
    },
    async offerVoiceScreenShareLink(payload) {
      screenShareCalls.push(payload);
      return await offerScreenShare(payload);
    },
    search: {
      isConfigured() {
        return Boolean(searchConfigured);
      }
    },
    client: {
      guilds: {
        cache: new Map([["guild-1", guild]])
      },
      users: {
        cache: new Map()
      }
    }
  };

  return {
    bot,
    logs,
    ingests,
    remembers,
    webSearchCalls,
    lookupMemorySearchCalls,
    lookupMemoryWrites,
    screenShareCalls,
    generationPayloads,
    getGenerationCalls() {
      return generationCalls;
    }
  };
}

test("composeVoiceOperationalMessage returns empty when llm or settings are unavailable", async () => {
  const noLlm = await composeVoiceOperationalMessage(
    {
      llm: null
    },
    {
      settings: baseSettings(),
      event: "voice_runtime"
    }
  );
  assert.equal(noLlm, "");

  const noSettings = await composeVoiceOperationalMessage(
    {
      llm: {
        async generate() {
          return { text: "hello" };
        }
      }
    },
    {
      settings: null,
      event: "voice_runtime"
    }
  );
  assert.equal(noSettings, "");
});

test("composeVoiceOperationalMessage honors [SKIP] only when allowSkip is enabled", async () => {
  const { bot } = createVoiceBot({
    generationText: "[SKIP]"
  });

  const hidden = await composeVoiceOperationalMessage(bot, {
    settings: baseSettings(),
    event: "voice_runtime",
    allowSkip: false
  });
  assert.equal(hidden, "");

  const explicitSkip = await composeVoiceOperationalMessage(bot, {
    settings: baseSettings(),
    event: "voice_runtime",
    allowSkip: true
  });
  assert.equal(explicitSkip, "[SKIP]");
});

test("composeVoiceOperationalMessage logs voice errors when llm generation throws", async () => {
  const { bot, logs } = createVoiceBot({
    generationError: new Error("llm exploded")
  });

  const text = await composeVoiceOperationalMessage(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    messageId: "msg-1",
    event: "voice_runtime",
    reason: "join_failed"
  });

  assert.equal(text, "");
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.kind, "voice_error");
  assert.equal(String(logs[0]?.content || "").includes("voice_operational_llm_failed"), true);
});

test("generateVoiceTurnReply returns early for empty transcripts", async () => {
  const { bot, getGenerationCalls } = createVoiceBot();
  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "   "
  });

  assert.deepEqual(reply, { text: "" });
  assert.equal(getGenerationCalls(), 0);
});

test("generateVoiceTurnReply adds join-window greeting bias guidance", async () => {
  const { bot, generationPayloads } = createVoiceBot({
    generationText: "[SKIP]"
  });
  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "yo, what's up?",
    isEagerTurn: true,
    joinWindowActive: true,
    joinWindowAgeMs: 1800
  });

  assert.equal(reply.text, "");
  assert.equal(generationPayloads.length, 1);
  assert.equal(
    String(generationPayloads[0]?.systemPrompt || "").includes("Join window active: you just joined VC."),
    true
  );
  assert.equal(
    String(generationPayloads[0]?.userPrompt || "").includes("Join window active: yes"),
    true
  );
});

test("generateVoiceTurnReply includes roster and membership-change prompt context", async () => {
  const { bot, generationPayloads } = createVoiceBot({
    generationText: "[SKIP]"
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "who just joined?",
    isEagerTurn: true,
    participantRoster: [
      { displayName: "alice" },
      { displayName: "bob" }
    ],
    recentMembershipEvents: [
      {
        eventType: "join",
        displayName: "bob",
        ageMs: 1600
      },
      {
        eventType: "leave",
        displayName: "charlie",
        ageMs: 4200
      }
    ]
  });

  assert.equal(reply.text, "");
  assert.equal(generationPayloads.length, 1);
  const userPrompt = String(generationPayloads[0]?.userPrompt || "");
  assert.equal(userPrompt.includes("Humans currently in channel: alice, bob."), true);
  assert.equal(userPrompt.includes("Recent voice membership changes:"), true);
  assert.equal(userPrompt.includes("bob joined the voice channel"), true);
  assert.equal(userPrompt.includes("charlie left the voice channel"), true);
  assert.equal(
    userPrompt.includes("do not claim you can't see who is in channel"),
    true
  );
  assert.equal(
    userPrompt.includes("prefer a quick greeting for recent joiners"),
    true
  );
});

test("generateVoiceTurnReply parses memory and soundboard directives", async () => {
  const { bot, ingests, remembers } = createVoiceBot({
    generationText:
      "bet [[SOUNDBOARD:airhorn@123]] [[MEMORY_LINE:likes pizza]] [[SELF_MEMORY_LINE:i keep replies concise]]"
  });
  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      memory: {
        enabled: true
      },
      voice: {
        soundboard: {
          enabled: true
        }
      }
    }),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "drop the update",
    contextMessages: [
      {
        role: "user",
        content: "what happened?"
      }
    ],
    soundboardCandidates: ["airhorn@123"]
  });

  assert.equal(reply.text, "bet");
  assert.equal(reply.soundboardRef, "airhorn@123");
  assert.equal(ingests.length, 0);
  assert.equal(remembers.length, 2);
  assert.equal(remembers[0]?.line, "likes pizza");
  assert.equal(remembers[0]?.scope, "lore");
  assert.equal(remembers[1]?.line, "i keep replies concise");
  assert.equal(remembers[1]?.scope, "self");
});

test("generateVoiceTurnReply drops soundboard directive when soundboard is disabled", async () => {
  const { bot } = createVoiceBot({
    generationText: "copy that [[SOUNDBOARD:airhorn@123]]"
  });
  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      voice: {
        soundboard: {
          enabled: false
        }
      }
    }),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "say something",
    soundboardCandidates: ["airhorn@123"]
  });

  assert.equal(reply.text, "copy that");
  assert.equal(reply.soundboardRef, null);
});

test("generateVoiceTurnReply strips selected soundboard id and name from spoken text", async () => {
  const { bot } = createVoiceBot({
    generationText: "playing airhorn@123 now airhorn [[SOUNDBOARD:airhorn@123]]"
  });
  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      voice: {
        soundboard: {
          enabled: true
        }
      }
    }),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "drop a sound",
    soundboardCandidates: ["airhorn@123 | airhorn"]
  });

  assert.equal(reply.text, "playing now");
  assert.equal(reply.soundboardRef, "airhorn@123");
});

test("generateVoiceTurnReply preserves soundboard ref when scrubbed speech becomes empty", async () => {
  const { bot } = createVoiceBot({
    generationText: "airhorn@123 [[SOUNDBOARD:airhorn@123]]"
  });
  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      voice: {
        soundboard: {
          enabled: true
        }
      }
    }),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "drop a sound",
    soundboardCandidates: ["airhorn@123 | airhorn"]
  });

  assert.equal(reply.text, "");
  assert.equal(reply.soundboardRef, "airhorn@123");
});

test("generateVoiceTurnReply logs voice errors when generation fails", async () => {
  const { bot, logs } = createVoiceBot({
    generationError: new Error("generation failed")
  });
  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "hello there"
  });

  assert.deepEqual(reply, { text: "" });
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.kind, "voice_error");
  assert.equal(String(logs[0]?.content || "").includes("voice_stt_generation_failed"), true);
});

test("generateVoiceTurnReply uses voice generation llm provider/model instead of text llm provider/model", async () => {
  const { bot, generationPayloads } = createVoiceBot({
    generationText: "copy that"
  });
  await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      llm: {
        provider: "openai",
        model: "claude-haiku-4-5"
      },
      voice: {
        generationLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        }
      }
    }),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "quick status?"
  });

  assert.equal(generationPayloads.length > 0, true);
  assert.equal(generationPayloads[0]?.settings?.llm?.provider, "anthropic");
  assert.equal(generationPayloads[0]?.settings?.llm?.model, "claude-haiku-4-5");
});

test("generateVoiceTurnReply runs web lookup follow-up with start/complete callbacks", async () => {
  const { bot, webSearchCalls, lookupMemoryWrites, getGenerationCalls } = createVoiceBot({
    generationSequence: [
      "one sec [[WEB_SEARCH:latest rust stable version]]",
      "latest stable rust is 1.90"
    ]
  });

  const callbackEvents = [];
  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings({
      webSearch: {
        enabled: true
      }
    }),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "what's the latest rust stable?",
    onWebLookupStart: async (payload) => {
      callbackEvents.push(`start:${String(payload?.query || "")}`);
    },
    onWebLookupComplete: async (payload) => {
      callbackEvents.push(`done:${String(payload?.query || "")}`);
    }
  });

  assert.equal(getGenerationCalls(), 2);
  assert.equal(webSearchCalls.length, 1);
  assert.equal(webSearchCalls[0]?.query, "latest rust stable version");
  assert.deepEqual(callbackEvents, [
    "start:latest rust stable version",
    "done:latest rust stable version"
  ]);
  assert.equal(lookupMemoryWrites.length, 1);
  assert.equal(lookupMemoryWrites[0]?.query, "latest rust stable version");
  assert.equal(lookupMemoryWrites[0]?.results?.[0]?.domain, "example.com");
  assert.equal(reply.text, "latest stable rust is 1.90");
  assert.equal(reply.usedWebSearchFollowup, true);
});

test("generateVoiceTurnReply includes short-term lookup memory in prompt context", async () => {
  const { bot, generationPayloads, lookupMemorySearchCalls } = createVoiceBot({
    generationText: "[SKIP]",
    recentLookupContext: [
      {
        query: "rust stable release date",
        provider: "brave",
        ageMinutes: 20,
        results: [
          {
            domain: "blog.rust-lang.org",
            url: "https://blog.rust-lang.org/releases/"
          }
        ]
      }
    ]
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "what source did you use before?"
  });

  assert.equal(reply.text, "");
  assert.equal(lookupMemorySearchCalls.length, 1);
  const userPrompt = String(generationPayloads[0]?.userPrompt || "");
  assert.equal(userPrompt.includes("Short-term lookup memory from recent successful web searches"), true);
  assert.equal(userPrompt.includes("blog.rust-lang.org"), true);
});

test("generateVoiceTurnReply triggers voice screen-share link offer from directive", async () => {
  const { bot, screenShareCalls } = createVoiceBot({
    generationText: "i can check it [[SCREEN_SHARE_LINK]]",
    screenShareCapability: {
      enabled: true,
      status: "ready",
      publicUrl: "https://fancy-cat.trycloudflare.com"
    },
    offerScreenShare: async () => ({ offered: true })
  });

  const reply = await generateVoiceTurnReply(bot, {
    settings: baseSettings(),
    guildId: "guild-1",
    channelId: "text-1",
    userId: "user-1",
    transcript: "can you look at my screen?"
  });

  assert.equal(reply.text, "i can check it");
  assert.equal(reply.usedScreenShareOffer, true);
  assert.equal(screenShareCalls.length, 1);
  assert.equal(screenShareCalls[0]?.guildId, "guild-1");
  assert.equal(screenShareCalls[0]?.channelId, "text-1");
  assert.equal(screenShareCalls[0]?.requesterUserId, "user-1");
});
