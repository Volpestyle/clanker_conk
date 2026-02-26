import test from "node:test";
import assert from "node:assert/strict";
import {
  getRealtimeCommitMinimumBytes,
  isRecoverableRealtimeError
} from "./voice/voiceSessionHelpers.ts";

test("isRecoverableRealtimeError matches OpenAI empty commit code", () => {
  const recoverable = isRecoverableRealtimeError({
    mode: "openai_realtime",
    code: "input_audio_buffer_commit_empty",
    message: ""
  });
  assert.equal(recoverable, true);
});

test("isRecoverableRealtimeError does not match unrelated realtime errors", () => {
  const recoverable = isRecoverableRealtimeError({
    mode: "openai_realtime",
    code: "unknown_parameter",
    message: "Unknown parameter: session.type"
  });
  assert.equal(recoverable, false);
});

test("isRecoverableRealtimeError matches active response collision code", () => {
  const recoverable = isRecoverableRealtimeError({
    mode: "openai_realtime",
    code: "conversation_already_has_active_response",
    message: "Conversation already has an active response in progress."
  });
  assert.equal(recoverable, true);
});

test("getRealtimeCommitMinimumBytes enforces OpenAI minimum audio window", () => {
  assert.equal(getRealtimeCommitMinimumBytes("openai_realtime", 24_000), 4_800);
  assert.equal(getRealtimeCommitMinimumBytes("openai_realtime", 16_000), 3_200);
});

test("getRealtimeCommitMinimumBytes uses passthrough minimum for non-openai modes", () => {
  assert.equal(getRealtimeCommitMinimumBytes("voice_agent", 24_000), 1);
});
