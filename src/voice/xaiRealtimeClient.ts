import { EventEmitter } from "node:events";
import WebSocket from "ws";

const XAI_REALTIME_URL = "wss://api.x.ai/v1/realtime";
const CONNECT_TIMEOUT_MS = 10_000;

const AUDIO_DELTA_TYPES = new Set([
  "response.audio.delta",
  "response.output_audio.delta",
  "output_audio.delta",
  "audio.delta",
  "response.audio.chunk",
  "response.output_audio.chunk"
]);

const TRANSCRIPT_TYPES = new Set([
  "conversation.item.input_audio_transcription.completed",
  "response.output_audio_transcript.delta",
  "response.output_audio_transcript.done",
  "response.audio_transcript.done",
  "response.audio_transcript.completed",
  "transcript.completed"
]);

export class XaiRealtimeClient extends EventEmitter {
  constructor({ apiKey, logger = null }) {
    super();
    this.apiKey = String(apiKey || "").trim();
    this.logger = typeof logger === "function" ? logger : null;
    this.ws = null;
    this.connectedAt = 0;
    this.lastEventAt = 0;
    this.lastError = null;
    this.sessionId = null;
    this.lastCloseCode = null;
    this.lastCloseReason = null;
  }

  async connect({
    voice = "Rex",
    instructions = "",
    region = "us-east-1",
    inputAudioFormat = "audio/pcm",
    outputAudioFormat = "audio/pcm",
    inputSampleRateHz = 24000,
    outputSampleRateHz = 24000
  } = {}) {
    if (!this.apiKey) {
      throw new Error("Missing XAI_API_KEY for realtime voice runtime.");
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.getState();
    }

    const ws = await this.openSocket();
    this.ws = ws;
    this.connectedAt = Date.now();
    this.lastEventAt = Date.now();
    this.lastError = null;

    ws.on("message", (payload) => {
      this.lastEventAt = Date.now();
      this.handleIncoming(payload);
    });

    ws.on("error", (error) => {
      this.lastEventAt = Date.now();
      this.lastError = String(error?.message || error);
      this.log("warn", "xai_realtime_ws_error", { error: this.lastError });
    });

    ws.on("close", (code, reasonBuffer) => {
      this.lastEventAt = Date.now();
      this.lastCloseCode = Number(code) || null;
      this.lastCloseReason = reasonBuffer ? String(reasonBuffer) : null;
      this.log("info", "xai_realtime_ws_closed", {
        code: this.lastCloseCode,
        reason: this.lastCloseReason
      });
    });

    this.send({
      type: "session.update",
      session: compactObject({
        voice,
        instructions,
        audio: {
          input: {
            format: {
              type: inputAudioFormat,
              rate: Number(inputSampleRateHz) || 24000
            }
          },
          output: {
            format: {
              type: outputAudioFormat,
              rate: Number(outputSampleRateHz) || 24000
            }
          }
        },
        turn_detection: {
          type: null
        },
        region,
        modalities: ["audio", "text"]
      })
    });

    return this.getState();
  }

  async openSocket() {
    return await new Promise((resolve, reject) => {
      let settled = false;

      const ws = new WebSocket(XAI_REALTIME_URL, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        handshakeTimeout: CONNECT_TIMEOUT_MS
      });

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        reject(new Error(`Timed out connecting to xAI realtime after ${CONNECT_TIMEOUT_MS}ms.`));
      }, CONNECT_TIMEOUT_MS + 1000);

      ws.once("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(ws);
      });

      ws.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`xAI realtime connection failed: ${String(error?.message || error)}`));
      });
    });
  }

  handleIncoming(payload) {
    let event = null;

    try {
      event = JSON.parse(String(payload || ""));
    } catch {
      return;
    }

    if (!event || typeof event !== "object") return;

    this.emit("event", event);

    if (event.type === "session.created" || event.type === "session.updated") {
      this.sessionId = event.session?.id || this.sessionId;
      this.log("info", "xai_realtime_session_created", { sessionId: this.sessionId });
      return;
    }

    if (event.type === "error") {
      const message =
        event.error?.message || event.error?.code || event.message || "Unknown xAI realtime error";
      this.lastError = String(message);
      this.log("warn", "xai_realtime_error_event", { error: this.lastError });
      this.emit("error_event", this.lastError);
      return;
    }

    if (AUDIO_DELTA_TYPES.has(event.type)) {
      const audioBase64 = extractAudioBase64(event);
      if (audioBase64) {
        this.emit("audio_delta", audioBase64);
      }
      return;
    }

    if (TRANSCRIPT_TYPES.has(event.type)) {
      const transcript =
        event.transcript ||
        event.text ||
        event.delta ||
        event?.item?.content?.[0]?.transcript ||
        null;

      if (transcript) {
        this.emit("transcript", String(transcript));
      }
      return;
    }

    if (event.type === "response.done") {
      this.emit("response_done", event);
    }
  }

  appendInputAudioPcm(audioBuffer) {
    if (!audioBuffer || !audioBuffer.length) return;
    this.appendInputAudioBase64(audioBuffer.toString("base64"));
  }

  appendInputAudioBase64(audioBase64) {
    if (!audioBase64) return;
    this.send({
      type: "input_audio_buffer.append",
      audio: String(audioBase64)
    });
  }

  commitInputAudioBuffer() {
    this.send({ type: "input_audio_buffer.commit" });
  }

  createAudioResponse() {
    this.send({
      type: "response.create",
      response: {
        modalities: ["audio", "text"]
      }
    });
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("xAI realtime socket is not open.");
    }

    this.ws.send(JSON.stringify(payload));
  }

  async close() {
    if (!this.ws) return;
    if (this.ws.readyState === WebSocket.CLOSED) {
      this.ws = null;
      return;
    }

    await new Promise((resolve) => {
      const ws = this.ws;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        ws.removeAllListeners("close");
        resolve(undefined);
      };

      ws.once("close", done);
      try {
        ws.close(1000, "session_ended");
      } catch {
        done();
      }

      setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        done();
      }, 1500);
    });

    this.ws = null;
  }

  getState() {
    return {
      connected: Boolean(this.ws && this.ws.readyState === WebSocket.OPEN),
      connectedAt: this.connectedAt ? new Date(this.connectedAt).toISOString() : null,
      lastEventAt: this.lastEventAt ? new Date(this.lastEventAt).toISOString() : null,
      sessionId: this.sessionId,
      lastError: this.lastError,
      lastCloseCode: this.lastCloseCode,
      lastCloseReason: this.lastCloseReason
    };
  }

  log(level, event, metadata = null) {
    if (!this.logger) return;
    this.logger({ level, event, metadata });
  }
}

function compactObject(value) {
  const out = {};
  for (const [key, entry] of Object.entries(value || {})) {
    if (entry === undefined || entry === null || entry === "") continue;
    out[key] = entry;
  }
  return out;
}

function extractAudioBase64(event) {
  const direct = event.delta || event.audio || event.chunk;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  const nested =
    event?.audio?.delta ||
    event?.audio?.chunk ||
    event?.data?.audio ||
    event?.data?.delta ||
    event?.response?.audio?.delta ||
    null;

  if (typeof nested === "string" && nested.trim()) {
    return nested.trim();
  }

  return null;
}
