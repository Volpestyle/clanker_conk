import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  BOT_NAME_ALIAS_MAX_ITEMS,
  normalizeSettings,
  PERSONA_FLAVOR_MAX_CHARS
} from "./settingsNormalization.ts";

function normalizeLegacyView(input: unknown): any {
  return normalizeSettings(input);
}

test("normalizeSettings clamps and normalizes complex nested settings", () => {
  const normalized = normalizeLegacyView({
    botName: "x".repeat(120),
    botNameAliases: ["clank", "clank", "  ", "conk", "alias-".repeat(20)],
    llm: {
      provider: "XAI",
      model: "",
      temperature: 9,
      maxOutputTokens: 1
    },
    replyFollowupLlm: {
      enabled: true,
      provider: "not-real",
      model: "",
      maxToolSteps: 99,
      maxTotalToolCalls: -5,
      maxWebSearchCalls: 7,
      maxMemoryLookupCalls: -2,
      maxImageLookupCalls: 999,
      toolTimeoutMs: 999999
    },
    webSearch: {
      enabled: true,
      maxSearchesPerHour: 999,
      maxResults: 0,
      maxPagesToRead: 99,
      maxCharsPerPage: 80,
      safeSearch: false,
      providerOrder: ["serpapi", "serpapi", "brave", "unknown"],
      recencyDaysDefault: 0,
      maxConcurrentFetches: 99
    },
    browser: {
      enabled: true,
      llm: {
        provider: "OPENAI",
        model: ""
      },
      maxBrowseCallsPerHour: 999,
      maxStepsPerTask: 0,
      stepTimeoutMs: 1000,
      sessionTimeoutMs: 999999
    },
    videoContext: {
      enabled: true,
      maxLookupsPerHour: -1,
      maxVideosPerMessage: 99,
      maxTranscriptChars: 99_999,
      keyframeIntervalSeconds: -5,
      maxKeyframesPerVideo: 30,
      allowAsrFallback: true,
      maxAsrSeconds: 2
    },
    voice: {
      voiceProvider: "openai",
      brainProvider: "native",
      asrLanguageMode: "FIXED",
      asrLanguageHint: "EN_us",
      generationLlm: {
        provider: "not-real",
        model: ""
      },
      thoughtEngine: {
        enabled: "yes",
        provider: "NOT-REAL",
        model: "",
        temperature: 9,
        eagerness: 999,
        minSilenceSeconds: 1,
        minSecondsBetweenThoughts: 9999
      },
      replyDecisionLlm: {
        provider: "CLAUDE-CODE",
        model: "",
        reasoningEffort: "HIGH"
      },
      openaiRealtime: {
        inputAudioFormat: "bad-format",
        outputAudioFormat: "g711_alaw"
      },
      geminiRealtime: {
        apiBaseUrl: "ftp://invalid.example/path",
        inputSampleRateHz: 0,
        outputSampleRateHz: 99_000
      },
      streamWatch: {
        minCommentaryIntervalSeconds: 1,
        maxFramesPerMinute: 9999,
        maxFrameBytes: 10,
        commentaryPath: "not-real",
        keyframeIntervalMs: 20,
        autonomousCommentaryEnabled: 0,
        brainContextEnabled: "yes",
        brainContextMinIntervalSeconds: -4,
        brainContextMaxEntries: 999,
        brainContextPrompt: `${"x".repeat(520)}   `
      },
      soundboard: {
        preferredSoundIds: ["first", "first", "second"]
      },
      musicDucking: {
        targetGain: -2,
        fadeMs: 99999
      }
    },
    discovery: {
      allowedImageModels: "gpt-image-1.5, gpt-image-1.5, grok-imagine-image",
      allowedVideoModels: ["grok-imagine-video", "grok-imagine-video"],
      rssFeeds: ["https://ok.example/feed", "not-a-url"],
      xHandles: ["@alice", "@alice", "bob"],
      redditSubreddits: ["r/memes", "memes"],
      xNitterBaseUrl: "https://nitter.example/path",
      sources: {
        reddit: false,
        x: true
      }
    }
  });

  assert.equal(normalized.botName.length, 50);
  assert.deepEqual(normalized.botNameAliases, ["clank", "conk", "alias-alias-alias-alias-alias-alias-alias-alias-al"]);
  assert.equal(normalized.llm.provider, "xai");
  assert.equal(normalized.llm.model, "grok-3-mini-latest");
  assert.equal(normalized.llm.temperature, 2);
  assert.equal(normalized.llm.maxOutputTokens, 32);
  assert.equal(normalized.replyFollowupLlm.provider, "xai");
  assert.equal(normalized.replyFollowupLlm.model, "grok-3-mini-latest");
  assert.equal(normalized.replyFollowupLlm.maxToolSteps, 6);
  assert.equal(normalized.replyFollowupLlm.maxTotalToolCalls, 0);
  assert.equal(normalized.replyFollowupLlm.maxWebSearchCalls, 6);
  assert.equal(normalized.replyFollowupLlm.maxMemoryLookupCalls, 0);
  assert.equal(normalized.replyFollowupLlm.maxImageLookupCalls, 6);
  assert.equal(normalized.replyFollowupLlm.toolTimeoutMs, 60000);

  assert.equal(normalized.webSearch.maxSearchesPerHour, 120);
  assert.equal(normalized.webSearch.maxResults, 1);
  assert.equal(normalized.webSearch.maxPagesToRead, 5);
  assert.equal(normalized.webSearch.maxCharsPerPage, 350);
  assert.equal(normalized.webSearch.safeSearch, false);
  assert.equal(normalized.webSearch.recencyDaysDefault, 1);
  assert.equal(normalized.webSearch.maxConcurrentFetches, 10);
  assert.deepEqual(normalized.webSearch.providerOrder, ["serpapi", "brave"]);

  assert.equal(normalized.browser.enabled, true);
  assert.equal(normalized.browser.llm.provider, "openai");
  assert.equal(normalized.browser.llm.model, "gpt-5-mini");
  assert.equal(normalized.browser.maxBrowseCallsPerHour, 60);
  assert.equal(normalized.browser.maxStepsPerTask, 1);
  assert.equal(normalized.browser.stepTimeoutMs, 5_000);
  assert.equal(normalized.browser.sessionTimeoutMs, 600_000);

  assert.equal(normalized.videoContext.maxLookupsPerHour, 0);
  assert.equal(normalized.videoContext.maxVideosPerMessage, 6);
  assert.equal(normalized.videoContext.maxTranscriptChars, 4000);
  assert.equal(normalized.videoContext.keyframeIntervalSeconds, 0);
  assert.equal(normalized.videoContext.maxKeyframesPerVideo, 8);
  assert.equal(normalized.videoContext.maxAsrSeconds, 15);

  assert.equal(normalized.voice.voiceProvider, "openai");
  assert.equal(normalized.voice.brainProvider, "openai");
  assert.equal(normalized.voice.asrLanguageMode, "fixed");
  assert.equal(normalized.voice.asrLanguageHint, "en-us");
  assert.equal(normalized.voice.generationLlm.useTextModel, true);
  assert.equal(normalized.voice.generationLlm.provider, "xai");
  assert.equal(normalized.voice.generationLlm.model, "grok-3-mini-latest");
  assert.equal(normalized.voice.thoughtEngine.enabled, true);
  assert.equal(normalized.voice.thoughtEngine.provider, "anthropic");
  assert.equal(normalized.voice.thoughtEngine.model, "claude-sonnet-4-6");
  assert.equal(normalized.voice.thoughtEngine.temperature, 2);
  assert.equal(normalized.voice.thoughtEngine.eagerness, 100);
  assert.equal(normalized.voice.thoughtEngine.minSilenceSeconds, 8);
  assert.equal(normalized.voice.thoughtEngine.minSecondsBetweenThoughts, 600);
  assert.equal(normalized.voice.replyDecisionLlm.provider, "claude-code");
  assert.equal(normalized.voice.replyDecisionLlm.model, "sonnet");
  assert.equal(normalized.voice.replyDecisionLlm.maxAttempts, undefined);
  assert.equal(normalized.voice.replyDecisionLlm.reasoningEffort, "high");
  assert.equal(normalized.voice.replyDecisionLlm.realtimeAdmissionMode, "hard_classifier");
  assert.equal(normalized.voice.replyDecisionLlm.musicWakeLatchSeconds, 15);
  assert.equal(normalized.voice.replyDecisionLlm.prompts, undefined);
  assert.equal(normalized.voice.commandOnlyMode, false);
  assert.equal(normalized.voice.openaiRealtime.inputAudioFormat, "pcm16");
  assert.equal(normalized.voice.openaiRealtime.outputAudioFormat, "pcm16");
  assert.equal(normalized.voice.openaiRealtime.transcriptionMethod, "realtime_bridge");
  assert.equal(normalized.voice.openaiRealtime.usePerUserAsrBridge, true);
  assert.equal(normalized.voice.geminiRealtime.apiBaseUrl, "https://generativelanguage.googleapis.com");
  assert.equal(normalized.voice.geminiRealtime.inputSampleRateHz, 8000);
  assert.equal(normalized.voice.geminiRealtime.outputSampleRateHz, 48000);
  assert.equal(normalized.voice.streamWatch.minCommentaryIntervalSeconds, 3);
  assert.equal(normalized.voice.streamWatch.maxFramesPerMinute, 600);
  assert.equal(normalized.voice.streamWatch.maxFrameBytes, 50_000);
  assert.equal(normalized.voice.streamWatch.commentaryPath, "auto");
  assert.equal(normalized.voice.streamWatch.keyframeIntervalMs, 250);
  assert.equal(normalized.voice.streamWatch.autonomousCommentaryEnabled, false);
  assert.equal(normalized.voice.streamWatch.brainContextEnabled, true);
  assert.equal(normalized.voice.streamWatch.brainContextMinIntervalSeconds, 1);
  assert.equal(normalized.voice.streamWatch.brainContextMaxEntries, 24);
  assert.equal(normalized.voice.streamWatch.brainContextPrompt.length, 420);
  assert.deepEqual(normalized.voice.soundboard.preferredSoundIds, ["first", "second"]);
  assert.equal(normalized.voice.musicDucking.targetGain, 0.05);
  assert.equal(normalized.voice.musicDucking.fadeMs, 5000);

  assert.deepEqual(normalized.discovery.allowedImageModels, ["gpt-image-1.5", "grok-imagine-image"]);
  assert.deepEqual(normalized.discovery.allowedVideoModels, ["grok-imagine-video"]);
  assert.deepEqual(normalized.discovery.rssFeeds, ["https://ok.example/feed"]);
  assert.deepEqual(normalized.discovery.xHandles, ["alice", "bob"]);
  assert.deepEqual(normalized.discovery.redditSubreddits, ["memes", "memes"]);
  assert.equal(normalized.discovery.xNitterBaseUrl, "https://nitter.example");
  assert.equal(normalized.discovery.sources.reddit, false);
  assert.equal(normalized.discovery.sources.x, true);
});

