import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  ASSISTANT_OUTPUT_PHASE,
  ASSISTANT_OUTPUT_REASON,
  TTS_PLAYBACK_STATE,
  buildReplyOutputLockState,
  createAssistantOutputState,
  getAssistantOutputActivityAt,
  patchAssistantOutputState,
  syncAssistantOutputStateRecord
} from "./assistantOutputState.ts";

test("syncAssistantOutputStateRecord derives buffered playback from tts samples", () => {
  const state = syncAssistantOutputStateRecord(null, {
    now: 10_000,
    trigger: "buffer_depth",
    liveAudioStreaming: false,
    pendingResponse: false,
    openAiActiveResponse: false,
    awaitingToolOutputs: false,
    ttsPlaybackState: TTS_PLAYBACK_STATE.IDLE,
    ttsBufferedSamples: 9_600,
    requestId: 7
  });

  assert.equal(state.phase, ASSISTANT_OUTPUT_PHASE.SPEAKING_BUFFERED);
  assert.equal(state.reason, ASSISTANT_OUTPUT_REASON.BOT_AUDIO_BUFFERED);
  assert.equal(state.ttsPlaybackState, TTS_PLAYBACK_STATE.BUFFERED);
  assert.equal(state.ttsBufferedSamples, 9_600);
  assert.equal(state.requestId, 7);
  assert.equal(state.lastTrigger, "buffer_depth");
});

test("syncAssistantOutputStateRecord keeps phaseEnteredAt when phase is unchanged", () => {
  const previous = createAssistantOutputState({ now: 5_000, trigger: "session_start" });
  const pending = syncAssistantOutputStateRecord(previous, {
    now: 6_000,
    trigger: "response_requested",
    liveAudioStreaming: false,
    pendingResponse: true,
    openAiActiveResponse: false,
    awaitingToolOutputs: false,
    requestId: 3
  });
  const resynced = syncAssistantOutputStateRecord(pending, {
    now: 8_000,
    trigger: "watchdog",
    liveAudioStreaming: false,
    pendingResponse: true,
    openAiActiveResponse: false,
    awaitingToolOutputs: false,
    requestId: 3
  });

  assert.equal(pending.phaseEnteredAt, 6_000);
  assert.equal(resynced.phaseEnteredAt, 6_000);
  assert.equal(resynced.reason, ASSISTANT_OUTPUT_REASON.PENDING_RESPONSE);
  assert.equal(resynced.lastTrigger, "watchdog");
});

test("buildReplyOutputLockState preserves canonical assistant output reason", () => {
  const assistantOutput = syncAssistantOutputStateRecord(null, {
    now: 20_000,
    trigger: "audio_delta",
    liveAudioStreaming: true,
    pendingResponse: true,
    openAiActiveResponse: true,
    awaitingToolOutputs: false,
    requestId: 11
  });

  const lockState = buildReplyOutputLockState({
    assistantOutput,
    musicActive: false,
    botTurnOpen: true,
    pendingResponse: true,
    openAiActiveResponse: true,
    awaitingToolOutputs: false
  });

  assert.equal(lockState.locked, true);
  assert.equal(lockState.phase, ASSISTANT_OUTPUT_PHASE.SPEAKING_LIVE);
  assert.equal(lockState.reason, ASSISTANT_OUTPUT_REASON.BOT_AUDIO_LIVE);
});

test("patchAssistantOutputState only updates telemetry fields", () => {
  const liveState = syncAssistantOutputStateRecord(null, {
    now: 30_000,
    trigger: "audio_delta",
    liveAudioStreaming: true,
    pendingResponse: true,
    openAiActiveResponse: false,
    awaitingToolOutputs: false,
    requestId: 9
  });
  const patched = patchAssistantOutputState(liveState, {
    now: 31_000,
    trigger: "stop_playback",
    ttsPlaybackState: TTS_PLAYBACK_STATE.IDLE,
    ttsBufferedSamples: 0
  });

  assert.equal(patched.phase, ASSISTANT_OUTPUT_PHASE.SPEAKING_LIVE);
  assert.equal(patched.reason, ASSISTANT_OUTPUT_REASON.BOT_AUDIO_LIVE);
  assert.equal(patched.lastTrigger, "stop_playback");
});

test("getAssistantOutputActivityAt returns zero when state is idle", () => {
  const idle = createAssistantOutputState({ now: 42_000, trigger: "session_start" });
  assert.equal(getAssistantOutputActivityAt(idle), 0);

  const speaking = syncAssistantOutputStateRecord(idle, {
    now: 43_000,
    trigger: "audio_delta",
    liveAudioStreaming: true,
    pendingResponse: true,
    openAiActiveResponse: false,
    awaitingToolOutputs: false
  });
  assert.equal(getAssistantOutputActivityAt(speaking), 43_000);
});

