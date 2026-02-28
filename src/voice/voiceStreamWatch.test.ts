import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  enableWatchStreamForUser,
  ingestStreamFrame,
  initializeStreamWatchState,
  maybeTriggerStreamWatchCommentary,
  resolveStreamWatchVisionProviderSettings
} from "./voiceStreamWatch.ts";

function createSettings(overrides = {}) {
  const defaults = {
    botName: "clanker conk",
    llm: {
      provider: "openai",
      model: "claude-haiku-4-5"
    },
    voice: {
      streamWatch: {
        enabled: true,
        minCommentaryIntervalSeconds: 8,
        maxFramesPerMinute: 180,
        maxFrameBytes: 350000,
        commentaryPath: "auto",
        keyframeIntervalMs: 1200
      }
    }
  };
  return {
    ...defaults,
    ...overrides,
    llm: {
      ...defaults.llm,
      ...(overrides.llm || {})
    },
    voice: {
      ...defaults.voice,
      ...(overrides.voice || {}),
      streamWatch: {
        ...defaults.voice.streamWatch,
        ...(overrides.voice?.streamWatch || {})
      }
    }
  };
}

function createSession(overrides = {}) {
  return {
    id: "session-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    mode: "openai_realtime",
    ending: false,
    settingsSnapshot: createSettings(),
    streamWatch: {
      active: true,
      targetUserId: "user-1",
      requestedByUserId: "user-1",
      lastFrameAt: 0,
      lastCommentaryAt: 0,
      ingestedFrameCount: 0,
      acceptedFrameCountInWindow: 0,
      frameWindowStartedAt: 0,
      latestFrameMimeType: null,
      latestFrameDataBase64: "",
      latestFrameAt: 0
    },
    userCaptures: new Map(),
    pendingResponse: false,
    lastInboundAudioAt: 0,
    realtimeClient: {
      appendInputVideoFrame() {},
      requestVideoCommentary() {}
    },
    ...overrides
  };
}

function createManager({
  session = null,
  settings = createSettings(),
  llm = {},
  guildVoiceMembers = ["user-1"]
} = {}) {
  const actions = [];
  const operationalMessages = [];
  const touchCalls = [];
  const createdResponses = [];
  const manager = {
    sessions: new Map(),
    sendOperationalMessage: async (payload) => {
      operationalMessages.push(payload);
      return true;
    },
    store: {
      getSettings() {
        return settings;
      },
      logAction(entry) {
        actions.push(entry);
      }
    },
    llm: {
      isProviderConfigured() {
        return false;
      },
      async generate() {
        return {
          text: "looks chaotic",
          provider: "openai",
          model: "claude-haiku-4-5"
        };
      },
      ...llm
    },
    client: {
      user: {
        id: "bot-1"
      },
      guilds: {
        cache: new Map()
      }
    },
    touchActivity(guildId, resolvedSettings) {
      touchCalls.push({ guildId, resolvedSettings });
    },
    resolveVoiceSpeakerName() {
      return "alice";
    },
    createTrackedAudioResponse() {
      const response = { id: `resp-${createdResponses.length + 1}` };
      createdResponses.push(response);
      return response;
    }
  };

  if (session) {
    manager.sessions.set(session.guildId, session);
    const members = new Set(guildVoiceMembers);
    const voiceChannel = {
      members: {
        has(userId) {
          return members.has(String(userId || ""));
        }
      }
    };
    manager.client.guilds.cache.set(session.guildId, {
      channels: {
        cache: new Map([[session.voiceChannelId, voiceChannel]])
      }
    });
  }

  return {
    manager,
    actions,
    operationalMessages,
    touchCalls,
    createdResponses
  };
}

