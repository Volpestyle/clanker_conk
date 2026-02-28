import { test } from "bun:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { VoiceSessionManager } from "./voiceSessionManager.ts";
import {
  AUDIO_PLAYBACK_QUEUE_HARD_MAX_BYTES,
  BARGE_IN_MIN_SPEECH_MS,
  DISCORD_PCM_FRAME_BYTES
} from "./voiceSessionManager.constants.ts";

function createManager() {
  const messages = [];
  const endCalls = [];
  const touchCalls = [];
  const offCalls = [];
  const logs = [];

  const client = {
    on() {},
    off(eventName) {
      offCalls.push(eventName);
    },
    guilds: { cache: new Map() },
    users: { cache: new Map() },
    user: { id: "bot-user", username: "clanker conk" }
  };

  const manager = new VoiceSessionManager({
    client,
    store: {
      logAction(entry) {
        logs.push(entry);
      },
      getSettings() {
        return {
          botName: "clanker conk"
        };
      }
    },
    appConfig: {},
    llm: {
      async generate() {
        return {
          text: "NO"
        };
      }
    },
    memory: null
  });

  manager.sendOperationalMessage = async (payload) => {
    messages.push(payload);
  };
  manager.endSession = async (payload) => {
    endCalls.push(payload);
  };
  manager.touchActivity = (guildId, settings) => {
    touchCalls.push({ guildId, settings });
  };

  return {
    manager,
    messages,
    endCalls,
    touchCalls,
    offCalls,
    logs
  };
}

function createMessage(overrides = {}) {
  return {
    guild: {
      id: "guild-1"
    },
    channel: {
      id: "text-1"
    },
    channelId: "text-1",
    author: {
      id: "user-1"
    },
    id: "msg-1",
    ...overrides
  };
}

function createSession(overrides = {}) {
  const now = Date.now();
  return {
    id: "session-1",
    guildId: "guild-1",
    voiceChannelId: "voice-1",
    textChannelId: "text-1",
    startedAt: now - 60_000,
    lastActivityAt: now - 2_000,
    maxEndsAt: now + 120_000,
    inactivityEndsAt: now + 45_000,
    userCaptures: new Map(),
    soundboard: {
      playCount: 0,
      lastPlayedAt: 0
    },
    mode: "stt_pipeline",
    streamWatch: {
      active: false,
      targetUserId: null,
      requestedByUserId: null,
      lastFrameAt: 0,
      lastCommentaryAt: 0,
      ingestedFrameCount: 0
    },
    pendingSttTurns: 0,
    recentVoiceTurns: [],
    membershipEvents: [],
    cleanupHandlers: [],
    realtimeProvider: null,
    realtimeInputSampleRateHz: 24000,
    realtimeOutputSampleRateHz: 24000,
    realtimeClient: null,
    settingsSnapshot: {
      botName: "clanker conk",
      voice: {
        enabled: true
      }
    },
    ...overrides
  };
}

test("getRuntimeState summarizes STT and realtime sessions", () => {
  const { manager } = createManager();
  const now = Date.now();

  manager.sessions.set(
    "guild-1",
    createSession({
      id: "stt-session",
      mode: "stt_pipeline",
      pendingSttTurns: 2,
      recentVoiceTurns: [{ role: "user", text: "hello" }],
      userCaptures: new Map([["user-a", {}]])
    })
  );
  manager.sessions.set(
    "guild-2",
    createSession({
      id: "realtime-session",
      guildId: "guild-2",
      voiceChannelId: "voice-2",
      textChannelId: "text-2",
      mode: "openai_realtime",
      streamWatch: {
        active: true,
        targetUserId: "user-z",
        requestedByUserId: "user-mod",
        lastFrameAt: now - 2_000,
        lastCommentaryAt: now - 4_000,
        ingestedFrameCount: 8
      },
      realtimeProvider: "openai",
      realtimeClient: {
        getState() {
          return { connected: true };
        }
      },
      recentVoiceTurns: [{ role: "user", text: "yo" }]
    })
  );

  const runtime = manager.getRuntimeState();
  assert.equal(runtime.activeCount, 2);

  const stt = runtime.sessions.find((row) => row.sessionId === "stt-session");
  assert.equal(stt?.stt?.pendingTurns, 2);
  assert.equal(stt?.realtime, null);

  const realtime = runtime.sessions.find((row) => row.sessionId === "realtime-session");
  assert.equal(realtime?.realtime?.provider, "openai");
  assert.deepEqual(realtime?.realtime?.state, { connected: true });
});

