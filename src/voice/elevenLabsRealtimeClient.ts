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
  safeJsonPreview,
  sendRealtimePayload
} from "./realtimeClientCore.ts";
import type { RealtimeInterruptAcceptanceMode } from "./realtimeInterruptAcceptance.ts";
import { normalizeElevenLabsBaseUrl } from "./realtimeProviderNormalization.ts";

/**
 * ElevenLabs WebSocket TTS streaming client.
 *
 * This is a TTS-only realtime client: the brain LLM (Claude etc.) generates
 * text via the normal generation pipeline, and this client converts it to
 * streaming audio via the ElevenLabs WebSocket text-to-speech API.
 *
 * Protocol:
 *   Connect -> wss://{host}/v1/text-to-speech/{voice_id}/stream-input?...
 *   Init    -> { text: " ", voice_settings, generation_config }
 *   Text    -> { text: "...", flush: true }
 *   Recv    <- { audio: "<base64>" } | { isFinal: true }
 *   Close   -> { text: "" }
 *
 * Audio output is emitted as "audio_delta" events (base64-encoded PCM)
 * which sessionLifecycle.ts pipes to clankvox -> Discord.
 */

const DEFAULT_CHUNK_SCHEDULE = [50, 120, 200, 260];

export class ElevenLabsRealtimeClient extends EventEmitter {
  apiKey;
  baseUrl;
  logger;
  ws: WebSocket | null;
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
  audioBase64Buffer: Buffer | null;

  private _responseInProgress = false;
  private _utteranceCounter = 0;

  constructor({ apiKey, baseUrl = null, logger = null }) {
    super();
    this.apiKey = String(apiKey || "").trim();
    this.baseUrl = normalizeElevenLabsBaseUrl(baseUrl);
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
    this.audioBase64Buffer = null;
  }

  async connect({
    voiceId = "",
    model = "eleven_multilingual_v2",
    outputFormat = "pcm_24000",
    outputSampleRateHz = 24000,
    voiceSettings = null as { stability?: number; similarity_boost?: number; style?: number; speed?: number } | null,
    chunkLengthSchedule = DEFAULT_CHUNK_SCHEDULE as number[]
  } = {}) {
    if (!this.apiKey) {
      throw new Error("Missing ELEVENLABS_API_KEY for ElevenLabs realtime TTS.");
    }
    const resolvedVoiceId = String(voiceId || "").trim();
    if (!resolvedVoiceId) {
      throw new Error("ElevenLabs realtime TTS requires a voice_id.");
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.getState();
    }

    // Build WebSocket URL with query params
    const httpBaseUrl = normalizeElevenLabsBaseUrl(this.baseUrl);
    const wsBaseUrl = httpBaseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
    const wsUrl = new URL(`/v1/text-to-speech/${encodeURIComponent(resolvedVoiceId)}/stream-input`, wsBaseUrl);
    wsUrl.searchParams.set("model_id", String(model || "eleven_multilingual_v2").trim());
    wsUrl.searchParams.set("output_format", String(outputFormat || "pcm_24000").trim());
    // Keep inactivity timeout generous — we may pause between utterances
    wsUrl.searchParams.set("inactivity_timeout", "120");

    const ws = await openRealtimeSocket({
      url: wsUrl.toString(),
      headers: {
        "xi-api-key": this.apiKey
      },
      timeoutMessage: "Timed out connecting to ElevenLabs TTS WebSocket after 10000ms.",
      connectErrorPrefix: "ElevenLabs TTS WebSocket connection failed"
    });
    markRealtimeConnected(this, ws);

    ws.on("message", (payload) => {
      this.lastEventAt = Date.now();
      this.handleIncoming(payload);
    });

    ws.on("error", (error) => {
      handleRealtimeSocketError(this, error, {
        logEvent: "elevenlabs_realtime_ws_error"
      });
    });

    ws.on("close", (code, reasonBuffer) => {
      handleRealtimeSocketClose(this, code, reasonBuffer, {
        logEvent: "elevenlabs_realtime_ws_closed"
      });
    });

    this.sessionConfig = {
      voiceId: resolvedVoiceId,
      model: String(model || "eleven_multilingual_v2").trim(),
      outputFormat: String(outputFormat || "pcm_24000").trim(),
      outputSampleRateHz: Number(outputSampleRateHz) || 24000,
      voiceSettings: voiceSettings && typeof voiceSettings === "object"
        ? { ...voiceSettings }
        : null,
      chunkLengthSchedule: Array.isArray(chunkLengthSchedule)
        ? chunkLengthSchedule.map(Number).filter(Number.isFinite)
        : DEFAULT_CHUNK_SCHEDULE.slice()
    };

    // Initialize the connection: first message must have text=" " (space)
    const initPayload: Record<string, unknown> = {
      text: " "
    };
    if (this.sessionConfig.voiceSettings) {
      initPayload.voice_settings = compactObject(this.sessionConfig.voiceSettings);
    }
    if (this.sessionConfig.chunkLengthSchedule.length > 0) {
      initPayload.generation_config = {
        chunk_length_schedule: this.sessionConfig.chunkLengthSchedule
      };
    }
    this.send(initPayload, "init");

    return this.getState();
  }

