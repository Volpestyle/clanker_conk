import test from "node:test";
import assert from "node:assert/strict";
import { VoiceSessionManager } from "./voiceSessionManager.ts";

function createManager() {
  const logs = [];
  const client = {
    on() {},
    off() {},
    guilds: { cache: new Map() },
    users: { cache: new Map() },
    user: { id: "bot-user", username: "clanker conk" }
  };
  const store = {
    logAction(entry) {
      logs.push(entry);
    },
    getSettings() {
      return {
        botName: "clanker conk"
      };
    }
  };

  const manager = new VoiceSessionManager({
    client,
    store,
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

  return { manager, logs };
}

function createRealtimeSession(overrides = {}) {
  return {
    id: "session-1",
    guildId: "guild-1",
    textChannelId: "text-1",
    mode: "openai_realtime",
    ending: false,
    realtimeInputSampleRateHz: 24_000,
    realtimeOutputSampleRateHz: 24_000,
    pendingRealtimeInputBytes: 0,
    nextResponseRequestId: 0,
    lastResponseRequestAt: 0,
    lastAudioDeltaAt: 0,
    lastInboundAudioAt: 0,
    responseWatchdogTimer: null,
    responseDoneGraceTimer: null,
    pendingResponse: null,
    userCaptures: new Map(),
    settingsSnapshot: {
      botName: "clanker conk"
    },
    realtimeClient: {
      createAudioResponse() {},
      commitInputAudioBuffer() {},
      isResponseInProgress() {
        return false;
      }
    },
    ...overrides
  };
}

test("createTrackedAudioResponse sets pending response and arms watchdog", () => {
  const { manager } = createManager();
  const session = createRealtimeSession({
    pendingResponse: {
      requestId: 2,
      userId: "legacy-user",
      requestedAt: Date.now() - 50,
      retryCount: 1,
      hardRecoveryAttempted: true,
      source: "legacy",
      handlingSilence: false,
      audioReceivedAt: 0
    },
    nextResponseRequestId: 2
  });

  let createCalls = 0;
  session.realtimeClient.createAudioResponse = () => {
    createCalls += 1;
  };

  let watchdogArgs = null;
  manager.armResponseSilenceWatchdog = (args) => {
    watchdogArgs = args;
  };

  const created = manager.createTrackedAudioResponse({
    session,
    userId: "user-1",
    source: "turn_flush",
    resetRetryState: true
  });

  assert.equal(created, true);
  assert.equal(createCalls, 1);
  assert.equal(session.pendingResponse?.requestId, 3);
  assert.equal(session.pendingResponse?.userId, "user-1");
  assert.equal(session.pendingResponse?.retryCount, 0);
  assert.equal(session.pendingResponse?.hardRecoveryAttempted, false);
  assert.equal(session.pendingResponse?.source, "turn_flush");
  assert.equal(session.pendingResponse?.handlingSilence, false);
  assert.equal(session.lastResponseRequestAt > 0, true);
  assert.deepEqual(watchdogArgs, {
    session,
    requestId: 3,
    userId: "user-1"
  });
});

test("createTrackedAudioResponse skips duplicate openai response creation when active", () => {
  const { manager, logs } = createManager();
  const session = createRealtimeSession({
    realtimeClient: {
      createAudioResponse() {
        throw new Error("should_not_be_called");
      },
      isResponseInProgress() {
        return true;
      }
    }
  });

  const created = manager.createTrackedAudioResponse({
    session,
    userId: "user-1",
    emitCreateEvent: true
  });

  assert.equal(created, false);
  assert.equal(session.pendingResponse, null);
  assert.equal(logs.some((entry) => String(entry.content).includes("response_create_skipped_active_response")), true);
});

test("armResponseSilenceWatchdog clears previous timer and dispatches watchdog handling", async () => {
  const { manager } = createManager();
  const session = createRealtimeSession({
    responseWatchdogTimer: { id: "old-timer" },
    pendingResponse: {
      requestId: 4,
      userId: "user-4",
      requestedAt: Date.now() - 1_000,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "turn_flush",
      handlingSilence: false,
      audioReceivedAt: 0
    }
  });

  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let scheduledFn = null;
  const cleared = [];
  globalThis.setTimeout = (fn) => {
    scheduledFn = fn;
    return { id: "new-timer" };
  };
  globalThis.clearTimeout = (timer) => {
    cleared.push(timer);
  };

  const handled = [];
  manager.handleSilentResponse = async (args) => {
    handled.push(args);
  };

  try {
    manager.armResponseSilenceWatchdog({
      session,
      requestId: 4,
      userId: "fallback-user"
    });
    assert.deepEqual(cleared, [{ id: "old-timer" }]);
    assert.equal(typeof scheduledFn, "function");
    assert.deepEqual(session.responseWatchdogTimer, { id: "new-timer" });

    await scheduledFn();
    assert.equal(session.responseWatchdogTimer, null);
    assert.equal(handled.length, 1);
    assert.equal(handled[0]?.trigger, "watchdog");
    assert.equal(handled[0]?.userId, "user-4");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("armResponseSilenceWatchdog clears pending response when audio already arrived", () => {
  const { manager } = createManager();
  const requestedAt = Date.now() - 1_500;
  const session = createRealtimeSession({
    pendingResponse: {
      requestId: 9,
      userId: "user-9",
      requestedAt,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "turn_flush",
      handlingSilence: false,
      audioReceivedAt: 0
    },
    lastAudioDeltaAt: requestedAt + 1
  });

  const originalSetTimeout = globalThis.setTimeout;
  let scheduledFn = null;
  globalThis.setTimeout = (fn) => {
    scheduledFn = fn;
    return { id: "watchdog" };
  };
  try {
    manager.armResponseSilenceWatchdog({
      session,
      requestId: 9,
      userId: "user-9"
    });
    scheduledFn();
    assert.equal(session.pendingResponse, null);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("handleSilentResponse replaces pending response when newer inbound audio exists", async () => {
  const { manager, logs } = createManager();
  const requestedAt = Date.now() - 5_000;
  const session = createRealtimeSession({
    pendingResponse: {
      requestId: 7,
      userId: "speaker-7",
      requestedAt,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "turn_flush",
      handlingSilence: false,
      audioReceivedAt: 0
    },
    lastInboundAudioAt: requestedAt + 200
  });

  const scheduled = [];
  manager.scheduleResponseFromBufferedAudio = (args) => {
    scheduled.push(args);
  };

  await manager.handleSilentResponse({
    session,
    userId: "fallback-user",
    trigger: "watchdog"
  });

  assert.equal(session.pendingResponse, null);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]?.userId, "speaker-7");
  assert.equal(logs.some((entry) => String(entry.content).includes("pending_response_replaced_by_newer_input")), true);
});

test("handleSilentResponse retries silent response and rearms watchdog when create is skipped", async () => {
  const { manager, logs } = createManager();
  const session = createRealtimeSession({
    pendingResponse: {
      requestId: 8,
      userId: "speaker-8",
      requestedAt: Date.now() - 8_000,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "turn_flush",
      handlingSilence: false,
      audioReceivedAt: 0
    }
  });

  manager.createTrackedAudioResponse = () => false;
  let rearmArgs = null;
  manager.armResponseSilenceWatchdog = (args) => {
    rearmArgs = args;
  };

  await manager.handleSilentResponse({
    session,
    userId: "fallback-user",
    trigger: "watchdog"
  });

  assert.equal(session.pendingResponse?.retryCount, 1);
  assert.equal(session.pendingResponse?.handlingSilence, false);
  assert.equal(rearmArgs?.requestId, 8);
  assert.equal(logs.some((entry) => String(entry.content).includes("response_silent_retry")), true);
});

test("handleSilentResponse ends session when retry path throws", async () => {
  const { manager, logs } = createManager();
  const session = createRealtimeSession({
    pendingResponse: {
      requestId: 10,
      userId: "speaker-10",
      requestedAt: Date.now() - 10_000,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "turn_flush",
      handlingSilence: false,
      audioReceivedAt: 0
    }
  });

  manager.createTrackedAudioResponse = () => {
    throw new Error("retry create failed");
  };
  const endCalls = [];
  manager.endSession = async (payload) => {
    endCalls.push(payload);
  };

  await manager.handleSilentResponse({
    session,
    userId: "fallback-user",
    trigger: "watchdog"
  });

  assert.equal(session.pendingResponse, null);
  assert.equal(endCalls.length, 1);
  assert.equal(endCalls[0]?.reason, "response_stalled");
  assert.equal(logs.some((entry) => String(entry.content).includes("response_retry_failed")), true);
});

test("handleSilentResponse attempts hard recovery and commits buffered audio", async () => {
  const { manager, logs } = createManager();
  let commitCalls = 0;
  const session = createRealtimeSession({
    pendingRealtimeInputBytes: 200_000,
    pendingResponse: {
      requestId: 11,
      userId: "speaker-11",
      requestedAt: Date.now() - 12_000,
      retryCount: 2,
      hardRecoveryAttempted: false,
      source: "turn_flush",
      handlingSilence: false,
      audioReceivedAt: 0
    },
    realtimeClient: {
      createAudioResponse() {},
      commitInputAudioBuffer() {
        commitCalls += 1;
      },
      isResponseInProgress() {
        return false;
      }
    }
  });

  manager.createTrackedAudioResponse = () => false;
  let rearmArgs = null;
  manager.armResponseSilenceWatchdog = (args) => {
    rearmArgs = args;
  };

  await manager.handleSilentResponse({
    session,
    userId: "fallback-user",
    trigger: "watchdog"
  });

  assert.equal(commitCalls, 1);
  assert.equal(session.pendingRealtimeInputBytes, 0);
  assert.equal(session.pendingResponse?.hardRecoveryAttempted, true);
  assert.equal(session.pendingResponse?.handlingSilence, false);
  assert.equal(rearmArgs?.requestId, 11);
  assert.equal(logs.some((entry) => String(entry.content).includes("response_silent_hard_recovery")), true);
});

test("handleSilentResponse clears stuck pending response after hard-recovery fallback", async () => {
  const { manager, logs } = createManager();
  const session = createRealtimeSession({
    pendingResponse: {
      requestId: 12,
      userId: "speaker-12",
      requestedAt: Date.now() - 15_000,
      retryCount: 2,
      hardRecoveryAttempted: true,
      source: "turn_flush",
      handlingSilence: false,
      audioReceivedAt: 0
    }
  });

  await manager.handleSilentResponse({
    session,
    userId: "fallback-user",
    trigger: "watchdog"
  });

  assert.equal(session.pendingResponse, null);
  assert.equal(logs.some((entry) => String(entry.content).includes("response_silent_fallback")), true);
});

test("clearPendingResponse clears watchdog and done-grace timers", () => {
  const { manager } = createManager();
  const session = createRealtimeSession({
    responseWatchdogTimer: { id: "watchdog-timer" },
    responseDoneGraceTimer: { id: "done-grace-timer" },
    pendingResponse: {
      requestId: 13,
      userId: "speaker-13",
      requestedAt: Date.now() - 1_000,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "turn_flush",
      handlingSilence: false,
      audioReceivedAt: 0
    }
  });

  const originalClearTimeout = globalThis.clearTimeout;
  const cleared = [];
  globalThis.clearTimeout = (timer) => {
    cleared.push(timer);
  };
  try {
    manager.clearPendingResponse(session);
    assert.equal(session.pendingResponse, null);
    assert.equal(session.responseWatchdogTimer, null);
    assert.equal(session.responseDoneGraceTimer, null);
    assert.deepEqual(cleared, [{ id: "watchdog-timer" }, { id: "done-grace-timer" }]);
  } finally {
    globalThis.clearTimeout = originalClearTimeout;
  }
});