test("syncAssistantOutputStateRecord keeps lock in speaking_buffered until buffered audio drains", () => {
  const live = syncAssistantOutputStateRecord(null, {
    now: 50_000,
    trigger: "audio_delta",
    liveAudioStreaming: true,
    pendingResponse: true,
    openAiActiveResponse: true,
    awaitingToolOutputs: false,
    requestId: 21
  });

  const buffered = syncAssistantOutputStateRecord(live, {
    now: 50_250,
    trigger: "response_done",
    liveAudioStreaming: false,
    pendingResponse: false,
    openAiActiveResponse: false,
    awaitingToolOutputs: false,
    ttsBufferedSamples: 4_800,
    requestId: 21
  });

  assert.equal(buffered.phase, ASSISTANT_OUTPUT_PHASE.SPEAKING_BUFFERED);
  assert.equal(buffered.reason, ASSISTANT_OUTPUT_REASON.BOT_AUDIO_BUFFERED);
  assert.equal(buffered.requestId, 21);
});

test("syncAssistantOutputStateRecord returns idle after stale buffered telemetry clears", () => {
  const buffered = syncAssistantOutputStateRecord(null, {
    now: 60_000,
    trigger: "buffer_depth",
    liveAudioStreaming: false,
    pendingResponse: false,
    openAiActiveResponse: false,
    awaitingToolOutputs: false,
    ttsBufferedSamples: 9_600,
    requestId: 22
  });

  const idle = syncAssistantOutputStateRecord(buffered, {
    now: 62_000,
    trigger: "buffer_depth_expired",
    liveAudioStreaming: false,
    pendingResponse: false,
    openAiActiveResponse: false,
    awaitingToolOutputs: false,
    ttsPlaybackState: TTS_PLAYBACK_STATE.IDLE,
    ttsBufferedSamples: 0,
    requestId: null
  });

  assert.equal(idle.phase, ASSISTANT_OUTPUT_PHASE.IDLE);
  assert.equal(idle.reason, ASSISTANT_OUTPUT_REASON.IDLE);
  assert.equal(idle.requestId, null);
});

test("syncAssistantOutputStateRecord clears stale active response once pending state disappears", () => {
  const pending = syncAssistantOutputStateRecord(null, {
    now: 70_000,
    trigger: "response_requested",
    liveAudioStreaming: false,
    pendingResponse: false,
    openAiActiveResponse: true,
    awaitingToolOutputs: false,
    requestId: 23
  });

  const idle = syncAssistantOutputStateRecord(pending, {
    now: 70_800,
    trigger: "active_response_cleared",
    liveAudioStreaming: false,
    pendingResponse: false,
    openAiActiveResponse: false,
    awaitingToolOutputs: false,
    requestId: null
  });

  assert.equal(pending.phase, ASSISTANT_OUTPUT_PHASE.RESPONSE_PENDING);
  assert.equal(idle.phase, ASSISTANT_OUTPUT_PHASE.IDLE);
  assert.equal(idle.reason, ASSISTANT_OUTPUT_REASON.IDLE);
});

test("syncAssistantOutputStateRecord returns to response_pending after tool outputs finish", () => {
  const pending = syncAssistantOutputStateRecord(null, {
    now: 80_000,
    trigger: "response_requested",
    liveAudioStreaming: false,
    pendingResponse: true,
    openAiActiveResponse: false,
    awaitingToolOutputs: false,
    requestId: 24
  });
  const awaitingTools = syncAssistantOutputStateRecord(pending, {
    now: 80_200,
    trigger: "tool_call_started",
    liveAudioStreaming: false,
    pendingResponse: true,
    openAiActiveResponse: false,
    awaitingToolOutputs: true,
    requestId: 24
  });
  const resumed = syncAssistantOutputStateRecord(awaitingTools, {
    now: 80_400,
    trigger: "tool_outputs_completed",
    liveAudioStreaming: false,
    pendingResponse: true,
    openAiActiveResponse: false,
    awaitingToolOutputs: false,
    requestId: 24
  });

  assert.equal(awaitingTools.phase, ASSISTANT_OUTPUT_PHASE.AWAITING_TOOL_OUTPUTS);
  assert.equal(awaitingTools.reason, ASSISTANT_OUTPUT_REASON.AWAITING_TOOL_OUTPUTS);
  assert.equal(resumed.phase, ASSISTANT_OUTPUT_PHASE.RESPONSE_PENDING);
  assert.equal(resumed.reason, ASSISTANT_OUTPUT_REASON.PENDING_RESPONSE);
  assert.equal(resumed.requestId, 24);
});

test("syncAssistantOutputStateRecord forces immediate idle on barge-in reset", () => {
  const buffered = syncAssistantOutputStateRecord(null, {
    now: 90_000,
    trigger: "buffer_depth",
    liveAudioStreaming: false,
    pendingResponse: false,
    openAiActiveResponse: false,
    awaitingToolOutputs: false,
    ttsBufferedSamples: 9_600,
    requestId: 25
  });

  const bargedIn = syncAssistantOutputStateRecord(buffered, {
    now: 90_050,
    trigger: "barge_in_interrupt",
    liveAudioStreaming: false,
    pendingResponse: false,
    openAiActiveResponse: false,
    awaitingToolOutputs: false,
    ttsPlaybackState: TTS_PLAYBACK_STATE.IDLE,
    ttsBufferedSamples: 0,
    requestId: null
  });

  assert.equal(buffered.phase, ASSISTANT_OUTPUT_PHASE.SPEAKING_BUFFERED);
  assert.equal(bargedIn.phase, ASSISTANT_OUTPUT_PHASE.IDLE);
  assert.equal(bargedIn.reason, ASSISTANT_OUTPUT_REASON.IDLE);
});