  handleIncoming(payload: unknown) {
    let event: Record<string, unknown> | null = null;

    try {
      event = JSON.parse(String(payload || ""));
    } catch {
      return;
    }

    if (!event || typeof event !== "object") return;

    // Audio output chunk: { audio: "<base64>", alignment?: ..., normalizedAlignment?: ... }
    if (typeof event.audio === "string" && event.audio) {
      this.emit("audio_delta", event.audio);
      return;
    }

    // Final marker: { isFinal: true }
    if (event.isFinal === true) {
      this._responseInProgress = false;
      this.activeResponseStatus = "completed";
      this.emit("response_done", event);
      return;
    }

    // Error from the server
    if (typeof event.error === "string" || typeof event.message === "string") {
      const errorMessage = String(event.error || event.message || "Unknown ElevenLabs TTS error");
      this.lastError = errorMessage;
      this.log("warn", "elevenlabs_realtime_error_event", {
        error: errorMessage,
        event: safeJsonPreview(event)
      });
      this.emit("error_event", {
        message: errorMessage,
        event
      });
    }
  }

  /**
   * Send text to be spoken via the WebSocket.
   * This is the primary method for TTS-only mode.
   * The text is sent with flush=true so ElevenLabs generates audio immediately
   * for whatever text has been buffered.
   */
  requestPlaybackUtterance(promptText: string) {
    const text = String(promptText || "").trim();
    if (!text) return;

    this._utteranceCounter += 1;
    const utteranceId = `el_utt_${this._utteranceCounter}`;
    this._responseInProgress = true;
    this.activeResponseId = utteranceId;
    this.activeResponseStatus = "in_progress";

    // Send text with flush to trigger immediate generation.
    // ElevenLabs expects text to end with a trailing space for best continuity.
    this.send({
      text: text + " ",
      flush: true
    }, "text");
  }

  /**
   * For TTS-only providers, requestTextUtterance is identical to
   * requestPlaybackUtterance — we just render the text as speech.
   */
  requestTextUtterance(promptText: string) {
    this.requestPlaybackUtterance(promptText);
  }

  // --- Methods required by the interface but mostly no-ops for TTS-only ---

  /**
   * ElevenLabs TTS doesn't accept audio input. No-op.
   */
  appendInputAudioPcm(_audioBuffer: Buffer) {
    // ElevenLabs TTS WebSocket is output-only — audio input goes through
    // a separate ASR bridge (OpenAI transcription, etc.)
  }

  appendInputAudioBase64(_audioBase64: string) {
    // No-op for TTS-only provider
  }

  commitInputAudioBuffer() {
    // No-op for TTS-only provider
  }

  createAudioResponse() {
    // No-op — TTS is driven by requestPlaybackUtterance/requestTextUtterance
  }

  cancelActiveResponse(): boolean {
    // ElevenLabs WebSocket doesn't support cancelling mid-stream.
    // The best we can do is close and reconnect, but that's handled at
    // the session level via barge-in suppression.
    this._responseInProgress = false;
    this.activeResponseStatus = "cancelled";
    return false;
  }

  isResponseInProgress(): boolean {
    return this._responseInProgress;
  }

  getInterruptAcceptanceMode(): RealtimeInterruptAcceptanceMode {
    // ElevenLabs can't cancel in-flight audio via the API, so we use
    // local cut with async confirmation (same as Gemini).
    return "local_cut_async_confirmation";
  }

  clearActiveResponse(status: string | null = null) {
    this._responseInProgress = false;
    this.activeResponseId = null;
    this.activeResponseStatus = status ? String(status).trim() || null : null;
  }

  send(payload: Record<string, unknown>, eventType: string | null = null) {
    const resolvedType = eventType || "text";
    sendRealtimePayload(this, {
      payload,
      eventType: resolvedType,
      summarizeOutboundPayload: summarizeElevenLabsOutbound,
      skipHistoryEventType: null,
      skipLogEventType: null,
      logEvent: "elevenlabs_realtime_client_event_sent",
      socketNotOpenMessage: "ElevenLabs TTS WebSocket is not open."
    });
  }

  async close() {
    if (!this.ws) return;
    if (this.ws.readyState === WebSocket.CLOSED) {
      this.ws = null;
      return;
    }

    // Send the close-connection message (empty text)
    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ text: "" }));
      }
    } catch {
      // ignore
    }

    await closeRealtimeSocket(this.ws);
    this.ws = null;
    this.audioBase64Buffer = null;
    this.clearActiveResponse();
  }

  getState() {
    return {
      ...buildCommonRealtimeState(this),
      activeResponseId: this.activeResponseId || null,
      activeResponseStatus: this.activeResponseStatus || null,
      utteranceCount: this._utteranceCounter,
      model: this.sessionConfig?.model || null
    };
  }

  log(level: string, event: string, metadata: Record<string, unknown> | null = null) {
    if (!this.logger) return;
    this.logger({ level, event, metadata });
  }
}

function summarizeElevenLabsOutbound(payload: Record<string, unknown> | null) {
  if (!payload || typeof payload !== "object") return null;
  const text = typeof payload.text === "string" ? payload.text : null;
  const flush = Boolean(payload.flush);
  const hasVoiceSettings = Boolean(payload.voice_settings);
  const hasGenerationConfig = Boolean(payload.generation_config);

  if (text === " " && (hasVoiceSettings || hasGenerationConfig)) {
    return compactObject({
      type: "init",
      hasVoiceSettings,
      hasGenerationConfig
    });
  }

  if (text === "") {
    return { type: "close" };
  }

  return compactObject({
    type: "text",
    textChars: text ? text.trim().length : 0,
    flush
  });
}
