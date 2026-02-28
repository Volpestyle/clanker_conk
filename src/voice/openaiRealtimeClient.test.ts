import { test } from "bun:test";
import assert from "node:assert/strict";
import { OpenAiRealtimeClient } from "./openaiRealtimeClient.ts";

test("OpenAiRealtimeClient sendSessionUpdate uses GA session audio schema", () => {
  const client = new OpenAiRealtimeClient({ apiKey: "test-key" });
  let outbound = null;
  client.send = (payload) => {
    outbound = payload;
  };
  client.sessionConfig = {
    model: "gpt-realtime",
    voice: "alloy",
    instructions: "Keep it short.",
    inputAudioFormat: "pcm16",
    outputAudioFormat: "pcm16",
    inputTranscriptionModel: "gpt-4o-mini-transcribe"
  };

  client.sendSessionUpdate();

  assert.ok(outbound);
  assert.equal(outbound.type, "session.update");
  assert.equal(outbound.session.type, "realtime");
  assert.equal(outbound.session.model, "gpt-realtime");
  assert.equal(outbound.session.instructions, "Keep it short.");
  assert.deepEqual(outbound.session.output_modalities, ["audio"]);
  assert.equal(outbound.session.audio.input.format.type, "audio/pcm");
  assert.equal(outbound.session.audio.input.format.rate, 24000);
  assert.equal(outbound.session.audio.output.format.type, "audio/pcm");
  assert.equal(outbound.session.audio.output.format.rate, 24000);
  assert.equal(outbound.session.audio.output.voice, "alloy");
  assert.equal(outbound.session.audio.input.transcription.model, "gpt-4o-mini-transcribe");
  assert.equal(Object.hasOwn(outbound.session, "voice"), false);
  assert.equal(Object.hasOwn(outbound.session, "modalities"), false);
  assert.equal(Object.hasOwn(outbound.session, "input_audio_format"), false);
  assert.equal(Object.hasOwn(outbound.session, "output_audio_format"), false);
  assert.equal(Object.hasOwn(outbound.session, "input_audio_transcription"), false);
});

test("OpenAiRealtimeClient sendSessionUpdate normalizes unsupported formats to PCM16 transport", () => {
  const client = new OpenAiRealtimeClient({ apiKey: "test-key" });
  let outbound = null;
  client.send = (payload) => {
    outbound = payload;
  };
  client.sessionConfig = {
    model: "gpt-realtime",
    voice: "alloy",
    instructions: "",
    inputAudioFormat: "g711_ulaw",
    outputAudioFormat: "g711_alaw",
    inputTranscriptionModel: "gpt-4o-mini-transcribe"
  };

  client.sendSessionUpdate();

  assert.ok(outbound);
  assert.equal(outbound.session.audio.input.format.type, "audio/pcm");
  assert.equal(outbound.session.audio.input.format.rate, 24000);
  assert.equal(outbound.session.audio.output.format.type, "audio/pcm");
  assert.equal(outbound.session.audio.output.format.rate, 24000);
});

test("OpenAiRealtimeClient tracks response lifecycle", () => {
  const client = new OpenAiRealtimeClient({ apiKey: "test-key" });
  client.handleIncoming(
    JSON.stringify({
      type: "response.created",
      response: {
        id: "resp_abc123",
        status: "in_progress"
      }
    })
  );
  assert.equal(client.isResponseInProgress(), true);
  assert.equal(client.getState().activeResponseId, "resp_abc123");

  client.handleIncoming(
    JSON.stringify({
      type: "response.done",
      response: {
        id: "resp_abc123",
        status: "completed"
      }
    })
  );
  assert.equal(client.isResponseInProgress(), false);
  assert.equal(client.getState().activeResponseId, null);
});

test("OpenAiRealtimeClient marks active response from active-response error", () => {
  const client = new OpenAiRealtimeClient({ apiKey: "test-key" });
  client.handleIncoming(
    JSON.stringify({
      type: "error",
      error: {
        code: "conversation_already_has_active_response",
        message: "Conversation already has an active response in progress: resp_XYZ987."
      }
    })
  );
  assert.equal(client.isResponseInProgress(), true);
  assert.equal(client.getState().activeResponseId, "resp_XYZ987");
});

test("OpenAiRealtimeClient stream-watch commentary sends out-of-band image input", () => {
  const client = new OpenAiRealtimeClient({ apiKey: "test-key" });
  let outbound = null;
  client.send = (payload) => {
    outbound = payload;
  };

  client.appendInputVideoFrame({
    mimeType: "image/jpg",
    dataBase64: "Zm9v"
  });
  client.requestVideoCommentary("one short line");

  assert.ok(outbound);
  assert.equal(outbound.type, "response.create");
  assert.equal(outbound.response.conversation, "none");
  assert.deepEqual(outbound.response.output_modalities, ["audio"]);
  assert.equal(outbound.response.input?.[0]?.type, "message");
  assert.equal(outbound.response.input?.[0]?.role, "user");
  assert.equal(outbound.response.input?.[0]?.content?.[0]?.type, "input_text");
  assert.equal(outbound.response.input?.[0]?.content?.[0]?.text, "one short line");
  assert.equal(outbound.response.input?.[0]?.content?.[1]?.type, "input_image");
  assert.equal(outbound.response.input?.[0]?.content?.[1]?.image_url, "data:image/jpeg;base64,Zm9v");
});

test("OpenAiRealtimeClient stream-watch commentary requires a buffered frame", () => {
  const client = new OpenAiRealtimeClient({ apiKey: "test-key" });
  client.send = () => {
    throw new Error("send should not be called");
  };

  assert.throws(
    () => client.requestVideoCommentary("one short line"),
    /No stream-watch frame buffered/
  );
});
