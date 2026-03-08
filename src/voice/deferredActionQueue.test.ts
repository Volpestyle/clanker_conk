import { test } from "bun:test";
import assert from "node:assert/strict";
import { DeferredActionQueue } from "./deferredActionQueue.ts";
import type {
  DeferredQueuedUserTurn,
  OutputChannelState,
  VoiceSession
} from "./voiceSessionTypes.ts";

function createSession(overrides: Partial<VoiceSession> = {}): VoiceSession {
  return {
    id: "session-1",
    guildId: "guild-1",
    voiceChannelId: "voice-1",
    textChannelId: "text-1",
    requestedByUserId: "user-1",
    mode: "openai_realtime",
    realtimeProvider: "openai",
    realtimeInputSampleRateHz: 24_000,
    realtimeOutputSampleRateHz: 24_000,
    recentVoiceTurns: [],
    transcriptTurns: [],
    modelContextSummary: { generation: null, decider: null },
    voxClient: null,
    realtimeClient: null,
    startedAt: 0,
    lastActivityAt: 0,
    maxEndsAt: null,
    inactivityEndsAt: null,
    maxTimer: null,
    inactivityTimer: null,
    botTurnResetTimer: null,
    botTurnOpen: false,
    bargeInSuppressionUntil: 0,
    bargeInSuppressedAudioChunks: 0,
    bargeInSuppressedAudioBytes: 0,
    lastBotActivityTouchAt: 0,
    responseFlushTimer: null,
    responseWatchdogTimer: null,
    responseDoneGraceTimer: null,
    botDisconnectTimer: null,
    lastResponseRequestAt: 0,
    lastAudioDeltaAt: 0,
    lastAssistantReplyAt: 0,
    lastDirectAddressAt: 0,
    lastDirectAddressUserId: null,
    musicWakeLatchedUntil: 0,
    musicWakeLatchedByUserId: null,
    lastInboundAudioAt: 0,
    realtimeReplySupersededCount: 0,
    pendingRealtimeInputBytes: 0,
    nextResponseRequestId: 1,
    pendingResponse: null,
    activeReplyInterruptionPolicy: null,
    lastRequestedRealtimeUtterance: null,
    pendingSttTurns: [],
    sttTurnDrainActive: false,
    pendingSttTurnsQueue: [],
    realtimeTurnDrainActive: false,
    pendingRealtimeTurns: [],
    openAiAsrSessions: new Map(),
    perUserAsrEnabled: false,
    sharedAsrEnabled: false,
    openAiSharedAsrState: null,
    openAiPerUserAsrModel: "",
    openAiPerUserAsrLanguage: "",
    openAiPerUserAsrPrompt: "",
    openAiPendingToolCalls: new Map(),
    openAiToolCallExecutions: new Map(),
    openAiToolResponseDebounceTimer: null,
    openAiCompletedToolCallIds: new Map(),
    lastOpenAiAssistantAudioItemId: null,
    lastOpenAiAssistantAudioItemContentIndex: 0,
    lastOpenAiAssistantAudioItemReceivedMs: 0,
    openAiToolDefinitions: [],
    lastOpenAiRealtimeToolHash: "",
    lastOpenAiRealtimeToolRefreshAt: 0,
    lastOpenAiToolCallerUserId: null,
    awaitingToolOutputs: false,
    toolCallEvents: [],
    mcpStatus: [],
    toolMusicTrackCatalog: new Map(),
    memoryWriteWindow: [],
    voiceCommandState: null,
    musicQueueState: { tracks: [], cursor: -1, version: 0 },
    assistantOutput: {
      phase: "idle",
      reason: "idle",
      phaseEnteredAt: 0,
      lastSyncedAt: 0,
      requestId: null,
      ttsPlaybackState: "idle",
      ttsBufferedSamples: 0,
      lastTrigger: null
    },
    thoughtLoopTimer: null,
    thoughtLoopBusy: false,
    nextThoughtAt: 0,
    lastThoughtAttemptAt: 0,
    lastThoughtSpokenAt: 0,
    userCaptures: new Map(),
    streamWatch: {
      active: false,
      targetUserId: null,
      requestedByUserId: null,
      channelId: null,
      startedAt: 0,
      commentPending: false,
      lastFrameAt: 0,
      lastCommentaryAt: 0,
      lastCommentaryNote: null,
      lastMemoryRecapAt: 0,
      lastMemoryRecapText: null,
      lastMemoryRecapDurableSaved: false,
      lastMemoryRecapReason: null,
      latestFrameAt: 0,
      latestFrameMimeType: null,
      latestFrameDataBase64: null,
      acceptedFrameCountInWindow: 0,
      frameWindowStartedAt: 0,
      lastBrainContextAt: 0,
      lastBrainContextProvider: null,
      lastBrainContextModel: null,
      brainContextEntries: [],
      ingestedFrameCount: 0
    },
    music: {
      phase: "idle",
      active: false,
      ducked: false,
      pauseReason: null,
      startedAt: 0,
      stoppedAt: 0,
      provider: null,
      source: null,
      lastTrackId: null,
      lastTrackTitle: null,
      lastTrackArtists: [],
      lastTrackUrl: null,
      lastQuery: null,
      lastRequestedByUserId: null,
      lastRequestText: null,
      lastCommandAt: 0,
      lastCommandReason: null,
      pendingQuery: null,
      pendingPlatform: null,
      pendingResults: [],
      pendingRequestedByUserId: null,
      pendingRequestedAt: 0
    },
    soundboard: { playCount: 0, lastPlayedAt: 0 },
    latencyStages: [],
    membershipEvents: [],
    voiceLookupBusyCount: 0,
    lastSuppressedCaptureLogAt: 0,
    baseVoiceInstructions: "",
    lastOpenAiRealtimeInstructions: "",
    lastOpenAiRealtimeInstructionsAt: 0,
    realtimeInstructionRefreshTimer: null,
    openAiTurnContextRefreshState: { pending: false, lastStartedAt: 0, lastCompletedAt: 0, lastSkippedReason: null },
    settingsSnapshot: null,
    cleanupHandlers: [],
    ending: false,
    deferredVoiceActions: {},
    deferredVoiceActionTimers: {},
    ...overrides
  } as VoiceSession;
}

