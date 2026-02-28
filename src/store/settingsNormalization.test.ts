import { test } from "bun:test";
import assert from "node:assert/strict";
import { normalizeSettings } from "./settingsNormalization.ts";

test("normalizeSettings clamps and normalizes complex nested settings", () => {
  const normalized = normalizeSettings({
    botName: "x".repeat(120),
    llm: {
      provider: "XAI",
      model: "",
      temperature: 9,
      maxOutputTokens: 1
    },
    replyFollowupLlm: {
      enabled: true,
      provider: "not-real",
      model: ""
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
      mode: "OPENAI_REALTIME",
      replyDecisionLlm: {
        provider: "CLAUDE-CODE",
        model: "",
        maxAttempts: 9
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
        maxFrameBytes: 10
      },
      soundboard: {
        preferredSoundIds: ["first", "first", "second"]
      }
    },
    initiative: {
      allowedImageModels: "gpt-image-1.5, gpt-image-1.5, grok-imagine-image",
      allowedVideoModels: ["grok-imagine-video", "grok-imagine-video"],
      discovery: {
        rssFeeds: ["https://ok.example/feed", "not-a-url"],
        xHandles: ["@alice", "@alice", "bob"],
        redditSubreddits: ["r/memes", "memes"],
        xNitterBaseUrl: "https://nitter.example/path",
        sources: {
          reddit: false,
          x: true
        }
      }
    }
  });

  assert.equal(normalized.botName.length, 50);
  assert.equal(normalized.llm.provider, "xai");
  assert.equal(normalized.llm.model, "gpt-4.1-mini");
  assert.equal(normalized.llm.temperature, 2);
  assert.equal(normalized.llm.maxOutputTokens, 32);
  assert.equal(normalized.replyFollowupLlm.provider, "openai");
  assert.equal(normalized.replyFollowupLlm.model, "gpt-4.1-mini");

  assert.equal(normalized.webSearch.maxSearchesPerHour, 120);
  assert.equal(normalized.webSearch.maxResults, 1);
  assert.equal(normalized.webSearch.maxPagesToRead, 5);
  assert.equal(normalized.webSearch.maxCharsPerPage, 350);
  assert.equal(normalized.webSearch.safeSearch, false);
  assert.equal(normalized.webSearch.recencyDaysDefault, 1);
  assert.equal(normalized.webSearch.maxConcurrentFetches, 10);
  assert.deepEqual(normalized.webSearch.providerOrder, ["serpapi", "brave"]);

  assert.equal(normalized.videoContext.maxLookupsPerHour, 0);
  assert.equal(normalized.videoContext.maxVideosPerMessage, 6);
  assert.equal(normalized.videoContext.maxTranscriptChars, 4000);
  assert.equal(normalized.videoContext.keyframeIntervalSeconds, 0);
  assert.equal(normalized.videoContext.maxKeyframesPerVideo, 8);
  assert.equal(normalized.videoContext.maxAsrSeconds, 15);

  assert.equal(normalized.voice.mode, "openai_realtime");
  assert.equal(normalized.voice.replyDecisionLlm.provider, "claude-code");
  assert.equal(normalized.voice.replyDecisionLlm.model, "claude-haiku-4-5");
  assert.equal(normalized.voice.replyDecisionLlm.maxAttempts, 3);
  assert.equal(normalized.voice.openaiRealtime.inputAudioFormat, "pcm16");
  assert.equal(normalized.voice.openaiRealtime.outputAudioFormat, "g711_alaw");
  assert.equal(normalized.voice.geminiRealtime.apiBaseUrl, "https://generativelanguage.googleapis.com");
  assert.equal(normalized.voice.geminiRealtime.inputSampleRateHz, 8000);
  assert.equal(normalized.voice.geminiRealtime.outputSampleRateHz, 48000);
  assert.equal(normalized.voice.streamWatch.minCommentaryIntervalSeconds, 3);
  assert.equal(normalized.voice.streamWatch.maxFramesPerMinute, 600);
  assert.equal(normalized.voice.streamWatch.maxFrameBytes, 50_000);
  assert.deepEqual(normalized.voice.soundboard.preferredSoundIds, ["first", "second"]);

  assert.deepEqual(normalized.initiative.allowedImageModels, ["gpt-image-1.5", "grok-imagine-image"]);
  assert.deepEqual(normalized.initiative.allowedVideoModels, ["grok-imagine-video"]);
  assert.deepEqual(normalized.initiative.discovery.rssFeeds, ["https://ok.example/feed"]);
  assert.deepEqual(normalized.initiative.discovery.xHandles, ["alice", "bob"]);
  assert.deepEqual(normalized.initiative.discovery.redditSubreddits, ["memes", "memes"]);
  assert.equal(normalized.initiative.discovery.xNitterBaseUrl, "https://nitter.example");
  assert.equal(normalized.initiative.discovery.sources.reddit, false);
  assert.equal(normalized.initiative.discovery.sources.x, true);
});

test("normalizeSettings handles memoryLlm defaults and discovery source fallbacks", () => {
  const normalized = normalizeSettings({
    memoryLlm: {},
    initiative: {
      discovery: {
        sources: {
          reddit: undefined,
          hackerNews: undefined,
          youtube: undefined,
          rss: undefined,
          x: undefined
        }
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

  assert.equal(typeof normalized.initiative.discovery.sources.reddit, "boolean");
  assert.equal(typeof normalized.initiative.discovery.sources.hackerNews, "boolean");
  assert.equal(typeof normalized.initiative.discovery.sources.youtube, "boolean");
  assert.equal(typeof normalized.initiative.discovery.sources.rss, "boolean");
  assert.equal(typeof normalized.initiative.discovery.sources.x, "boolean");
});

test("normalizeSettings forces stt pipeline reply decider model/provider to main llm", () => {
  const normalized = normalizeSettings({
    llm: {
      provider: "claude-code",
      model: "opus"
    },
    voice: {
      mode: "stt_pipeline",
      replyDecisionLlm: {
        provider: "openai",
        model: "gpt-4.1-mini",
        maxAttempts: 2
      }
    }
  });

  assert.equal(normalized.voice.replyDecisionLlm.provider, "claude-code");
  assert.equal(normalized.voice.replyDecisionLlm.model, "opus");
  assert.equal(normalized.voice.replyDecisionLlm.maxAttempts, 2);
});
