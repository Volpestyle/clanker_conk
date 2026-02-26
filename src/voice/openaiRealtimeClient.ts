import { EventEmitter } from "node:events";
import WebSocket from "ws";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
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
  "response.audio_transcript.delta",
  "response.audio_transcript.done",
  "response.output_audio_transcript.delta",
  "response.output_audio_transcript.done",
  "transcript.completed"
]);

export class OpenAiRealtimeClient extends EventEmitter {
  constructor({ apiKey, baseUrl = DEFAULT_OPENAI_BASE_URL, logger = null }) {
    super();
    this.apiKey = String(apiKey || "").trim();
    this.baseUrl = String(baseUrl || DEFAULT_OPENAI_BASE_URL).trim() || DEFAULT_OPENAI_BASE_URL;
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
    this.sessionConfig = null;
  }

  async connect({
    model = "gpt-realtime",
    voice = "alloy",
    instructions = "",
    inputAudioFormat = "pcm16",
    outputAudioFormat = "pcm16",
    inputTranscriptionModel = "gpt-4o-mini-transcribe"
  } = {}) {
    if (!this.apiKey) {
      throw new Error("Missing OPENAI_API_KEY for OpenAI realtime voice runtime.");
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.getState();
    }

    const resolvedModel = String(model || "gpt-realtime").trim() || "gpt-realtime";
    const resolvedVoice = String(voice || "alloy").trim() || "alloy";
    const resolvedInputAudioFormat = normalizeOpenAiRealtimeAudioFormat(inputAudioFormat);
    const resolvedOutputAudioFormat = normalizeOpenAiRealtimeAudioFormat(outputAudioFormat);
    const resolvedInputTranscriptionModel =
      String(inputTranscriptionModel || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
    const ws = await this.openSocket(this.buildRealtimeUrl(resolvedModel));
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
      this.log("warn", "openai_realtime_ws_error", { error: this.lastError });
      this.emit("socket_error", {
        message: this.lastError
      });
    });

    ws.on("close", (code, reasonBuffer) => {
      this.lastEventAt = Date.now();
      this.lastCloseCode = Number(code) || null;
      this.lastCloseReason = reasonBuffer ? String(reasonBuffer) : null;
      this.log("info", "openai_realtime_ws_closed", {
        code: this.lastCloseCode,
        reason: this.lastCloseReason
      });
      this.emit("socket_closed", {
        code: this.lastCloseCode,
        reason: this.lastCloseReason
      });
    });

    this.sessionConfig = {
      model: resolvedModel,
      voice: resolvedVoice,
      instructions: String(instructions || ""),
      inputAudioFormat: resolvedInputAudioFormat,
      outputAudioFormat: resolvedOutputAudioFormat,
      inputTranscriptionModel: resolvedInputTranscriptionModel
    };
    this.sendSessionUpdate();

    return this.getState();
  }

  buildRealtimeUrl(model) {
    const base = normalizeOpenAiBaseUrl(this.baseUrl);
    const url = new URL(base);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = `${basePath}/realtime`;
    url.searchParams.set("model", String(model || "gpt-realtime"));
    return url.toString();
  }

  async openSocket(url) {
    return await new Promise((resolve, reject) => {
      let settled = false;

      const ws = new WebSocket(String(url), {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "OpenAI-Beta": "realtime=v1"
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
        reject(new Error(`Timed out connecting to OpenAI realtime after ${CONNECT_TIMEOUT_MS}ms.`));
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
        reject(new Error(`OpenAI realtime connection failed: ${String(error?.message || error)}`));
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
      this.log("info", "openai_realtime_session_updated", { sessionId: this.sessionId });
      return;
    }

    if (event.type === "error") {
      const errorPayload = event.error && typeof event.error === "object" ? event.error : {};
      const message =
        event.error?.message || event.error?.code || event.message || "Unknown OpenAI realtime error";
      this.lastError = String(message);
      const errorMetadata = {
        error: this.lastError,
        code: errorPayload?.code || null,
        type: event.type,
        param: errorPayload?.param || null,
        eventId: event.event_id || null,
        lastOutboundEventType: this.lastOutboundEventType || null,
        lastOutboundEvent: this.lastOutboundEvent || null,
        recentOutboundEvents: this.recentOutboundEvents.slice(-4)
      };
      this.log("warn", "openai_realtime_error_event", {
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

  updateInstructions(instructions = "") {
    if (!this.sessionConfig || typeof this.sessionConfig !== "object") {
      throw new Error("OpenAI realtime session config is not initialized.");
    }

    this.sessionConfig = {
      ...this.sessionConfig,
      instructions: String(instructions || "")
    };
    this.sendSessionUpdate();
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("OpenAI realtime socket is not open.");
    }

    const eventType = String(payload?.type || "unknown");
    this.lastOutboundEventType = eventType;
    this.lastOutboundEventAt = Date.now();
    this.recordOutboundEvent(payload);
    if (eventType !== "input_audio_buffer.append") {
      this.log("info", "openai_realtime_client_event_sent", {
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

  sendSessionUpdate() {
    const session = this.sessionConfig && typeof this.sessionConfig === "object" ? this.sessionConfig : {};
    this.send({
      type: "session.update",
      session: compactObject({
        type: "realtime",
        model: String(session.model || "gpt-realtime").trim() || "gpt-realtime",
        voice: String(session.voice || "alloy").trim() || "alloy",
        instructions: String(session.instructions || ""),
        modalities: ["audio", "text"],
        input_audio_format: normalizeOpenAiRealtimeAudioFormat(session.inputAudioFormat),
        output_audio_format: normalizeOpenAiRealtimeAudioFormat(session.outputAudioFormat),
        input_audio_transcription: compactObject({
          model: String(session.inputTranscriptionModel || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe"
        })
      })
    });
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

function normalizeOpenAiBaseUrl(value) {
  const raw = String(value || DEFAULT_OPENAI_BASE_URL).trim();
  const normalized = raw || DEFAULT_OPENAI_BASE_URL;
  return normalized.replace(/\/+$/, "");
}

function normalizeOpenAiRealtimeAudioFormat(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "g711_ulaw") return "g711_ulaw";
  if (normalized === "g711_alaw") return "g711_alaw";
  return "pcm16";
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
      model: session.model || null,
      voice: session.voice || null,
      modalities: Array.isArray(session.modalities) ? session.modalities.slice(0, 4) : null,
      inputAudioFormat: session.input_audio_format || null,
      outputAudioFormat: session.output_audio_format || null,
      inputTranscriptionModel: session?.input_audio_transcription?.model || null,
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
