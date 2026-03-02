import { test } from "bun:test";
import assert from "node:assert/strict";
import { OpenAiRealtimeTranscriptionClient } from "./openaiRealtimeTranscriptionClient.ts";

test("OpenAiRealtimeTranscriptionClient sendSessionUpdate uses text transcription schema", () => {
  const client = new OpenAiRealtimeTranscriptionClient({ apiKey: "test-key" });
  let outbound = null;
  client.send = (payload) => {
    outbound = payload;
  };
  client.sessionConfig = {
    model: "gpt-4o-mini-transcribe",
    inputAudioFormat: "pcm16",
    inputTranscriptionModel: "gpt-4o-mini-transcribe",
    inputTranscriptionLanguage: "en",
    inputTranscriptionPrompt: "Prefer English."
  };

  client.sendSessionUpdate();

  assert.ok(outbound);
  assert.equal(outbound.type, "session.update");
  assert.equal(outbound.session.type, "realtime");
  assert.equal(outbound.session.model, "gpt-4o-mini-transcribe");
  assert.deepEqual(outbound.session.output_modalities, ["text"]);
  assert.equal(outbound.session.audio.input.format.type, "audio/pcm");
  assert.equal(outbound.session.audio.input.format.rate, 24000);
  assert.equal(outbound.session.audio.input.transcription.model, "gpt-4o-mini-transcribe");
  assert.equal(outbound.session.audio.input.transcription.language, "en");
  assert.equal(outbound.session.audio.input.transcription.prompt, "Prefer English.");
});

test("OpenAiRealtimeTranscriptionClient emits transcript final flag by event type", () => {
  const client = new OpenAiRealtimeTranscriptionClient({ apiKey: "test-key" });
  const received = [];
  client.on("transcript", (payload) => {
    received.push(payload);
  });

  client.handleIncoming(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "hello"
    })
  );
  client.handleIncoming(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "hello there"
    })
  );

  assert.equal(received.length, 2);
  assert.equal(received[0]?.text, "hello");
  assert.equal(received[0]?.final, false);
  assert.equal(received[1]?.text, "hello there");
  assert.equal(received[1]?.final, true);
});