test("normalizeSettings respects explicit false for openaiRealtime usePerUserAsrBridge", () => {
  const normalized = normalizeLegacyView({
    voice: {
      openaiRealtime: {
        usePerUserAsrBridge: false
      }
    }
  });

  assert.equal(normalized.voice.openaiRealtime.usePerUserAsrBridge, false);
});

test("normalizeSettings allows up to 100 bot aliases before truncating", () => {
  const aliases = Array.from({ length: BOT_NAME_ALIAS_MAX_ITEMS + 5 }, (_, index) => `alias-${index + 1}`);

  const normalized = normalizeLegacyView({
    botNameAliases: aliases
  });

  assert.equal(normalized.botNameAliases.length, BOT_NAME_ALIAS_MAX_ITEMS);
  assert.deepEqual(normalized.botNameAliases, aliases.slice(0, BOT_NAME_ALIAS_MAX_ITEMS));
});

test("normalizeSettings preserves explicit file_wav transcription mode", () => {
  const normalized = normalizeLegacyView({
    voice: {
      openaiRealtime: {
        transcriptionMethod: "file_wav"
      }
    }
  });

  assert.equal(normalized.voice.openaiRealtime.transcriptionMethod, "file_wav");
});

test("normalizeSettings restricts browser llm provider to supported browser providers", () => {
  const normalized = normalizeLegacyView({
    browser: {
      llm: {
        provider: "xai",
        model: ""
      }
    }
  });

  assert.equal(normalized.browser.llm.provider, "anthropic");
  assert.equal(normalized.browser.llm.model, "claude-sonnet-4-5-20250929");
});