test("initializeStreamWatchState resets stream-watch counters and frame buffers", () => {
  const session = createSession({
    streamWatch: {
      active: false,
      targetUserId: null,
      requestedByUserId: null,
      lastFrameAt: 100,
      lastCommentaryAt: 100,
      ingestedFrameCount: 12,
      acceptedFrameCountInWindow: 8,
      frameWindowStartedAt: 123,
      latestFrameMimeType: "image/png",
      latestFrameDataBase64: "abc",
      latestFrameAt: 456
    }
  });

  initializeStreamWatchState({}, {
    session,
    requesterUserId: "requester-1",
    targetUserId: "target-1"
  });

  assert.equal(session.streamWatch.active, true);
  assert.equal(session.streamWatch.targetUserId, "target-1");
  assert.equal(session.streamWatch.requestedByUserId, "requester-1");
  assert.equal(session.streamWatch.lastFrameAt, 0);
  assert.equal(session.streamWatch.lastCommentaryAt, 0);
  assert.equal(session.streamWatch.ingestedFrameCount, 0);
  assert.equal(session.streamWatch.acceptedFrameCountInWindow, 0);
  assert.equal(session.streamWatch.frameWindowStartedAt, 0);
  assert.equal(session.streamWatch.latestFrameMimeType, null);
  assert.equal(session.streamWatch.latestFrameDataBase64, "");
  assert.equal(session.streamWatch.latestFrameAt, 0);
});

test("resolveStreamWatchVisionProviderSettings picks first configured provider in priority order", () => {
  const { manager } = createManager({
    llm: {
      isProviderConfigured(provider) {
        return provider === "xai";
      }
    }
  });
  const resolved = resolveStreamWatchVisionProviderSettings(manager, {
    llm: {
      maxOutputTokens: 999,
      temperature: 0.9
    }
  });

  assert.equal(resolved.provider, "xai");
  assert.equal(resolved.model, "grok-2-vision-latest");
  assert.equal(resolved.temperature, 0.3);
  assert.equal(resolved.maxOutputTokens, 72);
});

test("resolveStreamWatchVisionProviderSettings honors anthropic keyframe forced path", () => {
  const { manager } = createManager({
    llm: {
      isProviderConfigured(provider) {
        return provider === "xai" || provider === "anthropic";
      }
    }
  });
  const resolved = resolveStreamWatchVisionProviderSettings(manager, {
    voice: {
      streamWatch: {
        commentaryPath: "anthropic_keyframes"
      }
    }
  });

  assert.equal(resolved?.provider, "anthropic");
  assert.equal(resolved?.model, "claude-haiku-4-5");
});

test("enableWatchStreamForUser enforces same-voice-channel requirement and supports success", async () => {
  const session = createSession();
  const denied = createManager({
    session,
    guildVoiceMembers: []
  });

  const deniedResult = await enableWatchStreamForUser(denied.manager, {
    guildId: "guild-1",
    requesterUserId: "user-1"
  });
  assert.equal(deniedResult.ok, false);
  assert.equal(deniedResult.reason, "requester_not_in_same_vc");

  const allowed = createManager({
    session: createSession()
  });
  const allowedResult = await enableWatchStreamForUser(allowed.manager, {
    guildId: "guild-1",
    requesterUserId: "user-1",
    targetUserId: "user-2",
    source: "test"
  });

  assert.equal(allowedResult.ok, true);
  assert.equal(allowedResult.reason, "watching_started");
  assert.equal(allowedResult.targetUserId, "user-2");
  assert.equal(allowed.manager.sessions.get("guild-1")?.streamWatch?.active, true);
  assert.equal(allowed.actions.some((entry) => entry.kind === "voice_runtime"), true);
});

