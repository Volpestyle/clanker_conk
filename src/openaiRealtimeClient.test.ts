import test from "node:test";
import assert from "node:assert/strict";
import { OpenAiRealtimeClient } from "./voice/openaiRealtimeClient.ts";

test("OpenAiRealtimeClient sendSessionUpdate omits unsupported session.type", () => {
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
  assert.equal(outbound.session.model, "gpt-realtime");
  assert.equal(outbound.session.voice, "alloy");
  assert.equal(outbound.session.instructions, "Keep it short.");
  assert.deepEqual(outbound.session.modalities, ["audio", "text"]);
  assert.equal(outbound.session.input_audio_format, "pcm16");
  assert.equal(outbound.session.output_audio_format, "pcm16");
  assert.equal(outbound.session.input_audio_transcription.model, "gpt-4o-mini-transcribe");
  assert.equal(Object.hasOwn(outbound.session, "type"), false);
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
