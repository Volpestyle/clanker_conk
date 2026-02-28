import { EventEmitter } from "node:events";
import WebSocket from "ws";
import {
  buildCommonRealtimeState,
  closeRealtimeSocket,
  compactObject,
  extractAudioBase64,
  handleRealtimeSocketClose,
  handleRealtimeSocketError,
  markRealtimeConnected,
  openRealtimeSocket,
  safeJsonPreview,
  sendRealtimePayload
} from "./realtimeClientCore.ts";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

const AUDIO_DELTA_TYPES = new Set([
  "response.output_audio.delta"
]);

const TRANSCRIPT_TYPES = new Set([
  "conversation.item.input_audio_transcription.delta",
  "conversation.item.input_audio_transcription.completed",
  "response.output_audio_transcript.delta",
  "response.output_audio_transcript.done",
  "response.output_text.delta",
  "response.output_text.done"
]);

export class OpenAiRealtimeClient extends EventEmitter {
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
  activeResponseId;
  activeResponseStatus;
  latestVideoFrame;

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
    this.activeResponseId = null;
    this.activeResponseStatus = null;
    this.latestVideoFrame = null;
  }

  async connect({
    model = "gpt-realtime",
    voice = "",
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
    const resolvedVoice = String(voice || "").trim();
    if (!resolvedVoice) {
      throw new Error("OpenAI realtime voice is required (configure voice.openaiRealtime.voice).");
    }
    const resolvedInputAudioFormat = normalizeOpenAiRealtimeAudioFormat(inputAudioFormat, "input");
    const resolvedOutputAudioFormat = normalizeOpenAiRealtimeAudioFormat(outputAudioFormat, "output");
    const resolvedInputTranscriptionModel =
      String(inputTranscriptionModel || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
    const ws = await this.openSocket(this.buildRealtimeUrl(resolvedModel));
    markRealtimeConnected(this, ws);

    ws.on("message", (payload) => {
      this.lastEventAt = Date.now();
      this.handleIncoming(payload);
    });

    ws.on("error", (error) => {
      handleRealtimeSocketError(this, error, {
        logEvent: "openai_realtime_ws_error"
      });
    });

    ws.on("close", (code, reasonBuffer) => {
      handleRealtimeSocketClose(this, code, reasonBuffer, {
        logEvent: "openai_realtime_ws_closed",
        onClose: () => {
          this.clearActiveResponse();
        }
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
    this.latestVideoFrame = null;
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

  async openSocket(url): Promise<WebSocket> {
    return await openRealtimeSocket({
      url,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      timeoutMessage: "Timed out connecting to OpenAI realtime after 10000ms.",
      connectErrorPrefix: "OpenAI realtime connection failed"
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
      const code = errorPayload?.code ? String(errorPayload.code).trim().toLowerCase() : "";
      if (code === "conversation_already_has_active_response") {
        const match = String(message).match(/\bresp_[a-z0-9]+\b/i);
        if (match?.[0]) {
          this.setActiveResponse(match[0], "in_progress");
        }
      }
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

    if (event.type === "response.created") {
      const response = event.response && typeof event.response === "object" ? event.response : {};
      const responseId = response?.id || event.response_id || null;
      const status = response?.status || event.status || "in_progress";
      this.setActiveResponse(responseId, status);
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
      const response = event.response && typeof event.response === "object" ? event.response : {};
      const responseId = response?.id || event.response_id || null;
      const status = response?.status || event.status || "completed";
      this.finishActiveResponse(responseId, status);
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
        output_modalities: ["audio"]
      }
    });
  }

  appendInputVideoFrame({ mimeType = "image/jpeg", dataBase64 }) {
    const normalizedFrame = String(dataBase64 || "").trim();
    if (!normalizedFrame) return;
    this.latestVideoFrame = {
      mimeType: normalizeImageMimeType(mimeType),
      dataBase64: normalizedFrame,
      at: Date.now()
    };
  }

  requestVideoCommentary(promptText) {
    const prompt = String(promptText || "").trim();
    if (!prompt) return;
    const frame = this.latestVideoFrame;
    if (!frame?.dataBase64) {
      throw new Error("No stream-watch frame buffered for OpenAI realtime commentary.");
    }
    const imageUrl = `data:${frame.mimeType};base64,${frame.dataBase64}`;
    this.send({
      type: "response.create",
      response: {
        conversation: "none",
        output_modalities: ["audio"],
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: prompt
              },
              {
                type: "input_image",
                image_url: imageUrl
              }
            ]
          }
        ]
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
    sendRealtimePayload(this, {
      payload,
      eventType: String(payload?.type || "unknown"),
      summarizeOutboundPayload,
      skipHistoryEventType: "input_audio_buffer.append",
      skipLogEventType: "input_audio_buffer.append",
      logEvent: "openai_realtime_client_event_sent",
      socketNotOpenMessage: "OpenAI realtime socket is not open."
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
    this.latestVideoFrame = null;
    this.clearActiveResponse();
  }

  getState() {
    return {
      ...buildCommonRealtimeState(this),
      activeResponseId: this.activeResponseId || null,
      activeResponseStatus: this.activeResponseStatus || null,
      bufferedVideoFrameAt: this.latestVideoFrame?.at ? new Date(this.latestVideoFrame.at).toISOString() : null
    };
  }

  isResponseInProgress() {
    const status = String(this.activeResponseStatus || "")
      .trim()
      .toLowerCase();
    if (TERMINAL_RESPONSE_STATUSES.has(status)) return false;
    if (status === "in_progress") return true;
    return Boolean(this.activeResponseId);
  }

  log(level, event, metadata = null) {
    if (!this.logger) return;
    this.logger({ level, event, metadata });
  }

  sendSessionUpdate() {
    const session = this.sessionConfig && typeof this.sessionConfig === "object" ? this.sessionConfig : {};
    const resolvedVoice = String(session.voice || "").trim();
    if (!resolvedVoice) {
      throw new Error("OpenAI realtime voice is required (configure voice.openaiRealtime.voice).");
    }
    this.send({
      type: "session.update",
      session: compactObject({
        type: "realtime",
        model: String(session.model || "gpt-realtime").trim() || "gpt-realtime",
        instructions: String(session.instructions || ""),
        output_modalities: ["audio"],
        audio: compactObject({
          input: compactObject({
            format: normalizeOpenAiRealtimeAudioFormat(session.inputAudioFormat, "input"),
            transcription: compactObject({
              model:
                String(session.inputTranscriptionModel || "gpt-4o-mini-transcribe").trim() ||
                "gpt-4o-mini-transcribe"
            })
          }),
          output: compactObject({
            format: normalizeOpenAiRealtimeAudioFormat(session.outputAudioFormat, "output"),
            voice: resolvedVoice
          })
        })
      })
    });
  }

  setActiveResponse(responseId, status = "in_progress") {
    const normalizedId = responseId ? String(responseId).trim() : "";
    const normalizedStatus = String(status || "in_progress").trim() || "in_progress";
    if (normalizedId) {
      this.activeResponseId = normalizedId;
    }
    this.activeResponseStatus = normalizedStatus;
  }

  finishActiveResponse(responseId = null, status = "completed") {
    const normalizedStatus = String(status || "completed")
      .trim()
      .toLowerCase();
    const normalizedId = responseId ? String(responseId).trim() : "";
    if (!normalizedId || !this.activeResponseId || normalizedId === this.activeResponseId) {
      this.clearActiveResponse(normalizedStatus || "completed");
      return;
    }
    if (TERMINAL_RESPONSE_STATUSES.has(normalizedStatus)) {
      this.clearActiveResponse(normalizedStatus);
    }
  }

  clearActiveResponse(status = null) {
    this.activeResponseId = null;
    this.activeResponseStatus = status ? String(status).trim() || null : null;
  }
}

const TERMINAL_RESPONSE_STATUSES = new Set([
  "completed",
  "cancelled",
  "failed",
  "incomplete"
]);

function normalizeOpenAiBaseUrl(value) {
  const raw = String(value || DEFAULT_OPENAI_BASE_URL).trim();
  const normalized = raw || DEFAULT_OPENAI_BASE_URL;
  return normalized.replace(/\/+$/, "");
}

function normalizeOpenAiRealtimeAudioFormat(value, direction = "input") {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const type = String(value.type || "")
      .trim()
      .toLowerCase();
    if (type === "audio/pcmu") {
      return {
        type: "audio/pcmu"
      };
    }
    if (type === "audio/pcma") {
      return {
        type: "audio/pcma"
      };
    }
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
  if (normalized === "g711_ulaw") {
    return {
      type: "audio/pcmu"
    };
  }
  if (normalized === "g711_alaw") {
    return {
      type: "audio/pcma"
    };
  }

  // GA Realtime uses explicit media-type descriptors for PCM.
  // Keep the direction arg in case we need asymmetric defaults later.
  void direction;
  return {
    type: "audio/pcm",
    rate: 24000
  };
}

function normalizeImageMimeType(value) {
  const normalized = String(value || "image/jpeg")
    .trim()
    .toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  if (normalized === "image/png") return "image/png";
  if (normalized === "image/webp") return "image/webp";
  return "image/jpeg";
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

  if (type === "input_audio_buffer.commit") {
    const response = payload.response && typeof payload.response === "object" ? payload.response : null;
    return compactObject({
      type,
      response: response
        ? {
            outputModalities: Array.isArray(response.output_modalities)
              ? response.output_modalities.slice(0, 4)
              : null
          }
        : null
    });
  }

  if (type === "response.create") {
    const response = payload.response && typeof payload.response === "object" ? payload.response : null;
    const inputItems = Array.isArray(response?.input) ? response.input : [];
    const inputTextChars = inputItems.reduce((total, item) => {
      const content = Array.isArray(item?.content) ? item.content : [];
      return (
        total +
        content.reduce((sum, part) => {
          if (part?.type !== "input_text") return sum;
          return sum + String(part?.text || "").length;
        }, 0)
      );
    }, 0);
    const hasInputImage = inputItems.some((item) => {
      const content = Array.isArray(item?.content) ? item.content : [];
      return content.some((part) => part?.type === "input_image");
    });
    return compactObject({
      type,
      response: response
        ? {
            conversation: response.conversation || null,
            outputModalities: Array.isArray(response.output_modalities)
              ? response.output_modalities.slice(0, 4)
              : null,
            inputItems: inputItems.length,
            inputTextChars,
            hasInputImage
          }
        : null
    });
  }

  if (type === "session.update") {
    const session = payload.session && typeof payload.session === "object" ? payload.session : {};
    const audio = session.audio && typeof session.audio === "object" ? session.audio : {};
    return compactObject({
      type,
      sessionType: session.type || null,
      model: session.model || null,
      outputModalities: Array.isArray(session.output_modalities) ? session.output_modalities.slice(0, 4) : null,
      inputAudioFormat: audio?.input?.format || null,
      outputAudioFormat: audio?.output?.format || null,
      outputVoice: audio?.output?.voice || null,
      inputTranscriptionModel: audio?.input?.transcription?.model || null,
      instructionsChars: session.instructions ? String(session.instructions).length : 0
    });
  }

  const preview = safeJsonPreview(payload);
  return compactObject({
    type,
    preview
  });
}