test("ingestStreamFrame validates mime, frame size, and frame-rate limits", async () => {
  const settings = createSettings({
    voice: {
      streamWatch: {
        enabled: true,
        maxFramesPerMinute: 1,
        maxFrameBytes: 12
      }
    }
  });
  const session = createSession({
    mode: "voice_agent",
    realtimeClient: {
      requestTextUtterance() {}
    },
    settingsSnapshot: settings
  });
  const { manager } = createManager({
    session,
    settings,
    llm: {
      isProviderConfigured(provider) {
        return provider === "anthropic";
      }
    }
  });

  let result = await ingestStreamFrame(manager, {
    guildId: "guild-1",
    streamerUserId: "user-1",
    mimeType: "image/gif",
    dataBase64: "abcd"
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "invalid_mime_type");

  result = await ingestStreamFrame(manager, {
    guildId: "guild-1",
    streamerUserId: "user-1",
    mimeType: "image/png",
    dataBase64: "A".repeat(100_000)
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "frame_too_large");

  session.streamWatch.frameWindowStartedAt = Date.now();
  session.streamWatch.acceptedFrameCountInWindow = 6;
  result = await ingestStreamFrame(manager, {
    guildId: "guild-1",
    streamerUserId: "user-1",
    mimeType: "image/png",
    dataBase64: "AAAA"
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "frame_rate_limited");
});

test("ingestStreamFrame accepts fallback-buffered frame and updates runtime counters", async () => {
  const session = createSession({
    mode: "voice_agent",
    realtimeClient: {
      requestTextUtterance() {}
    },
    userCaptures: new Map([["user-1", {}]])
  });
  const { manager, actions, touchCalls } = createManager({
    session,
    settings: createSettings({
      voice: {
        streamWatch: {
          enabled: true,
          maxFramesPerMinute: 10,
          maxFrameBytes: 1_000_000
        }
      }
    }),
    llm: {
      isProviderConfigured(provider) {
        return provider === "anthropic";
      }
    }
  });

  const result = await ingestStreamFrame(manager, {
    guildId: "guild-1",
    streamerUserId: "user-1",
    mimeType: "image/jpg",
    dataBase64: "AAAAAA==",
    source: "unit_test"
  });

  assert.equal(result.accepted, true);
  assert.equal(result.reason, "ok");
  assert.equal(session.streamWatch.latestFrameMimeType, "image/jpeg");
  assert.equal(session.streamWatch.latestFrameDataBase64, "AAAAAA==");
  assert.equal(session.streamWatch.ingestedFrameCount, 1);
  assert.equal(session.streamWatch.acceptedFrameCountInWindow, 1);
  assert.equal(touchCalls.length, 1);
  assert.equal(actions.some((entry) => entry.content === "stream_watch_frame_ingested"), true);
});

test("maybeTriggerStreamWatchCommentary requests native provider commentary when available", async () => {
  const session = createSession({
    mode: "openai_realtime",
    realtimeClient: {
      appendInputVideoFrame() {},
      requestVideoCommentary() {}
    }
  });
  session.streamWatch.lastCommentaryAt = 0;
  const { manager, actions, createdResponses } = createManager({ session });

  await maybeTriggerStreamWatchCommentary(manager, {
    session,
    settings: createSettings(),
    streamerUserId: "user-1",
    source: "unit_test"
  });

  assert.equal(createdResponses.length, 1);
  assert.equal(session.streamWatch.lastCommentaryAt > 0, true);
  const logged = actions.find((entry) => entry.content === "stream_watch_commentary_requested");
  assert.equal(Boolean(logged), true);
  assert.equal(logged?.metadata?.commentaryPath, "provider_native_video");
});

test("maybeTriggerStreamWatchCommentary supports vision-fallback text utterance path", async () => {
  let utterance = "";
  const session = createSession({
    mode: "voice_agent",
    realtimeClient: {
      requestTextUtterance(prompt) {
        utterance = String(prompt || "");
      }
    },
    streamWatch: {
      active: true,
      targetUserId: "user-1",
      requestedByUserId: "user-1",
      lastFrameAt: Date.now(),
      lastCommentaryAt: 0,
      ingestedFrameCount: 0,
      acceptedFrameCountInWindow: 0,
      frameWindowStartedAt: 0,
      latestFrameMimeType: "image/png",
      latestFrameDataBase64: "AAAA",
      latestFrameAt: Date.now()
    }
  });
  const { manager, actions, createdResponses } = createManager({
    session,
    llm: {
      isProviderConfigured(provider) {
        return provider === "anthropic";
      },
      async generate() {
        return {
          text: "looks like a wild clutch moment",
          provider: "anthropic",
          model: "claude-haiku-4-5"
        };
      }
    }
  });

  await maybeTriggerStreamWatchCommentary(manager, {
    session,
    settings: createSettings(),
    streamerUserId: "user-1",
    source: "unit_test"
  });

  assert.equal(utterance.length > 0, true);
  assert.equal(createdResponses.length, 1);
  const logged = actions.find((entry) => entry.content === "stream_watch_commentary_requested");
  assert.equal(Boolean(logged), true);
  assert.equal(logged?.metadata?.commentaryPath, "vision_fallback_text_utterance");
  assert.equal(logged?.metadata?.visionProvider, "anthropic");
});

test("maybeTriggerStreamWatchCommentary forces anthropic keyframe fallback when configured", async () => {
  let requestVideoCommentaryCalls = 0;
  let requestTextUtteranceCalls = 0;
  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: false,
    realtimeClient: {
      appendInputVideoFrame() {},
      requestVideoCommentary() {
        requestVideoCommentaryCalls += 1;
      },
      requestTextUtterance() {
        requestTextUtteranceCalls += 1;
      }
    },
    streamWatch: {
      active: true,
      targetUserId: "user-1",
      requestedByUserId: "user-1",
      lastFrameAt: Date.now(),
      lastCommentaryAt: 0,
      ingestedFrameCount: 0,
      acceptedFrameCountInWindow: 0,
      frameWindowStartedAt: 0,
      latestFrameMimeType: "image/png",
      latestFrameDataBase64: "AAAA",
      latestFrameAt: Date.now()
    }
  });
  const settings = createSettings({
    voice: {
      streamWatch: {
        commentaryPath: "anthropic_keyframes"
      }
    }
  });
  const { manager, actions } = createManager({
    session,
    settings,
    llm: {
      isProviderConfigured(provider) {
        return provider === "anthropic";
      },
      async generate() {
        return {
          text: "looks like a close fight on screen",
          provider: "anthropic",
          model: "claude-haiku-4-5"
        };
      }
    }
  });

  await maybeTriggerStreamWatchCommentary(manager, {
    session,
    settings,
    streamerUserId: "user-1",
    source: "unit_test"
  });

  assert.equal(requestVideoCommentaryCalls, 0);
  assert.equal(requestTextUtteranceCalls, 1);
  const logged = actions.find((entry) => entry.content === "stream_watch_commentary_requested");
  assert.equal(logged?.metadata?.configuredCommentaryPath, "anthropic_keyframes");
});

test("maybeTriggerStreamWatchCommentary skips while playback queue is busy", async () => {
  let requestTextUtteranceCalls = 0;
  const session = createSession({
    mode: "voice_agent",
    botTurnOpen: true,
    realtimeClient: {
      requestTextUtterance() {
        requestTextUtteranceCalls += 1;
      }
    },
    streamWatch: {
      active: true,
      targetUserId: "user-1",
      requestedByUserId: "user-1",
      lastFrameAt: Date.now(),
      lastCommentaryAt: 0,
      ingestedFrameCount: 0,
      acceptedFrameCountInWindow: 0,
      frameWindowStartedAt: 0,
      latestFrameMimeType: "image/png",
      latestFrameDataBase64: "AAAA",
      latestFrameAt: Date.now()
    },
    audioPlaybackQueue: {
      chunks: [],
      headOffset: 0,
      queuedBytes: 96_000,
      pumping: false,
      timer: null,
      waitingDrain: false,
      drainHandler: null
    }
  });
  const { manager, actions, createdResponses } = createManager({
    session,
    llm: {
      isProviderConfigured(provider) {
        return provider === "anthropic";
      }
    }
  });

  await maybeTriggerStreamWatchCommentary(manager, {
    session,
    settings: createSettings(),
    streamerUserId: "user-1",
    source: "unit_test"
  });

  assert.equal(requestTextUtteranceCalls, 0);
  assert.equal(createdResponses.length, 0);
  assert.equal(actions.some((entry) => entry.content === "stream_watch_commentary_requested"), false);
});