test("normalizeSettings normalizes code agent provider and model fields", () => {
  const fallback = normalizeLegacyView({
    codeAgent: {
      provider: "not-real",
      model: "",
      codexModel: ""
    }
  });

  assert.equal(fallback.codeAgent.provider, "claude-code");
  assert.equal(fallback.codeAgent.model, "sonnet");
  assert.equal(fallback.codeAgent.codexModel, "codex-mini-latest");

  const codex = normalizeLegacyView({
    codeAgent: {
      provider: "CODEX",
      model: "opus",
      codexModel: "gpt-5-codex"
    }
  });

  assert.equal(codex.codeAgent.provider, "codex");
  assert.equal(codex.codeAgent.model, "opus");
  assert.equal(codex.codeAgent.codexModel, "gpt-5-codex");
});

test("normalizeSettings preserves explicit commandOnlyMode", () => {
  const normalized = normalizeLegacyView({
    voice: {
      commandOnlyMode: true
    }
  });

  assert.equal(normalized.voice.commandOnlyMode, true);
});

test("normalizeSettings preserves explicit adaptive directive and automation toggles", () => {
  const normalized = normalizeLegacyView({
    adaptiveDirectives: {
      enabled: false
    },
    automations: {
      enabled: false
    }
  });

  assert.equal(normalized.adaptiveDirectives.enabled, false);
  assert.equal(normalized.automations.enabled, false);
});

