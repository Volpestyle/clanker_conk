import test from "node:test";
import assert from "node:assert/strict";
import {
  extractSoundboardDirective,
  getRealtimeCommitMinimumBytes,
  getRealtimeRuntimeLabel,
  isRecoverableRealtimeError,
  isVoiceTurnAddressedToBot,
  resolveRealtimeProvider,
  resolveVoiceRuntimeMode,
  transcriptSourceFromEventType
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
  assert.equal(getRealtimeCommitMinimumBytes("gemini_realtime", 24_000), 1);
});

test("Gemini realtime mode resolves to gemini provider and label", () => {
  assert.equal(resolveVoiceRuntimeMode({ voice: { mode: "gemini_realtime" } }), "gemini_realtime");
  assert.equal(resolveRealtimeProvider("gemini_realtime"), "gemini");
  assert.equal(getRealtimeRuntimeLabel("gemini_realtime"), "gemini_realtime");
});

test("transcriptSourceFromEventType classifies Gemini transcription events", () => {
  assert.equal(transcriptSourceFromEventType("input_audio_transcription"), "input");
  assert.equal(transcriptSourceFromEventType("output_audio_transcription"), "output");
  assert.equal(transcriptSourceFromEventType("server_content_text"), "output");
});

test("extractSoundboardDirective strips directive and returns selected reference", () => {
  const parsed = extractSoundboardDirective("that was crazy [[SOUNDBOARD:1234567890@111222333]]");
  assert.equal(parsed.text, "that was crazy");
  assert.equal(parsed.reference, "1234567890@111222333");
});

test("isVoiceTurnAddressedToBot catches close wake-word spellings", () => {
  const settings = { botName: "clanker conk" };
  assert.equal(isVoiceTurnAddressedToBot("Clicker, what did we talk about yesterday?", settings), true);
  assert.equal(isVoiceTurnAddressedToBot("yo clunker can you answer this?", settings), true);
  assert.equal(isVoiceTurnAddressedToBot("i sent you a link yesterday", settings), false);
});

test("isVoiceTurnAddressedToBot uses wake-word context to avoid incidental mentions", () => {
  const settings = { botName: "clanker conk" };
  assert.equal(isVoiceTurnAddressedToBot("Hi cleaner.", settings), true);
  assert.equal(isVoiceTurnAddressedToBot("cleaner can you jump in?", settings), true);
  assert.equal(isVoiceTurnAddressedToBot("the cleaner is broken again", settings), false);
});

test("isVoiceTurnAddressedToBot follows configured botName without clank hardcoding", () => {
  const settings = { botName: "sparky bot" };
  assert.equal(isVoiceTurnAddressedToBot("Sporky, can you help me with this?", settings), true);
  assert.equal(isVoiceTurnAddressedToBot("clunker can you help me with this?", settings), false);
});
