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
