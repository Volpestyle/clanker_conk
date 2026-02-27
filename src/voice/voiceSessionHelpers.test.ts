import test from "node:test";
import assert from "node:assert/strict";
import {
  isBotNameAddressed,
  extractSoundboardDirective,
  getRealtimeCommitMinimumBytes,
  getRealtimeRuntimeLabel,
  isRecoverableRealtimeError,
  isVoiceTurnAddressedToBot,
  resolveRealtimeProvider,
  resolveVoiceRuntimeMode,
  transcriptSourceFromEventType
} from "./voiceSessionHelpers.ts";

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

test("isVoiceTurnAddressedToBot balances fuzzy wake detection with false-positive guards", () => {
  const settings = { botName: "clanker conk" };
  const cases = [
    { text: "yo clunker can you answer this?", expected: true },
    { text: "yo clanky can you answer this?", expected: true },
    { text: "i think clunker can you answer this?", expected: true },
    { text: "clankerton can you jump in?", expected: true },
    { text: "clunkeroni can you jump in?", expected: true },
    { text: "i sent you a link yesterday", expected: false },
    { text: "Hi cleaner.", expected: false },
    { text: "cleaner can you jump in?", expected: false },
    { text: "the cleaner is broken again", expected: false },
    { text: "Very big step up from Paldea. Pretty excited to see what they cook up", expected: false }
  ];

  for (const row of cases) {
    assert.equal(isVoiceTurnAddressedToBot(row.text, settings), row.expected, row.text);
  }
});

test("isVoiceTurnAddressedToBot follows configured botName without clank hardcoding", () => {
  const settings = { botName: "sparky bot" };
  assert.equal(isVoiceTurnAddressedToBot("Sporky, can you help me with this?", settings), true);
  assert.equal(isVoiceTurnAddressedToBot("clunker can you help me with this?", settings), false);
});

test("isBotNameAddressed can run relaxed bot-name fuzzy matching for text messages", () => {
  assert.equal(
    isBotNameAddressed({
      transcript: "whats up sporky",
      botName: "sparky bot"
    }),
    true
  );
  assert.equal(
    isBotNameAddressed({
      transcript: "clankerton",
      botName: "sparky bot"
    }),
    false
  );
});

test("isBotNameAddressed stays flexible for custom names while rejecting near misses", () => {
  const cases = [
    { transcript: "sparky bot can you help me with this?", botName: "sparky bot", expected: true },
    { transcript: "clanky can you help me with this?", botName: "clanker conk", expected: true },
    { transcript: "sporky can you help me with this?", botName: "sparky bot", expected: true },
    { transcript: "i think sporky can you help me with this?", botName: "sparky bot", expected: true },
    { transcript: "i like spark plugs in old cars", botName: "sparky bot", expected: false },
    { transcript: "clankerton", botName: "sparky bot", expected: false },
    { transcript: "Very big step up from Paldea. Pretty excited to see what they cook up", botName: "clanker conk", expected: false }
  ];

  for (const row of cases) {
    assert.equal(
      isBotNameAddressed({
        transcript: row.transcript,
        botName: row.botName
      }),
      row.expected,
      `${row.botName} :: ${row.transcript}`
    );
  }
});

test("isBotNameAddressed accepts nickname suffix variants while rejecting distant variants", () => {
  const settings = { botName: "clanker conk" };
  assert.equal(isVoiceTurnAddressedToBot("clankerton", settings), true);
  assert.equal(isVoiceTurnAddressedToBot("clunkeroni", settings), true);
  assert.equal(isVoiceTurnAddressedToBot("clinkitity", settings), false);
});