test("resolveSpeakingEndFinalizeDelayMs preserves baseline delays in low-load rooms", () => {
  const { manager } = createManager();
  const session = createSession({
    userCaptures: new Map([["speaker-1", {}]]),
    pendingSttTurns: 0
  });

  assert.equal(
    manager.resolveSpeakingEndFinalizeDelayMs({
      session,
      captureAgeMs: 120
    }),
    620
  );
  assert.equal(
    manager.resolveSpeakingEndFinalizeDelayMs({
      session,
      captureAgeMs: 600
    }),
    320
  );
  assert.equal(
    manager.resolveSpeakingEndFinalizeDelayMs({
      session,
      captureAgeMs: 1200
    }),
    140
  );
});

test("resolveSpeakingEndFinalizeDelayMs adapts delays when room load increases", () => {
  const { manager } = createManager();

  const busyRealtimeSession = createSession({
    mode: "openai_realtime",
    userCaptures: new Map([
      ["speaker-1", {}],
      ["speaker-2", {}]
    ]),
    realtimeTurnDrainActive: true,
    pendingRealtimeTurns: [{ userId: "speaker-3" }]
  });
  assert.equal(
    manager.resolveSpeakingEndFinalizeDelayMs({
      session: busyRealtimeSession,
      captureAgeMs: 500
    }),
    224
  );

  const heavySttSession = createSession({
    mode: "stt_pipeline",
    userCaptures: new Map([["speaker-1", {}]]),
    pendingSttTurns: 4
  });
  assert.equal(
    manager.resolveSpeakingEndFinalizeDelayMs({
      session: heavySttSession,
      captureAgeMs: 150
    }),
    310
  );
  assert.equal(
    manager.resolveSpeakingEndFinalizeDelayMs({
      session: heavySttSession,
      captureAgeMs: 1400
    }),
    100
  );
});

test("maybeInterruptBotForAssertiveSpeech requires sustained capture bytes", () => {
  const { manager, logs } = createManager();
  const session = createSession({
    botTurnOpen: true,
    userCaptures: new Map([
      [
        "user-1",
        {
          bytesSent: 4_000,
          speakingEndFinalizeTimer: null
        }
      ]
    ])
  });

  const interrupted = manager.maybeInterruptBotForAssertiveSpeech({
    session,
    userId: "user-1",
    source: "test"
  });
  assert.equal(interrupted, false);
  assert.equal(session.botTurnOpen, true);
  assert.equal(logs.some((entry) => entry?.content === "voice_barge_in_interrupt"), false);
});

