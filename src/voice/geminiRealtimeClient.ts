import { EventEmitter } from "node:events";
import WebSocket from "ws";

const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const GEMINI_LIVE_PATH = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_OUTBOUND_EVENT_HISTORY = 8;
const MAX_EVENT_PREVIEW_CHARS = 280;

export class GeminiRealtimeClient extends EventEmitter {
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
  setupComplete;
  pendingResponseActive;
  audioActivityOpen;

  constructor({ apiKey, baseUrl = DEFAULT_GEMINI_BASE_URL, logger = null }) {
    super();
    this.apiKey = String(apiKey || "").trim();
    this.baseUrl = String(baseUrl || DEFAULT_GEMINI_BASE_URL).trim() || DEFAULT_GEMINI_BASE_URL;
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
    this.setupComplete = false;
    this.pendingResponseActive = false;
    this.audioActivityOpen = false;
  }

  async connect({
    model = "gemini-2.5-flash-native-audio-preview-12-2025",
    voice = "Aoede",
    instructions = "",
    inputSampleRateHz = 16000,
    outputSampleRateHz = 24000
  } = {}) {
    if (!this.apiKey) {
      throw new Error("Missing GOOGLE_API_KEY for Gemini realtime voice runtime.");
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.getState();
    }

    const resolvedModel = ensureGeminiModelPrefix(String(model || "").trim() || "gemini-2.5-flash-native-audio-preview-12-2025");
    const resolvedVoice = String(voice || "Aoede").trim() || "Aoede";
    const resolvedInputRate = Math.max(8000, Math.min(48000, Number(inputSampleRateHz) || 16000));
    const resolvedOutputRate = Math.max(8000, Math.min(48000, Number(outputSampleRateHz) || 24000));
    const ws = await this.openSocket(this.buildRealtimeUrl());

    this.ws = ws;
    this.connectedAt = Date.now();
    this.lastEventAt = Date.now();
    this.lastError = null;
    this.setupComplete = false;
    this.pendingResponseActive = false;
    this.audioActivityOpen = false;

    ws.on("message", (payload) => {
      this.lastEventAt = Date.now();
      this.handleIncoming(payload);
    });

    ws.on("error", (error) => {
      this.lastEventAt = Date.now();
      this.lastError = String(error?.message || error);
      this.log("warn", "gemini_realtime_ws_error", { error: this.lastError });
      this.emit("socket_error", {
        message: this.lastError
      });
    });

    ws.on("close", (code, reasonBuffer) => {
      this.lastEventAt = Date.now();
      this.lastCloseCode = Number(code) || null;
      this.lastCloseReason = reasonBuffer ? String(reasonBuffer) : null;
      this.pendingResponseActive = false;
      this.audioActivityOpen = false;
      this.log("info", "gemini_realtime_ws_closed", {
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
      inputSampleRateHz: resolvedInputRate,
      outputSampleRateHz: resolvedOutputRate,
      inputAudioMimeType: `audio/pcm;rate=${resolvedInputRate}`,
      outputAudioMimeType: `audio/pcm;rate=${resolvedOutputRate}`
    };

    this.sendSetup();

    return this.getState();
  }

  buildRealtimeUrl() {
    const base = normalizeGeminiBaseUrl(this.baseUrl);
    const url = new URL(base);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    url.pathname = GEMINI_LIVE_PATH;
    url.searchParams.set("key", this.apiKey);
    return url.toString();
  }

  async openSocket(url) {
    return await new Promise((resolve, reject) => {
      let settled = false;

      const ws = new WebSocket(String(url), {
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey
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
        reject(new Error(`Timed out connecting to Gemini Live API after ${CONNECT_TIMEOUT_MS}ms.`));
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
        reject(new Error(`Gemini Live API connection failed: ${String(error?.message || error)}`));
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

    if (event.setupComplete && typeof event.setupComplete === "object") {
      this.setupComplete = true;
      this.log("info", "gemini_realtime_setup_complete", {
        model: this.sessionConfig?.model || null
      });
      return;
    }

    if (event.error) {
      const message =
        event.error?.message ||
        event.error?.status ||
        event.error?.code ||
        event.message ||
        "Unknown Gemini realtime error";
      this.lastError = String(message);
      const errorMetadata = {
        error: this.lastError,
        code: event.error?.code || null,
        status: event.error?.status || null,
        lastOutboundEventType: this.lastOutboundEventType || null,
        lastOutboundEvent: this.lastOutboundEvent || null,
        recentOutboundEvents: this.recentOutboundEvents.slice(-4)
      };
      this.log("warn", "gemini_realtime_error_event", {
        ...errorMetadata
      });
      this.emit("error_event", {
        message: this.lastError,
        code: event.error?.code || null,
        param: null,
        event,
        lastOutboundEventType: this.lastOutboundEventType || null,
        lastOutboundEvent: this.lastOutboundEvent || null,
        recentOutboundEvents: this.recentOutboundEvents.slice(-4)
      });
      return;
    }

    const serverContent = event.serverContent && typeof event.serverContent === "object"
      ? event.serverContent
      : null;
    if (!serverContent) return;

    const modelTurn = serverContent.modelTurn && typeof serverContent.modelTurn === "object"
      ? serverContent.modelTurn
      : null;
    const parts = Array.isArray(modelTurn?.parts) ? modelTurn.parts : [];

    for (const part of parts) {
      const audioBase64 = part?.inlineData?.data;
      if (typeof audioBase64 === "string" && audioBase64.trim()) {
        this.emit("audio_delta", audioBase64.trim());
      }

      const text = part?.text;
      if (typeof text === "string" && text.trim()) {
        this.emit("transcript", {
          text: text.trim(),
          eventType: "server_content_text"
        });
      }
    }

    const inputTranscription = serverContent.inputTranscription?.text;
    if (typeof inputTranscription === "string" && inputTranscription.trim()) {
      this.emit("transcript", {
        text: inputTranscription.trim(),
        eventType: "input_audio_transcription"
      });
    }

    const outputTranscription = serverContent.outputTranscription?.text;
    if (typeof outputTranscription === "string" && outputTranscription.trim()) {
      this.emit("transcript", {
        text: outputTranscription.trim(),
        eventType: "output_audio_transcription"
      });
    }

    if (serverContent.turnComplete || serverContent.generationComplete || serverContent.interrupted) {
      this.pendingResponseActive = false;
      this.emit("response_done", {
        type: "response.done",
        response: {
          id: null,
          status: serverContent.interrupted ? "interrupted" : "completed"
        },
        serverContent
      });
    }
  }

  appendInputAudioPcm(audioBuffer) {
    if (!audioBuffer || !audioBuffer.length) return;
    this.appendInputAudioBase64(audioBuffer.toString("base64"));
  }

  appendInputAudioBase64(audioBase64) {
    if (!audioBase64) return;
    if (!this.audioActivityOpen) {
      this.sendRealtimeInput({
        activityStart: {}
      });
      this.audioActivityOpen = true;
    }
    this.sendRealtimeInput({
      mediaChunks: [
        {
          mimeType: String(this.sessionConfig?.inputAudioMimeType || "audio/pcm;rate=16000"),
          data: String(audioBase64)
        }
      ]
    });
  }

  appendInputVideoFrame({ mimeType = "image/jpeg", dataBase64 }) {
    const data = String(dataBase64 || "").trim();
    if (!data) return;

    this.sendRealtimeInput({
      mediaChunks: [
        {
          mimeType: String(mimeType || "image/jpeg").trim() || "image/jpeg",
          data
        }
      ]
    });
  }

  commitInputAudioBuffer() {
    if (!this.audioActivityOpen) return;
    this.sendRealtimeInput({
      activityEnd: {}
    });
    this.audioActivityOpen = false;
  }

  createAudioResponse() {
    this.pendingResponseActive = true;
  }

  requestVideoCommentary(promptText) {
    const prompt = String(promptText || "").trim();
    if (!prompt) return;

    this.pendingResponseActive = true;
    this.send({
      clientContent: {
        turns: [
          {
            role: "user",
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],
        turnComplete: true
      }
    });
  }

  sendRealtimeInput(payload = {}) {
    this.send({
      realtimeInput: payload
    });
  }

  updateInstructions(instructions = "") {
    if (!this.sessionConfig || typeof this.sessionConfig !== "object") {
      throw new Error("Gemini realtime session config is not initialized.");
    }

    this.sessionConfig = {
      ...this.sessionConfig,
      instructions: String(instructions || "")
    };
  }

  sendSetup() {
    const session = this.sessionConfig && typeof this.sessionConfig === "object" ? this.sessionConfig : {};
    this.send({
      setup: compactObject({
        model: ensureGeminiModelPrefix(String(session.model || "gemini-2.5-flash-native-audio-preview-12-2025")),
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: String(session.voice || "Aoede")
              }
            }
          }
        },
        systemInstruction: {
          role: "system",
          parts: [
            {
              text: String(session.instructions || "")
            }
          ]
        },
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: true
          }
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {}
      })
    });
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Gemini realtime socket is not open.");
    }

    const eventType = summarizeGeminiEventType(payload);
    this.lastOutboundEventType = eventType;
    this.lastOutboundEventAt = Date.now();
    this.recordOutboundEvent(payload);
    if (eventType !== "realtimeInput.mediaChunks") {
      this.log("info", "gemini_realtime_client_event_sent", {
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
    this.pendingResponseActive = false;
    this.audioActivityOpen = false;
  }

  getState() {
    return {
      connected: Boolean(this.ws && this.ws.readyState === WebSocket.OPEN),
      connectedAt: this.connectedAt ? new Date(this.connectedAt).toISOString() : null,
      lastEventAt: this.lastEventAt ? new Date(this.lastEventAt).toISOString() : null,
      sessionId: this.sessionId,
      setupComplete: this.setupComplete,
      lastError: this.lastError,
      lastCloseCode: this.lastCloseCode,
      lastCloseReason: this.lastCloseReason,
      lastOutboundEventType: this.lastOutboundEventType || null,
      lastOutboundEventAt: this.lastOutboundEventAt ? new Date(this.lastOutboundEventAt).toISOString() : null,
      lastOutboundEvent: this.lastOutboundEvent || null,
      recentOutboundEvents: this.recentOutboundEvents.slice(-4),
      pendingResponseActive: this.pendingResponseActive
    };
  }

  isResponseInProgress() {
    return Boolean(this.pendingResponseActive);
  }

  log(level, event, metadata = null) {
    if (!this.logger) return;
    this.logger({ level, event, metadata });
  }

  recordOutboundEvent(payload) {
    const eventType = summarizeGeminiEventType(payload);
    const summarizedPayload = summarizeOutboundPayload(payload);
    const event = compactObject({
      type: eventType,
      at: this.lastOutboundEventAt ? new Date(this.lastOutboundEventAt).toISOString() : null,
      payload: summarizedPayload
    });
    this.lastOutboundEvent = event;
    if (eventType === "realtimeInput.mediaChunks") return;
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

function summarizeGeminiEventType(payload) {
  if (!payload || typeof payload !== "object") return "unknown";
  if (payload.setup) return "setup";
  if (payload.clientContent) return "clientContent";
  if (payload.realtimeInput?.mediaChunks) return "realtimeInput.mediaChunks";
  if (payload.realtimeInput?.activityStart) return "realtimeInput.activityStart";
  if (payload.realtimeInput?.activityEnd) return "realtimeInput.activityEnd";
  if (payload.realtimeInput) return "realtimeInput";
  return "unknown";
}

function summarizeOutboundPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const type = summarizeGeminiEventType(payload);

  if (type === "realtimeInput.mediaChunks") {
    const chunks = Array.isArray(payload?.realtimeInput?.mediaChunks)
      ? payload.realtimeInput.mediaChunks
      : [];
    const first = chunks[0] && typeof chunks[0] === "object" ? chunks[0] : null;
    return compactObject({
      type,
      chunkCount: chunks.length,
      mimeType: first?.mimeType || null,
      dataChars: typeof first?.data === "string" ? first.data.length : 0
    });
  }

  if (type === "setup") {
    const setup = payload.setup && typeof payload.setup === "object" ? payload.setup : {};
    return compactObject({
      type,
      model: setup.model || null,
      instructionsChars: Array.isArray(setup?.systemInstruction?.parts)
        ? setup.systemInstruction.parts
            .map((part) => (typeof part?.text === "string" ? part.text.length : 0))
            .reduce((sum, value) => sum + value, 0)
        : 0
    });
  }

  if (type === "clientContent") {
    const turns = Array.isArray(payload?.clientContent?.turns)
      ? payload.clientContent.turns
      : [];
    const firstPart = turns[0]?.parts?.[0];
    return compactObject({
      type,
      turnCount: turns.length,
      turnComplete: payload?.clientContent?.turnComplete === true,
      firstPartTextChars: typeof firstPart?.text === "string" ? firstPart.text.length : 0
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

function normalizeGeminiBaseUrl(value) {
  const raw = String(value || DEFAULT_GEMINI_BASE_URL).trim();
  const fallback = DEFAULT_GEMINI_BASE_URL;
  if (!raw) return fallback;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return fallback;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return fallback;
  }
}

function ensureGeminiModelPrefix(model) {
  const normalized = String(model || "").trim();
  if (!normalized) return "models/gemini-2.5-flash-native-audio-preview-12-2025";
  if (normalized.startsWith("models/")) return normalized;
  return `models/${normalized}`;
}