test("normalizeSettings handles memoryLlm defaults and discovery source fallbacks", () => {
  const normalized = normalizeLegacyView({
    memoryLlm: {},
    discovery: {
      sources: {
        reddit: undefined,
        hackerNews: undefined,
        youtube: undefined,
        rss: undefined,
        x: undefined
      }
    },
    prompt: {
      textGuidance: ["  one ", "one", "", "two"],
      voiceGuidance: [" alpha ", "alpha", "beta"],
      voiceOperationalGuidance: ["a", "a", "b"]
    }
  });

  assert.equal(normalized.memoryLlm.provider, "anthropic");
  assert.equal(normalized.memoryLlm.model, "claude-haiku-4-5");
  assert.deepEqual(normalized.prompt.textGuidance, ["one", "two"]);
  assert.deepEqual(normalized.prompt.voiceGuidance, ["alpha", "beta"]);
  assert.deepEqual(normalized.prompt.voiceOperationalGuidance, ["a", "b"]);

  assert.equal(typeof normalized.discovery.sources.reddit, "boolean");
  assert.equal(typeof normalized.discovery.sources.hackerNews, "boolean");
  assert.equal(typeof normalized.discovery.sources.youtube, "boolean");
  assert.equal(typeof normalized.discovery.sources.rss, "boolean");
  assert.equal(typeof normalized.discovery.sources.x, "boolean");
});

test("normalizeSettings defaults llm maxOutputTokens to 2500 and preserves high values", () => {
  const defaulted = normalizeLegacyView({
    llm: {}
  });
  assert.equal(defaulted.llm.maxOutputTokens, 2500);

  const highValue = normalizeLegacyView({
    llm: {
      maxOutputTokens: 9_999
    }
  });
  assert.equal(highValue.llm.maxOutputTokens, 9_999);
});

