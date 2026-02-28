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
      model: "gpt-4.1-mini",
      temperature: 0.8,
      maxOutputTokens: 160
    },
    memory: {
      enabled: false
    },
    voice: {
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
    voice: {
      ...base.voice,
      ...(overrides.voice || {}),
      soundboard: {
        ...base.voice.soundboard,
        ...(overrides.voice?.soundboard || {})
      }
    }
  };
}

function createVoiceBot({
  generationText = "all good",
  generationError = null
} = {}) {
  const logs = [];
  const ingests = [];
  const remembers = [];
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
      async generate() {
        generationCalls += 1;
        if (generationError) throw generationError;
        return {
          text: generationText
        };
      }
    },
    memory: {
      async ingestMessage(payload) {
        ingests.push(payload);
      },
      async rememberLine(payload) {
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

test("generateVoiceTurnReply parses memory and soundboard directives", async () => {
  const { bot, ingests, remembers } = createVoiceBot({
    generationText: "bet [[SOUNDBOARD:airhorn@123]] [[MEMORY_LINE:likes pizza]]"
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
  assert.equal(ingests.length, 1);
  assert.equal(remembers.length, 1);
  assert.equal(remembers[0]?.line, "likes pizza");
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