test("maybeInterruptBotForAssertiveSpeech cuts playback after assertive speech", () => {
  const { manager, logs } = createManager();
  const stopCalls = [];
  let streamDestroyed = false;
  const minBytes = Math.ceil((24_000 * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000);
  const session = createSession({
    botTurnOpen: true,
    botTurnResetTimer: setTimeout(() => undefined, 10_000),
    userCaptures: new Map([
      [
        "user-1",
        {
          bytesSent: minBytes + 2_400,
          speakingEndFinalizeTimer: null
        }
      ]
    ]),
    audioPlayer: {
      stop(force) {
        stopCalls.push(force);
      }
    },
    botAudioStream: {
      destroy() {
        streamDestroyed = true;
      }
    },
    pendingResponse: {
      requestId: 9,
      requestedAt: Date.now() - 1200,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "turn_flush",
      handlingSilence: false,
      audioReceivedAt: 0
    },
    audioPlaybackQueue: {
      chunks: [Buffer.from([1, 2, 3])],
      headOffset: 0,
      queuedBytes: 777_600,
      pumping: false,
      timer: null,
      waitingDrain: false,
      drainHandler: null,
      lastWarnAt: 0
    }
  });

  const interrupted = manager.maybeInterruptBotForAssertiveSpeech({
    session,
    userId: "user-1",
    source: "test"
  });
  assert.equal(interrupted, true);
  assert.equal(session.botTurnOpen, false);
  assert.equal(session.audioPlaybackQueue.queuedBytes, 0);
  assert.equal(stopCalls.length, 1);
  assert.equal(stopCalls[0], true);
  assert.equal(streamDestroyed, true);
  assert.equal(Number(session.pendingResponse?.audioReceivedAt || 0) > 0, true);
  assert.equal(Number(session.bargeInSuppressionUntil || 0) > Date.now(), true);
  assert.equal(logs.some((entry) => entry?.content === "voice_barge_in_interrupt"), true);
});

test("enqueueDiscordPcmForPlayback trims oldest queued audio when hard cap is exceeded", () => {
  const { manager, logs } = createManager();
  manager.scheduleAudioPlaybackPump = () => {};
  const session = createSession({
    audioPlayer: {
      state: {
        status: "playing"
      }
    },
    connection: {
      subscribe() {}
    },
    botAudioStream: {
      writableLength: 0
    },
    audioPlaybackQueue: {
      chunks: [],
      headOffset: 0,
      queuedBytes: 0,
      pumping: false,
      timer: null,
      waitingDrain: false,
      drainHandler: null,
      lastWarnAt: 0,
      lastTrimAt: 0
    }
  });

  const oversizedChunk = Buffer.alloc(AUDIO_PLAYBACK_QUEUE_HARD_MAX_BYTES + DISCORD_PCM_FRAME_BYTES * 3, 7);
  const queued = manager.enqueueDiscordPcmForPlayback({
    session,
    discordPcm: oversizedChunk
  });

  assert.equal(queued, true);
  assert.equal(session.audioPlaybackQueue.queuedBytes, AUDIO_PLAYBACK_QUEUE_HARD_MAX_BYTES);
  const trimLog = logs.find((entry) => entry?.content === "bot_audio_queue_trimmed");
  assert.equal(Boolean(trimLog), true);
  assert.equal(trimLog?.metadata?.hardMaxBufferedBytes, AUDIO_PLAYBACK_QUEUE_HARD_MAX_BYTES);
  assert.equal(trimLog?.metadata?.droppedBytes > 0, true);
});

test("bindBotAudioStreamLifecycle records stream close event", () => {
  const { manager, logs } = createManager();
  const stream = new PassThrough();
  const session = createSession();

  manager.bindBotAudioStreamLifecycle(session, {
    stream,
    source: "test_bind"
  });
  stream.emit("close");

  const lifecycleLog = logs.find(
    (entry) => entry?.content === "bot_audio_stream_lifecycle" && entry?.metadata?.source === "test_bind"
  );
  assert.equal(Boolean(lifecycleLog), true);
  assert.equal(lifecycleLog?.metadata?.event, "close");
});

test("evaluateVoiceThoughtLoopGate waits for silence window and queue cooldown", () => {
  const { manager } = createManager();
  const now = Date.now();
  const session = createSession({
    lastActivityAt: now - 5_000,
    lastThoughtAttemptAt: 0
  });

  const blockedBySilence = manager.evaluateVoiceThoughtLoopGate({
    session,
    settings: {
      voice: {
        replyEagerness: 100,
        thoughtEngine: {
          enabled: true,
          eagerness: 100,
          minSilenceSeconds: 20,
          minSecondsBetweenThoughts: 20
        }
      }
    },
    now
  });
  assert.equal(blockedBySilence.allow, false);
  assert.equal(blockedBySilence.reason, "silence_window_not_met");

  const allowed = manager.evaluateVoiceThoughtLoopGate({
    session: {
      ...session,
      lastActivityAt: now - 25_000
    },
    settings: {
      voice: {
        replyEagerness: 100,
        thoughtEngine: {
          enabled: true,
          eagerness: 100,
          minSilenceSeconds: 20,
          minSecondsBetweenThoughts: 20
        }
      }
    },
    now
  });
  assert.equal(allowed.allow, true);
  assert.equal(allowed.reason, "ok");
});

test("maybeRunVoiceThoughtLoop speaks approved thought candidates", async () => {
  const { manager } = createManager();
  const now = Date.now();
  const settings = {
    botName: "clanker conk",
    voice: {
      enabled: true,
      replyEagerness: 100,
      thoughtEngine: {
        enabled: true,
        provider: "anthropic",
        model: "claude-haiku-4-5",
        eagerness: 100,
        minSilenceSeconds: 20,
        minSecondsBetweenThoughts: 20
      }
    }
  };
  const session = createSession({
    mode: "stt_pipeline",
    lastActivityAt: now - 25_000,
    settingsSnapshot: settings
  });

  const scheduledDelays = [];
  manager.scheduleVoiceThoughtLoop = ({ delayMs }) => {
    scheduledDelays.push(delayMs);
  };
  manager.generateVoiceThoughtCandidate = async () => "did you know octopuses have three hearts";
  manager.evaluateVoiceThoughtDecision = async () => ({
    allow: true,
    reason: "llm_yes"
  });
  let delivered = 0;
  manager.deliverVoiceThoughtCandidate = async () => {
    delivered += 1;
    return true;
  };

  const originalRandom = Math.random;
  Math.random = () => 0.01;
  try {
    const ran = await manager.maybeRunVoiceThoughtLoop({
      session,
      settings,
      trigger: "test"
    });
    assert.equal(ran, true);
    assert.equal(delivered, 1);
    assert.equal(session.lastThoughtSpokenAt > 0, true);
    assert.equal(scheduledDelays.length, 1);
    assert.equal(scheduledDelays[0], 20_000);
  } finally {
    Math.random = originalRandom;
  }
});

test("maybeRunVoiceThoughtLoop skips generation when eagerness probability roll fails", async () => {
  const { manager } = createManager();
  const settings = {
    botName: "clanker conk",
    voice: {
      enabled: true,
      replyEagerness: 10,
      thoughtEngine: {
        enabled: true,
        provider: "anthropic",
        model: "claude-haiku-4-5",
        eagerness: 10,
        minSilenceSeconds: 20,
        minSecondsBetweenThoughts: 20
      }
    }
  };
  const session = createSession({
    mode: "stt_pipeline",
    lastActivityAt: Date.now() - 25_000,
    settingsSnapshot: settings
  });

  manager.scheduleVoiceThoughtLoop = () => {};
  manager.generateVoiceThoughtCandidate = async () => {
    throw new Error("thought generation should not run when probability gate fails");
  };

  const originalRandom = Math.random;
  Math.random = () => 0.95;
  try {
    const ran = await manager.maybeRunVoiceThoughtLoop({
      session,
      settings,
      trigger: "test"
    });
    assert.equal(ran, false);
    assert.equal(session.lastThoughtAttemptAt > 0, true);
  } finally {
    Math.random = originalRandom;
  }
});

test("requestStatus reports offline and online states", async () => {
  const { manager, messages } = createManager();

  const offline = await manager.requestStatus({
    message: createMessage(),
    settings: { voice: { enabled: true } }
  });
  assert.equal(offline, true);
  assert.equal(messages.at(-1)?.reason, "offline");

  manager.sessions.set(
    "guild-1",
    createSession({
      userCaptures: new Map([
        ["user-a", {}],
        ["user-b", {}]
      ]),
      streamWatch: {
        active: true,
        targetUserId: "user-a",
        requestedByUserId: "user-mod",
        lastFrameAt: Date.now() - 1_000,
        lastCommentaryAt: Date.now() - 2_000,
        ingestedFrameCount: 3
      }
    })
  );

  const online = await manager.requestStatus({
    message: createMessage({
      content: "clankie r u in vc rn?"
    }),
    settings: null
  });
  assert.equal(online, true);
  assert.equal(messages.at(-1)?.reason, "online");
  assert.equal(messages.at(-1)?.details?.activeCaptures, 2);
  assert.equal(messages.at(-1)?.details?.streamWatchActive, true);
  assert.equal(messages.at(-1)?.details?.requestText, "clankie r u in vc rn?");
});

test("requestLeave sends not_in_voice or ends active session", async () => {
  const { manager, messages, endCalls } = createManager();

  const withoutSession = await manager.requestLeave({
    message: createMessage(),
    settings: {}
  });
  assert.equal(withoutSession, true);
  assert.equal(messages.at(-1)?.reason, "not_in_voice");

  manager.sessions.set("guild-1", createSession());
  const withSession = await manager.requestLeave({
    message: createMessage(),
    settings: {},
    reason: "manual_leave"
  });
  assert.equal(withSession, true);
  assert.equal(endCalls.length, 1);
  assert.equal(endCalls[0]?.reason, "manual_leave");
});

test("withJoinLock serializes join operations per guild key", async () => {
  const { manager } = createManager();
  const order = [];

  const first = manager.withJoinLock("guild-1", async () => {
    order.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("first:end");
    return "first";
  });
  const second = manager.withJoinLock("guild-1", async () => {
    order.push("second:run");
    return "second";
  });

  const results = await Promise.all([first, second]);
  assert.deepEqual(results, ["first", "second"]);
  assert.deepEqual(order, ["first:start", "first:end", "second:run"]);
  assert.equal(manager.joinLocks.size, 0);
});

test("reconcileSettings ends blocked sessions and touches allowed sessions", async () => {
  const { manager, endCalls, touchCalls } = createManager();

  manager.sessions.set(
    "guild-blocked",
    createSession({
      guildId: "guild-blocked",
      voiceChannelId: "voice-blocked"
    })
  );
  manager.sessions.set(
    "guild-allowed",
    createSession({
      guildId: "guild-allowed",
      voiceChannelId: "voice-allowed"
    })
  );
  manager.sessions.set(
    "guild-not-allowlisted",
    createSession({
      guildId: "guild-not-allowlisted",
      voiceChannelId: "voice-other"
    })
  );

  await manager.reconcileSettings({
    voice: {
      enabled: true,
      blockedVoiceChannelIds: ["voice-blocked"],
      allowedVoiceChannelIds: ["voice-allowed"]
    }
  });

  assert.equal(endCalls.length, 2);
  assert.deepEqual(
    endCalls.map((entry) => entry.reason).sort(),
    ["settings_channel_blocked", "settings_channel_not_allowlisted"]
  );
  assert.equal(touchCalls.length, 1);
  assert.equal(touchCalls[0]?.guildId, "guild-allowed");
});

test("handleVoiceStateUpdate records join/leave membership events and refreshes realtime instructions", async () => {
  const { manager, logs } = createManager();
  const refreshCalls = [];
  manager.scheduleOpenAiRealtimeInstructionRefresh = (payload) => {
    refreshCalls.push(payload);
  };

  const session = createSession({
    mode: "openai_realtime",
    membershipEvents: []
  });
  manager.sessions.set("guild-1", session);

  await manager.handleVoiceStateUpdate(
    {
      id: "user-2",
      guild: { id: "guild-1" },
      channelId: null,
      member: {
        user: { bot: false, username: "bob_user" },
        displayName: "bob"
      }
    },
    {
      id: "user-2",
      guild: { id: "guild-1" },
      channelId: "voice-1",
      member: {
        user: { bot: false, username: "bob_user" },
        displayName: "bob"
      }
    }
  );

  await manager.handleVoiceStateUpdate(
    {
      id: "user-2",
      guild: { id: "guild-1" },
      channelId: "voice-1",
      member: {
        user: { bot: false, username: "bob_user" },
        displayName: "bob"
      }
    },
    {
      id: "user-2",
      guild: { id: "guild-1" },
      channelId: null,
      member: {
        user: { bot: false, username: "bob_user" },
        displayName: "bob"
      }
    }
  );

  assert.equal(Array.isArray(session.membershipEvents), true);
  assert.equal(session.membershipEvents.length, 2);
  assert.equal(session.membershipEvents[0]?.eventType, "join");
  assert.equal(session.membershipEvents[1]?.eventType, "leave");
  assert.equal(session.membershipEvents[0]?.displayName, "bob");
  assert.equal(session.membershipEvents[1]?.displayName, "bob");

  assert.equal(refreshCalls.length, 2);
  assert.equal(refreshCalls[0]?.reason, "voice_membership_changed");
  assert.equal(refreshCalls[1]?.reason, "voice_membership_changed");
  assert.equal(refreshCalls[0]?.speakerUserId, "user-2");
  assert.equal(refreshCalls[1]?.speakerUserId, "user-2");

  const membershipLogs = logs.filter((entry) => entry?.content === "voice_membership_changed");
  assert.equal(membershipLogs.length, 2);
  assert.equal(membershipLogs[0]?.metadata?.eventType, "join");
  assert.equal(membershipLogs[1]?.metadata?.eventType, "leave");
});

test("dispose detaches handlers and clears join locks", async () => {
  const { manager, offCalls } = createManager();
  manager.joinLocks.set("guild-1", Promise.resolve());
  manager.sessions.set("guild-1", createSession());

  await manager.dispose("shutdown");

  assert.equal(offCalls.includes("voiceStateUpdate"), true);
  assert.equal(manager.joinLocks.size, 0);
});