test("normalizeSettings forces voice generation llm to text llm when useTextModel is enabled", () => {
  const normalized = normalizeLegacyView({
    llm: {
      provider: "openai",
      model: "claude-haiku-4-5"
    },
    voice: {
      generationLlm: {
        useTextModel: true,
        provider: "anthropic",
        model: "grok-3-mini-latest"
      }
    },
    replyFollowupLlm: {
      enabled: true,
      useTextModel: true,
      provider: "anthropic",
      model: "grok-3-mini-latest"
    }
  });

  assert.equal(normalized.voice.generationLlm.useTextModel, true);
  assert.equal(normalized.voice.generationLlm.provider, "openai");
  assert.equal(normalized.voice.generationLlm.model, "claude-haiku-4-5");
  assert.equal("useTextModel" in normalized.replyFollowupLlm, false);
});

test("normalizeSettings normalizes elevenlabs voice provider settings", () => {
  const normalized = normalizeLegacyView({
    voice: {
      voiceProvider: "elevenlabs",
      elevenLabsRealtime: {
        agentId: "   agent_abc   ",
        apiBaseUrl: "ftp://not-allowed.example/path",
        inputSampleRateHz: 200000,
        outputSampleRateHz: 4000
      }
    }
  });

  assert.equal(normalized.voice.voiceProvider, "elevenlabs");
  assert.equal(normalized.voice.elevenLabsRealtime.agentId, "agent_abc");
  assert.equal(normalized.voice.elevenLabsRealtime.apiBaseUrl, "https://api.elevenlabs.io");
  assert.equal(normalized.voice.elevenLabsRealtime.inputSampleRateHz, 48000);
  assert.equal(normalized.voice.elevenLabsRealtime.outputSampleRateHz, 8000);
});

test("normalizeSettings uses provider-appropriate memoryLlm model fallback", () => {
  const normalized = normalizeLegacyView({
    memoryLlm: {
      provider: "openai",
      model: ""
    }
  });

  assert.equal(normalized.memoryLlm.provider, "openai");
  assert.equal(normalized.memoryLlm.model, "claude-haiku-4-5");
});

test("normalizeSettings preserves supported reflection strategies and defaults invalid ones", () => {
  const onePass = normalizeLegacyView({
    memory: {
      reflection: {
        strategy: "one_pass_main"
      }
    }
  });
  assert.equal(onePass.memory.reflection.strategy, "one_pass_main");

  const invalid = normalizeLegacyView({
    memory: {
      reflection: {
        strategy: "something_else"
      }
    }
  });
  assert.equal(invalid.memory.reflection.strategy, "two_pass_extract_then_main");
});

test("normalizeSettings keeps stt pipeline voice generation and reply decider independent from main llm", () => {
  const normalized = normalizeLegacyView({
    llm: {
      provider: "claude-code",
      model: "opus"
    },
    voice: {
      mode: "stt_pipeline",
      generationLlm: {
        useTextModel: false,
        provider: "openai",
        model: "claude-haiku-4-5"
      },
      replyDecisionLlm: {
        provider: "openai",
        model: "claude-haiku-4-5",
        reasoningEffort: "not-real"
      }
    }
  });

  assert.equal(normalized.voice.generationLlm.provider, "openai");
  assert.equal(normalized.voice.generationLlm.model, "claude-haiku-4-5");
  assert.equal(normalized.voice.generationLlm.useTextModel, false);
  assert.equal(normalized.voice.replyDecisionLlm.provider, "openai");
  assert.equal(normalized.voice.replyDecisionLlm.model, "claude-haiku-4-5");
  assert.equal(normalized.voice.replyDecisionLlm.maxAttempts, undefined);
  assert.equal(normalized.voice.replyDecisionLlm.reasoningEffort, "minimal");
  assert.equal(normalized.voice.replyDecisionLlm.realtimeAdmissionMode, "hard_classifier");
  assert.equal(normalized.voice.replyDecisionLlm.musicWakeLatchSeconds, 15);
});

