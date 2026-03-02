import { EventEmitter } from "node:events";
import WebSocket from "ws";
import {
  buildCommonRealtimeState,
  closeRealtimeSocket,
  compactObject,
  handleRealtimeSocketClose,
  handleRealtimeSocketError,
  markRealtimeConnected,
  openRealtimeSocket,
  sendRealtimePayload
} from "./realtimeClientCore.ts";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

const TRANSCRIPT_DELTA_TYPES = new Set([
  "conversation.item.input_audio_transcription.delta"
]);

const TRANSCRIPT_FINAL_TYPES = new Set([
  "conversation.item.input_audio_transcription.completed"
]);

export class OpenAiRealtimeTranscriptionClient extends EventEmitter {
  apiKey;
  baseUrl;
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
  sessionConfig;

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
    model = "gpt-4o-mini-transcribe",
    inputAudioFormat = "pcm16",
    inputTranscriptionModel = "gpt-4o-mini-transcribe",
    inputTranscriptionLanguage = "",
    inputTranscriptionPrompt = ""
  } = {}) {
    if (!this.apiKey) {
      throw new Error("Missing OPENAI_API_KEY for OpenAI realtime transcription runtime.");
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.getState();
    }

    const resolvedModel = String(model || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
    const resolvedInputAudioFormat = normalizeOpenAiRealtimeAudioFormat(inputAudioFormat);
    const resolvedInputTranscriptionModel =
      String(inputTranscriptionModel || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
    const resolvedInputTranscriptionLanguage = String(inputTranscriptionLanguage || "")
      .trim()
      .toLowerCase()
      .replace(/_/g, "-")
      .slice(0, 24);
    const resolvedInputTranscriptionPrompt = String(inputTranscriptionPrompt || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 280);

    const ws = await this.openSocket(this.buildRealtimeUrl(resolvedModel));
    markRealtimeConnected(this, ws);

    ws.on("message", (payload) => {
      this.lastEventAt = Date.now();
      this.handleIncoming(payload);
    });

    ws.on("error", (error) => {
      handleRealtimeSocketError(this, error, {
        logEvent: "openai_realtime_asr_ws_error"
      });
    });

    ws.on("close", (code, reasonBuffer) => {
      handleRealtimeSocketClose(this, code, reasonBuffer, {
        logEvent: "openai_realtime_asr_ws_closed"
      });
    });

    this.sessionConfig = {
      model: resolvedModel,
      inputAudioFormat: resolvedInputAudioFormat,
      inputTranscriptionModel: resolvedInputTranscriptionModel,
      inputTranscriptionLanguage: resolvedInputTranscriptionLanguage,
      inputTranscriptionPrompt: resolvedInputTranscriptionPrompt
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
    url.searchParams.set("model", String(model || "gpt-4o-mini-transcribe"));
    return url.toString();
  }

  async openSocket(url): Promise<WebSocket> {
    return await openRealtimeSocket({
      url,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      timeoutMessage: "Timed out connecting to OpenAI realtime ASR after 10000ms.",
      connectErrorPrefix: "OpenAI realtime ASR connection failed"
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
      this.log("info", "openai_realtime_asr_session_updated", { sessionId: this.sessionId });
      return;
    }

    if (event.type === "error") {
      const errorPayload = event.error && typeof event.error === "object" ? event.error : {};
      const message =
        event.error?.message || event.error?.code || event.message || "Unknown OpenAI realtime ASR error";
      this.lastError = String(message);
      this.log("warn", "openai_realtime_asr_error_event", {
        error: this.lastError,
        code: errorPayload?.code || null,
        type: event.type,
        param: errorPayload?.param || null,
        eventId: event.event_id || null
      });
      this.emit("error_event", {
        message: this.lastError,
        code: errorPayload?.code || null,
        param: errorPayload?.param || null,
        event
      });
      return;
    }

    const eventType = String(event.type || "");
    if (TRANSCRIPT_DELTA_TYPES.has(eventType) || TRANSCRIPT_FINAL_TYPES.has(eventType)) {
      const transcript =
        event.transcript ||
        event.text ||
        event.delta ||
        event?.item?.content?.[0]?.transcript ||
        "";
      const normalizedTranscript = String(transcript || "").trim();
      if (!normalizedTranscript) return;
      this.emit("transcript", {
        text: normalizedTranscript,
        eventType,
        final: TRANSCRIPT_FINAL_TYPES.has(eventType)
      });
      return;
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

  clearInputAudioBuffer() {
    this.send({ type: "input_audio_buffer.clear" });
  }

  send(payload) {
    sendRealtimePayload(this, {
      payload,
      eventType: String(payload?.type || "unknown"),
      summarizeOutboundPayload,
      skipHistoryEventType: "input_audio_buffer.append",
      skipLogEventType: "input_audio_buffer.append",
      logEvent: "openai_realtime_asr_event_sent",
      socketNotOpenMessage: "OpenAI realtime ASR socket is not open."
    });
  }

  updateTranscriptionGuidance({ language = "", prompt = "" } = {}) {
    if (!this.sessionConfig || typeof this.sessionConfig !== "object") {
      throw new Error("OpenAI realtime ASR session config is not initialized.");
    }
    this.sessionConfig = {
      ...this.sessionConfig,
      inputTranscriptionLanguage: String(language || "")
        .trim()
        .toLowerCase()
        .replace(/_/g, "-")
        .slice(0, 24),
      inputTranscriptionPrompt: String(prompt || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 280)
    };
    this.sendSessionUpdate();
  }

  sendSessionUpdate() {
    const session = this.sessionConfig && typeof this.sessionConfig === "object" ? this.sessionConfig : {};
    this.send({
      type: "session.update",
      session: compactObject({
        type: "realtime",
        model: String(session.model || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe",
        output_modalities: ["text"],
        audio: compactObject({
          input: compactObject({
            format: normalizeOpenAiRealtimeAudioFormat(session.inputAudioFormat),
            transcription: compactObject({
              model:
                String(session.inputTranscriptionModel || "gpt-4o-mini-transcribe").trim() ||
                "gpt-4o-mini-transcribe",
              language: String(session.inputTranscriptionLanguage || "").trim() || null,
              prompt: String(session.inputTranscriptionPrompt || "").trim() || null
            })
          })
        })
      })
    });
  }

  async close() {
    if (!this.ws) return;
    if (this.ws.readyState === WebSocket.CLOSED) {
      this.ws = null;
      return;
    }
    await closeRealtimeSocket(this.ws);
    this.ws = null;
  }

  getState() {
    return {
      ...buildCommonRealtimeState(this)
    };
  }

  log(level, event, metadata = null) {
    if (!this.logger) return;
    this.logger({ level, event, metadata });
  }
}

function normalizeOpenAiBaseUrl(value) {
  const raw = String(value || DEFAULT_OPENAI_BASE_URL).trim();
  const normalized = raw || DEFAULT_OPENAI_BASE_URL;
  return normalized.replace(/\/+$/, "");
}

function normalizeOpenAiRealtimeAudioFormat(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const type = String(value.type || "")
      .trim()
      .toLowerCase();
    if (type === "audio/pcm") {
      const rate = Number(value.rate);
      return {
        type: "audio/pcm",
        rate: Number.isFinite(rate) && rate > 0 ? Math.floor(rate) : 24000
      };
    }
  }

  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "audio/pcm") {
    return {
      type: "audio/pcm",
      rate: 24000
    };
  }

  return {
    type: "audio/pcm",
    rate: 24000
  };
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

  if (type === "input_audio_buffer.commit" || type === "input_audio_buffer.clear") {
    return {
      type
    };
  }

  if (type === "session.update") {
    const session = payload.session && typeof payload.session === "object" ? payload.session : {};
    const audio = session.audio && typeof session.audio === "object" ? session.audio : {};
    return compactObject({
      type,
      sessionType: session.type || null,
      model: session.model || null,
      outputModalities: Array.isArray(session.output_modalities) ? session.output_modalities.slice(0, 4) : null,
      inputFormat: audio?.input?.format || null,
      inputTranscriptionModel: audio?.input?.transcription?.model || null
    });
  }

  return {
    type
  };
}