function createQueuedTurn(overrides: Partial<DeferredQueuedUserTurn> = {}): DeferredQueuedUserTurn {
  return {
    userId: "user-1",
    transcript: "hello there",
    pcmBuffer: Buffer.alloc(960, 1),
    captureReason: "stream_end",
    source: "test",
    directAddressed: true,
    deferReason: "output_locked",
    flushDelayMs: 0,
    queuedAt: Date.now(),
    ...overrides
  };
}

function createOutputState(overrides: Partial<OutputChannelState> = {}): OutputChannelState {
  return {
    phase: "idle",
    locked: false,
    lockReason: null,
    musicActive: false,
    captureBlocking: false,
    bargeInSuppressed: false,
    turnBacklog: 0,
    toolCallsRunning: false,
    botTurnOpen: false,
    bufferedBotSpeech: false,
    pendingResponse: false,
    openAiActiveResponse: false,
    awaitingToolOutputs: false,
    streamBufferedBytes: 0,
    deferredBlockReason: null,
    ...overrides
  };
}

function createQueueHost(outputState = createOutputState()) {
  const logs: Array<Record<string, unknown>> = [];
  const flushCalls: Array<Record<string, unknown>> = [];
  const scheduledFlushes: Array<Record<string, unknown>> = [];
  const utteranceCalls: Array<Record<string, unknown>> = [];
  let currentOutputState = outputState;

  const queue = new DeferredActionQueue({
    client: { user: { id: "bot-user" } },
    store: {
      logAction(entry) {
        logs.push(entry);
      }
    },
    getOutputChannelState() {
      return currentOutputState;
    },
    scheduleDeferredBotTurnOpenFlush(args) {
      scheduledFlushes.push(args as Record<string, unknown>);
    },
    flushDeferredBotTurnOpenTurns(args) {
      flushCalls.push(args as Record<string, unknown>);
    },
    normalizeReplyInterruptionPolicy(rawPolicy) {
      return rawPolicy;
    },
    requestRealtimeTextUtterance(args) {
      utteranceCalls.push(args as Record<string, unknown>);
      return true;
    },
    estimatePcm16MonoDurationMs(pcmByteLength, sampleRateHz = 24_000) {
      return Math.round((pcmByteLength / (sampleRateHz * 2)) * 1000);
    }
  });

  return {
    queue,
    logs,
    flushCalls,
    scheduledFlushes,
    utteranceCalls,
    setOutputState(nextState: OutputChannelState) {
      currentOutputState = nextState;
    }
  };
}

test("recheckDeferredVoiceActions flushes queued user turns when output becomes idle", () => {
  const { queue, flushCalls } = createQueueHost();
  const session = createSession();
  const queuedTurn = createQueuedTurn();

  queue.setDeferredVoiceAction(session, {
    type: "queued_user_turns",
    goal: "respond_to_deferred_user_turns",
    freshnessPolicy: "regenerate_from_goal",
    status: "scheduled",
    reason: "output_unlock",
    payload: {
      turns: [queuedTurn],
      nextFlushAt: Date.now()
    }
  });

  const fired = queue.recheckDeferredVoiceActions({ session, reason: "assistant_output_idle" });

  assert.equal(fired, true);
  assert.equal(flushCalls.length, 1);
  assert.equal(flushCalls[0]?.reason, "assistant_output_idle");
  assert.deepEqual(flushCalls[0]?.deferredTurns, [queuedTurn]);
  assert.equal(queue.getDeferredQueuedUserTurns(session).length, 0);
});