test("normalizeSettings strips removed replyDecisionLlm fields and migrates legacy enabled false", () => {
  const normalized = normalizeLegacyView({
    voice: {
      replyDecisionLlm: {
        enabled: false,
        prompts: {
          wakeVariantHint: "custom wake rule",
          systemPromptCompact: "compact prompt"
        }
      }
    }
  });

  assert.equal(normalized.voice.replyDecisionLlm.realtimeAdmissionMode, "generation_only");
  assert.equal(normalized.voice.replyDecisionLlm.musicWakeLatchSeconds, 15);
  assert.equal(normalized.voice.replyDecisionLlm.prompts, undefined);
});

test("normalizeSettings enforces replyDecisionLlm realtime admission enum fallback", () => {
  const invalidMode = normalizeLegacyView({
    voice: {
      replyDecisionLlm: {
        realtimeAdmissionMode: "something_else"
      }
    }
  });
  assert.equal(invalidMode.voice.replyDecisionLlm.realtimeAdmissionMode, "hard_classifier");

  const validMode = normalizeLegacyView({
    voice: {
      replyDecisionLlm: {
        realtimeAdmissionMode: "generation_only"
      }
    }
  });
  assert.equal(validMode.voice.replyDecisionLlm.realtimeAdmissionMode, "generation_only");
});

test("normalizeSettings clamps replyDecisionLlm music wake latch seconds", () => {
  const low = normalizeLegacyView({
    voice: {
      replyDecisionLlm: {
        musicWakeLatchSeconds: 1
      }
    }
  });
  assert.equal(low.voice.replyDecisionLlm.musicWakeLatchSeconds, 5);

  const high = normalizeLegacyView({
    voice: {
      replyDecisionLlm: {
        musicWakeLatchSeconds: 999
      }
    }
  });
  assert.equal(high.voice.replyDecisionLlm.musicWakeLatchSeconds, 60);
});

test("normalizeSettings preserves long media prompt craft guidance blocks", () => {
  const longGuidance = `line one\n${"x".repeat(1200)}\nline three`;
  const normalized = normalizeLegacyView({
    prompt: {
      mediaPromptCraftGuidance: longGuidance
    }
  });

  assert.equal(normalized.prompt.mediaPromptCraftGuidance, longGuidance);
});

test("normalizeSettings allows longer persona flavor values", () => {
  const withinLimit = "x".repeat(PERSONA_FLAVOR_MAX_CHARS);
  const normalizedWithinLimit = normalizeLegacyView({
    persona: {
      flavor: withinLimit
    }
  });
  assert.equal(normalizedWithinLimit.persona.flavor, withinLimit);

  const overLimit = `${"y".repeat(PERSONA_FLAVOR_MAX_CHARS)}overflow`;
  const normalizedOverLimit = normalizeLegacyView({
    persona: {
      flavor: overLimit
    }
  });
  assert.equal(normalizedOverLimit.persona.flavor.length, PERSONA_FLAVOR_MAX_CHARS);
});

test("normalizeSettings supports auto/fixed voice ASR language guidance", () => {
  const autoHint = normalizeLegacyView({
    voice: {
      asrLanguageMode: "auto",
      asrLanguageHint: "EN"
    }
  });
  assert.equal(autoHint.voice.asrLanguageMode, "auto");
  assert.equal(autoHint.voice.asrLanguageHint, "en");

  const fixedHint = normalizeLegacyView({
    voice: {
      asrLanguageMode: "fixed",
      asrLanguageHint: "en-US"
    }
  });
  assert.equal(fixedHint.voice.asrLanguageMode, "fixed");
  assert.equal(fixedHint.voice.asrLanguageHint, "en-us");

  const invalid = normalizeLegacyView({
    voice: {
      asrLanguageMode: "not-real",
      asrLanguageHint: "!!!!!!"
    }
  });
  assert.equal(invalid.voice.asrLanguageMode, "auto");
  assert.equal(invalid.voice.asrLanguageHint, "en");
});
