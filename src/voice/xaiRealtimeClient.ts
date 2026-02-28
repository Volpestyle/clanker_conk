import { EventEmitter } from "node:events";
import WebSocket from "ws";

const XAI_REALTIME_URL = "wss://api.x.ai/v1/realtime";
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_OUTBOUND_EVENT_HISTORY = 8;
const MAX_EVENT_PREVIEW_CHARS = 280;

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
  "response.text.delta",
  "response.text.done",
  "response.output_text.delta",
  "response.output_text.done",
  "transcript.completed"
]);

export class XaiRealtimeClient extends EventEmitter {
  apiKey;
  logger;
  ws;
  connectedAt;
  lastEventAt;
  lastError;
  sessionId;
  lastCloseCode;
  lastCloseReason;
  lastOutboundEventType;
  lastOutboundEventAt;
  lastOutboundEvent;
  recentOutboundEvents;

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
    this.lastOutboundEventType = null;
    this.lastOutboundEventAt = 0;
    this.lastOutboundEvent = null;
    this.recentOutboundEvents = [];
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
      this.emit("socket_error", {
        message: this.lastError
      });
    });

    ws.on("close", (code, reasonBuffer) => {
      this.lastEventAt = Date.now();
      this.lastCloseCode = Number(code) || null;
      this.lastCloseReason = reasonBuffer ? String(reasonBuffer) : null;
      this.log("info", "xai_realtime_ws_closed", {
        code: this.lastCloseCode,
        reason: this.lastCloseReason
      });
      this.emit("socket_closed", {
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

  async openSocket(): Promise<WebSocket> {
    return await new Promise<WebSocket>((resolve, reject) => {
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
      const errorPayload = event.error && typeof event.error === "object" ? event.error : {};
      const message =
        event.error?.message || event.error?.code || event.message || "Unknown xAI realtime error";
      this.lastError = String(message);
      const errorMetadata = {
        error: this.lastError,
        code: errorPayload?.code || null,
        type: event.type,
        param: errorPayload?.param || null,
        lastOutboundEventType: this.lastOutboundEventType || null,
        lastOutboundEvent: this.lastOutboundEvent || null,
        recentOutboundEvents: this.recentOutboundEvents.slice(-4)
      };
      this.log("warn", "xai_realtime_error_event", {
        ...errorMetadata
      });
      this.emit("error_event", {
        message: this.lastError,
        code: errorPayload?.code || null,
        param: errorPayload?.param || null,
        event,
        lastOutboundEventType: this.lastOutboundEventType || null,
        lastOutboundEvent: this.lastOutboundEvent || null,
        recentOutboundEvents: this.recentOutboundEvents.slice(-4)
      });
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
        this.emit("transcript", {
          text: String(transcript),
          eventType: String(event.type || "")
        });
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

  requestTextUtterance(promptText) {
    const prompt = String(promptText || "").trim();
    if (!prompt) return;
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: prompt
          }
        ]
      }
    });
    this.createAudioResponse();
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("xAI realtime socket is not open.");
    }

    const eventType = String(payload?.type || "unknown");
    this.lastOutboundEventType = eventType;
    this.lastOutboundEventAt = Date.now();
    this.recordOutboundEvent(payload);
    // Temporary diagnostics for realtime schema mismatches. Skip high-volume audio chunks.
    if (eventType !== "input_audio_buffer.append") {
      this.log("info", "xai_realtime_client_event_sent", {
        ...(this.lastOutboundEvent || { type: eventType })
      });
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
      lastCloseReason: this.lastCloseReason,
      lastOutboundEventType: this.lastOutboundEventType || null,
      lastOutboundEventAt: this.lastOutboundEventAt ? new Date(this.lastOutboundEventAt).toISOString() : null,
      lastOutboundEvent: this.lastOutboundEvent || null,
      recentOutboundEvents: this.recentOutboundEvents.slice(-4)
    };
  }

  log(level, event, metadata = null) {
    if (!this.logger) return;
    this.logger({ level, event, metadata });
  }

  recordOutboundEvent(payload) {
    const eventType = String(payload?.type || "unknown");
    const summarizedPayload = summarizeOutboundPayload(payload);
    const event = compactObject({
      type: eventType,
      at: this.lastOutboundEventAt ? new Date(this.lastOutboundEventAt).toISOString() : null,
      payload: summarizedPayload
    });
    this.lastOutboundEvent = event;
    if (eventType === "input_audio_buffer.append") return;
    this.recentOutboundEvents.push(event);
    if (this.recentOutboundEvents.length > MAX_OUTBOUND_EVENT_HISTORY) {
      this.recentOutboundEvents = this.recentOutboundEvents.slice(-MAX_OUTBOUND_EVENT_HISTORY);
    }
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

function summarizeOutboundPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const type = String(payload.type || "unknown");

  if (type === "input_audio_buffer.append") {
    const audioChars = typeof payload.audio === "string" ? payload.audio.length : null;
    return compactObject({
      type,
      audioChars
    });
  }

  if (type === "input_audio_buffer.commit" || type === "response.create") {
    const response = payload.response && typeof payload.response === "object" ? payload.response : null;
    return compactObject({
      type,
      response: response
        ? {
            modalities: Array.isArray(response.modalities) ? response.modalities.slice(0, 4) : null
          }
        : null
    });
  }

  if (type === "session.update") {
    const session = payload.session && typeof payload.session === "object" ? payload.session : {};
    return compactObject({
      type,
      voice: session.voice || null,
      region: session.region || null,
      modalities: Array.isArray(session.modalities) ? session.modalities.slice(0, 4) : null,
      inputAudioType: session?.audio?.input?.format?.type || null,
      inputAudioRate: Number(session?.audio?.input?.format?.rate) || null,
      outputAudioType: session?.audio?.output?.format?.type || null,
      outputAudioRate: Number(session?.audio?.output?.format?.rate) || null,
      turnDetectionType:
        session?.turn_detection && typeof session.turn_detection === "object"
          ? String(session.turn_detection.type || "")
          : null,
      instructionsChars: session.instructions ? String(session.instructions).length : 0
    });
  }

  const preview = safeJsonPreview(payload, MAX_EVENT_PREVIEW_CHARS);
  return compactObject({
    type,
    preview
  });
}

function safeJsonPreview(value, maxChars) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= maxChars) return serialized;
    return `${serialized.slice(0, maxChars)}...`;
  } catch {
    return "[unserializable_payload]";
  }
}