test("recheckDeferredVoiceActions defers queued replay while active promoted capture blocks output", () => {
  const { queue, flushCalls, scheduledFlushes } = createQueueHost(
    createOutputState({ deferredBlockReason: "active_captures", captureBlocking: true })
  );
  const session = createSession();

  queue.setDeferredVoiceAction(session, {
    type: "queued_user_turns",
    goal: "respond_to_deferred_user_turns",
    freshnessPolicy: "regenerate_from_goal",
    status: "scheduled",
    reason: "capture_active",
    payload: {
      turns: [createQueuedTurn()],
      nextFlushAt: Date.now()
    }
  });

  const fired = queue.recheckDeferredVoiceActions({ session, reason: "capture_active" });

  assert.equal(fired, false);
  assert.equal(flushCalls.length, 0);
  assert.equal(scheduledFlushes.length, 1);
  assert.equal(scheduledFlushes[0]?.reason, "capture_active");
  assert.equal(queue.getDeferredQueuedUserTurns(session).length, 1);
});

test("recheckDeferredVoiceActions treats silence-only capture state as replay-safe once output is idle", () => {
  const { queue, flushCalls } = createQueueHost();
  const session = createSession({
    userCaptures: new Map([[
      "user-1",
      {
        userId: "user-1",
        startedAt: Date.now() - 1_500,
        promotedAt: 0,
        promotionReason: null,
        asrUtteranceId: 0,
        bytesSent: 48_000,
        signalSampleCount: 24_000,
        signalActiveSampleCount: 0,
        signalPeakAbs: 0,
        signalSumSquares: 0,
        pcmChunks: [],
        sharedAsrBytesSent: 0,
        lastActivityTouchAt: 0,
        idleFlushTimer: null,
        maxFlushTimer: null,
        speakingEndFinalizeTimer: null,
        finalize: null,
        abort: null,
        removeSubprocessListeners: null
      }
    ]])
  });

  queue.setDeferredVoiceAction(session, {
    type: "queued_user_turns",
    goal: "respond_to_deferred_user_turns",
    freshnessPolicy: "regenerate_from_goal",
    status: "scheduled",
    reason: "silence_only_capture",
    payload: {
      turns: [createQueuedTurn()],
      nextFlushAt: Date.now()
    }
  });

  const fired = queue.recheckDeferredVoiceActions({ session, reason: "capture_resolved" });

  assert.equal(fired, true);
  assert.equal(flushCalls.length, 1);
});

test("recheckDeferredVoiceActions clears stale queued turns after expiry instead of dispatching them", () => {
  const { queue, flushCalls } = createQueueHost();
  const session = createSession();

  queue.setDeferredVoiceAction(session, {
    type: "queued_user_turns",
    goal: "respond_to_deferred_user_turns",
    freshnessPolicy: "regenerate_from_goal",
    status: "scheduled",
    reason: "expired",
    expiresAt: Date.now() - 10,
    payload: {
      turns: [createQueuedTurn()],
      nextFlushAt: Date.now()
    }
  });

  const fired = queue.recheckDeferredVoiceActions({ session, reason: "assistant_output_idle" });

  assert.equal(fired, false);
  assert.equal(flushCalls.length, 0);
  assert.equal(queue.getDeferredQueuedUserTurns(session).length, 0);
});

test("recheckDeferredVoiceActions gives interrupted replies priority over queued user turns", () => {
  const { queue, flushCalls, utteranceCalls } = createQueueHost();
  const session = createSession();

  queue.setDeferredVoiceAction(session, {
    type: "queued_user_turns",
    goal: "respond_to_deferred_user_turns",
    freshnessPolicy: "regenerate_from_goal",
    status: "scheduled",
    reason: "backlog",
    payload: {
      turns: [createQueuedTurn()],
      nextFlushAt: Date.now()
    }
  });
  queue.setDeferredVoiceAction(session, {
    type: "interrupted_reply",
    goal: "complete_interrupted_reply",
    freshnessPolicy: "retry_then_regenerate",
    status: "scheduled",
    reason: "barge_in_interrupt",
    payload: {
      utteranceText: "let me finish that",
      interruptedByUserId: "user-1",
      interruptedAt: Date.now(),
      source: "test",
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "user-1",
        talkingTo: null,
        reason: "engaged_continuation",
        source: "test"
      }
    }
  });

  const fired = queue.recheckDeferredVoiceActions({
    session,
    reason: "assistant_output_idle",
    context: {
      userId: "user-1",
      pcmBuffer: Buffer.alloc(9_600, 1),
      captureReason: "stream_end"
    }
  });

  assert.equal(fired, true);
  assert.equal(utteranceCalls.length, 1);
  assert.equal(utteranceCalls[0]?.text, "let me finish that");
  assert.equal(flushCalls.length, 0);
  assert.equal(queue.getDeferredVoiceAction(session, "interrupted_reply"), null);
  assert.equal(queue.getDeferredQueuedUserTurns(session).length, 1);
});
