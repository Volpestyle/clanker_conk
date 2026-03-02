import { EventEmitter } from "node:events";
import {
  AudioPlayerStatus,
  createAudioResource,
  StreamType
} from "@discordjs/voice";
import OpusScript from "opusscript";
import { parseSoundboardReference } from "./soundboardDirector.ts";
import {
  AUDIO_PLAYBACK_STREAM_HIGH_WATER_MARK_BYTES,
  DISCORD_PCM_FRAME_BYTES
} from "./voiceSessionManager.constants.ts";
import {
  normalizeVoiceRuntimeMode,
  normalizeVoiceProvider,
  normalizeBrainProvider,
  normalizeTranscriberProvider,
  VOICE_RUNTIME_MODES
} from "./voiceModes.ts";

type VoiceRuntimeMode = (typeof VOICE_RUNTIME_MODES)[number];
import { normalizeWhitespaceText } from "../normalization/text.ts";

export const REALTIME_MEMORY_FACT_LIMIT = 8;
export const SOUNDBOARD_MAX_CANDIDATES = 40;
const OPENAI_REALTIME_MIN_COMMIT_AUDIO_MS = 100;
const SOUNDBOARD_DIRECTIVE_RE = /\[\[SOUNDBOARD:\s*([\s\S]*?)\s*\]\]/gi;
const MAX_SOUNDBOARD_DIRECTIVE_REF_LEN = 180;
const ASR_LANGUAGE_BIAS_PROMPT_MAX_LEN = 280;
const PRIMARY_WAKE_TOKEN_MIN_LEN = 4;
const EN_WAKE_PRIMARY_GENERIC_TOKENS = new Set(["bot", "ai", "assistant"]);
const EN_VOCATIVE_GREETING_TOKENS = new Set([
  "hey",
  "hi",
  "yo",
  "sup",
  "hello",
  "hola"
]);
const EN_VOCATIVE_IGNORE_TOKENS = new Set(["guys", "everyone", "all", "chat", "yall", "yaall"]);
const VOICE_ASR_LANGUAGE_MODES = new Set(["auto", "fixed"]);
const OPUS_FRAME_SAMPLES = 960;
const AUDIO_DEBUG = !!process.env.AUDIO_DEBUG;

/**
 * PCM-to-Opus bridge that bypasses Bun's broken stream.pipeline().
 *
 * Accepts stereo 48 kHz 16-bit PCM via write(), encodes each 20 ms frame
 * with opusscript, and pushes the resulting Opus packets into an internal
 * object-mode Readable. Pass `.readable` to createAudioResource with
 * StreamType.Opus so Discord.js wraps the single stream directly (no
 * pipeline call).
 */
const OPUS_SET_BITRATE = 4002;
const OPUS_SET_FEC = 4012;
const OPUS_BITRATE = 64000;

/**
 * Minimal Readable-like stream backed by a plain array queue.
 * Bun's Readable in object-mode has bugs (read() returning null when data
 * exists, wrong `readable` property, etc.) so we implement only the subset
 * that Discord.js AudioPlayer actually calls:
 *   .read()  .readable  .readableEnded  .readableObjectMode  .destroyed
 *   .on/.once/.off/.removeListener  .destroy()
 */
class OpusPacketReadable extends EventEmitter {
  _queue: Buffer[] = [];
  readable = true;
  readableEnded = false;
  readableObjectMode = true;
  destroyed = false;

  // Diagnostic counters
  _totalPushed = 0;
  _totalRead = 0;
  _underruns = 0;
  _peakQueue = 0;
  _createdAt = Date.now();

  // Read-timing diagnostics (behind AUDIO_DEBUG)
  _lastReadAt = 0;
  _readIntervalMin = Infinity;
  _readIntervalMax = 0;
  _readIntervalSum = 0;
  _readIntervalCount = 0;
  _burstReads = 0;       // reads < 5ms apart (audio cycle catching up)
  _stallReads = 0;       // reads > 50ms apart (event loop blocked)

  // Push-timing diagnostics (behind AUDIO_DEBUG)
  _lastPushAt = 0;
  _pushBursts = 0;       // pushes < 2ms apart (WebSocket batching)
  _pushGapMax = 0;       // largest gap between pushes

  get queuedPackets() {
    return this._queue.length;
  }

  read() {
    if (this.destroyed) return null;
    const packet = this._queue.shift() ?? null;
    if (packet !== null) {
      this._totalRead++;
      if (AUDIO_DEBUG) {
        const now = Date.now();
        if (this._lastReadAt > 0) {
          const gap = now - this._lastReadAt;
          if (gap < this._readIntervalMin) this._readIntervalMin = gap;
          if (gap > this._readIntervalMax) this._readIntervalMax = gap;
          this._readIntervalSum += gap;
          this._readIntervalCount++;
          if (gap < 5) this._burstReads++;
          if (gap > 50) this._stallReads++;
        }
        this._lastReadAt = now;
      }
    } else {
      this._underruns++;
    }
    return packet;
  }

  push(packet: Buffer | null) {
    if (this.destroyed) return;
    if (packet === null) {
      this.readableEnded = true;
      this.readable = false;
      this.emit("end");
      return;
    }
    this._totalPushed++;
    if (AUDIO_DEBUG) {
      const now = Date.now();
      if (this._lastPushAt > 0) {
        const gap = now - this._lastPushAt;
        if (gap < 2) this._pushBursts++;
        if (gap > this._pushGapMax) this._pushGapMax = gap;
      }
      this._lastPushAt = now;
    }
    const wasEmpty = this._queue.length === 0;
    this._queue.push(packet);
    if (this._queue.length > this._peakQueue) {
      this._peakQueue = this._queue.length;
    }
    if (wasEmpty) {
      this.emit("readable");
    }
  }

  destroy() {
    if (this.destroyed) return;
    if (AUDIO_DEBUG) {
      const lifetimeMs = Date.now() - this._createdAt;
      const remaining = this._queue.length;
      const avgInterval = this._readIntervalCount > 0
        ? (this._readIntervalSum / this._readIntervalCount).toFixed(1)
        : "n/a";
      console.log(
        `[opus-queue] destroyed pushed=${this._totalPushed} read=${this._totalRead}` +
        ` underruns=${this._underruns} peak=${this._peakQueue}` +
        ` remaining=${remaining} lifetimeMs=${lifetimeMs}` +
        ` readTiming={min=${this._readIntervalMin === Infinity ? "n/a" : this._readIntervalMin}` +
        ` max=${this._readIntervalMax} avg=${avgInterval}` +
        ` bursts=${this._burstReads} stalls=${this._stallReads}}` +
        ` pushTiming={bursts=${this._pushBursts} gapMax=${this._pushGapMax}}`
      );
    }
    this.destroyed = true;
    this.readable = false;
    this._queue.length = 0;
    this.emit("close");
  }
}

class OpusPcmBridge extends EventEmitter {
  readable: OpusPacketReadable;
  destroyed = false;
  writableEnded = false;
  writableFinished = false;
  closed = false;
  writableHighWaterMark;
  _encoder;
  _pcmBuffer = Buffer.alloc(0);

  constructor(highWaterMark) {
    super();
    this.writableHighWaterMark = highWaterMark;
    this._encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
    try { this._encoder.encoderCTL(OPUS_SET_BITRATE, OPUS_BITRATE); } catch { /* ignore */ }
    try { this._encoder.encoderCTL(OPUS_SET_FEC, 1); } catch { /* ignore */ }
    this.readable = new OpusPacketReadable();

    // When AudioPlayer destroys the readable side (e.g. state transition
    // to Idle), propagate to the bridge so health checks see
    // destroyed === true and recreate the stream.
    this.readable.once("close", () => {
      if (!this.destroyed) {
        this.destroyed = true;
        this.closed = true;
        this._cleanup();
        this.emit("close");
      }
    });
  }

  // Report only the PCM remainder awaiting encoding. The Opus packets
  // already pushed to `readable` are on the *read* side (consumed by
  // AudioPlayer at 20 ms ticks) and must NOT inflate this value —
  // the overflow guard threshold (30 frames / 600 ms) was calibrated
  // for write-side back-pressure only.
  get writableLength() {
    if (this.destroyed) return 0;
    return this._pcmBuffer.length;
  }

  get queuedPackets() {
    if (this.destroyed) return 0;
    return this.readable.queuedPackets;
  }

  write(chunk) {
    if (this.destroyed || this.writableEnded) return false;
    this._pcmBuffer = Buffer.concat([this._pcmBuffer, chunk]);
    this._drainFrames();
    return this.writableLength < this.writableHighWaterMark;
  }

  _drainFrames() {
    while (this._pcmBuffer.length >= DISCORD_PCM_FRAME_BYTES) {
      const frame = this._pcmBuffer.subarray(0, DISCORD_PCM_FRAME_BYTES);
      this._pcmBuffer = this._pcmBuffer.subarray(DISCORD_PCM_FRAME_BYTES);
      try {
        const opusPacket = this._encoder.encode(frame, OPUS_FRAME_SAMPLES);
        if (!this.readable.destroyed) {
          this.readable.push(Buffer.from(opusPacket));
        }
      } catch {
        // skip frame on encode error
      }
    }
  }

  end() {
    if (this.writableEnded) return;
    this.writableEnded = true;
    this.writableFinished = true;
    this._drainFrames();
    if (!this.readable.destroyed) {
      this.readable.push(null);
    }
    this.emit("finish");
    this.emit("end");
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.closed = true;
    this._cleanup();
    if (!this.readable.destroyed) {
      this.readable.destroy();
    }
    this.emit("close");
  }

  _cleanup() {
    this._pcmBuffer = Buffer.alloc(0);
    try { this._encoder?.delete?.(); } catch { /* ignore */ }
    this._encoder = null;
  }
}

export function createBotAudioPlaybackStream() {
  return new OpusPcmBridge(AUDIO_PLAYBACK_STREAM_HIGH_WATER_MARK_BYTES);
}

export function parseRealtimeErrorPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      message: String(payload || "unknown realtime error"),
      code: null,
      param: null,
      lastOutboundEventType: null,
      lastOutboundEvent: null,
      recentOutboundEvents: null
    };
  }

  const message = String(payload.message || "unknown realtime error");
  const code = payload.code ? String(payload.code) : null;
  const param =
    payload.param !== undefined && payload.param !== null
      ? String(payload.param)
      : payload?.event?.error?.param
        ? String(payload.event.error.param)
        : null;
  const lastOutboundEventType = payload.lastOutboundEventType
    ? String(payload.lastOutboundEventType)
    : null;
  const lastOutboundEvent =
    payload.lastOutboundEvent && typeof payload.lastOutboundEvent === "object"
      ? payload.lastOutboundEvent
      : null;
  const recentOutboundEvents = Array.isArray(payload.recentOutboundEvents)
    ? payload.recentOutboundEvents.slice(-4)
    : null;
  return {
    message,
    code,
    param,
    lastOutboundEventType,
    lastOutboundEvent,
    recentOutboundEvents
  };
}

export function isRecoverableRealtimeError({ mode, code, message }) {
  const normalizedMode = String(mode || "")
    .trim()
    .toLowerCase();
  if (normalizedMode !== "openai_realtime") return false;

  const normalizedCode = String(code || "")
    .trim()
    .toLowerCase();
  if (normalizedCode === "input_audio_buffer_commit_empty") return true;
  if (normalizedCode === "conversation_already_has_active_response") return true;
  if (normalizedCode === "response_cancel_not_active") return true;

  const normalizedMessage = String(message || "")
    .trim()
    .toLowerCase();
  if (!normalizedMessage) return false;
  if (normalizedMessage.includes("active response in progress")) return true;
  if (normalizedMessage.includes("no active response found")) return true;
  return normalizedMessage.includes("input audio buffer") && normalizedMessage.includes("buffer too small");
}

export function getRealtimeCommitMinimumBytes(mode, sampleRateHz = 24000) {
  const normalizedMode = String(mode || "")
    .trim()
    .toLowerCase();
  if (normalizedMode !== "openai_realtime") return 1;
  const hz = Math.max(8_000, Number(sampleRateHz) || 24_000);
  const bytesPerSecond = hz * 2;
  const minBytes = Math.ceil((bytesPerSecond * OPENAI_REALTIME_MIN_COMMIT_AUDIO_MS) / 1000);
  return Math.max(1, minBytes);
}

export function parseResponseDoneId(event) {
  if (!event || typeof event !== "object") return null;
  const direct = event.response_id || event.id || null;
  const nested = event.response?.id || null;
  const value = nested || direct;
  if (!value) return null;
  return String(value);
}

export function parseResponseDoneStatus(event) {
  if (!event || typeof event !== "object") return null;
  const status = event.response?.status || event.status || null;
  if (!status) return null;
  return String(status);
}

export function parseResponseDoneModel(event) {
  if (!event || typeof event !== "object") return null;
  const model = event.response?.model || null;
  if (!model) return null;
  return String(model);
}

export function parseResponseDoneUsage(event) {
  if (!event || typeof event !== "object") return null;
  const response = event.response && typeof event.response === "object" ? event.response : null;
  const usage = response?.usage && typeof response.usage === "object" ? response.usage : null;
  if (!usage) return null;

  const inputDetails =
    usage.input_token_details && typeof usage.input_token_details === "object"
      ? usage.input_token_details
      : {};
  const outputDetails =
    usage.output_token_details && typeof usage.output_token_details === "object"
      ? usage.output_token_details
      : {};

  return {
    inputTokens: clampUsageTokenCount(usage.input_tokens),
    outputTokens: clampUsageTokenCount(usage.output_tokens),
    totalTokens: clampUsageTokenCount(usage.total_tokens),
    cacheReadTokens: clampUsageTokenCount(inputDetails.cached_tokens),
    inputAudioTokens: clampUsageTokenCount(inputDetails.audio_tokens),
    inputTextTokens: clampUsageTokenCount(inputDetails.text_tokens),
    outputAudioTokens: clampUsageTokenCount(outputDetails.audio_tokens),
    outputTextTokens: clampUsageTokenCount(outputDetails.text_tokens)
  };
}

export function ensureBotAudioPlaybackReady({
  session,
  store = null,
  botUserId = null,
  onStreamCreated = null,
  activatePlayback = true,
  minQueueDepth = 0
}) {
  if (!session || !session.audioPlayer || !session.connection) return false;

  const streamOk = session.botAudioStream
    && !session.botAudioStream.destroyed
    && !session.botAudioStream.writableEnded
    && typeof session.botAudioStream.write === "function";

  if (!streamOk) {
    const prev = session.botAudioStream;
    session.botAudioStream = createBotAudioPlaybackStream();
    if (typeof onStreamCreated === "function") {
      onStreamCreated(session.botAudioStream, prev);
    }
  }

  if (activatePlayback) {
    const status = session.audioPlayer.state?.status;
    // Only restart from Idle.  AutoPaused auto-resumes when the Readable has
    // data — calling play() while AutoPaused would create a new AudioResource
    // and Discord.js destroys the *old* resource's playStream (our Readable),
    // wiping all buffered Opus packets and causing mid-response audio gaps.
    if (status === AudioPlayerStatus.Idle) {
      const queueDepth = Math.max(0, Number(session.botAudioStream?.queuedPackets || 0));
      if (queueDepth >= minQueueDepth) {
        const resource = createAudioResource(session.botAudioStream.readable, {
          inputType: StreamType.Opus
        });
        session.audioPlayer.play(resource);
        session.connection.subscribe(session.audioPlayer);
        // Discord.js createAudioResource attaches once("readable") to set
        // resource.started, and play() attaches once("readable") for the
        // Buffering→Playing transition. Because we pre-buffered Opus packets
        // before creating the resource, the initial "readable" event was
        // emitted and missed. Re-emit synchronously so both listeners fire
        // and the player transitions to Playing immediately.
        if (queueDepth > 0 && !session.botAudioStream.readable.destroyed) {
          session.botAudioStream.readable.emit("readable");
        }
      }
    }
  }
  return true;
}

export function transcriptSourceFromEventType(eventType) {
  const normalized = String(eventType || "").trim();
  if (!normalized) return "unknown";
  if (normalized === "conversation.item.input_audio_transcription.completed") return "input";
  if (normalized === "user_transcript") return "input";
  if (normalized === "agent_response") return "output";
  if (normalized === "agent_response_correction") return "output";
  if (normalized.includes("input_audio_transcription")) return "input";
  if (normalized.includes("output_audio_transcription")) return "output";
  if (normalized.includes("server_content_text")) return "output";
  if (normalized.includes("response.text")) return "output";
  if (normalized.includes("output_text")) return "output";
  if (/audio_transcript/i.test(normalized)) return "output";
  if (/transcript/i.test(normalized)) return "unknown";
  return "unknown";
}

export function isFinalRealtimeTranscriptEventType(eventType, source = null) {
  const normalized = String(eventType || "")
    .trim()
    .toLowerCase();
  const normalizedSource = String(source || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return normalizedSource !== "output";
  }

  if (normalized.includes("delta") || normalized.includes("partial")) return false;
  if (normalized === "server_content_text") return false;

  if (normalized.includes("input_audio_transcription")) {
    return normalized.includes("completed") || normalized === "input_audio_transcription";
  }

  if (normalized.includes("output_audio_transcription")) {
    return (
      normalized.includes("done") ||
      normalized.includes("completed") ||
      normalized === "output_audio_transcription"
    );
  }

  if (normalized.includes("output_audio_transcript")) {
    return normalized.includes("done") || normalized.includes("completed");
  }

  if (normalized.includes("response.output_text")) {
    return normalized.endsWith(".done") || normalized.includes("completed");
  }

  if (normalized.includes("response.text")) {
    return normalized.includes("done") || normalized.includes("completed");
  }

  if (/audio_transcript/u.test(normalized)) {
    return !normalized.includes("delta");
  }

  if (/transcript/u.test(normalized)) {
    return !normalized.includes("delta");
  }

  return true;
}

export function extractSoundboardDirective(rawText) {
  const parsed = parseSoundboardDirectiveSequence(rawText);
  const refs = Array.isArray(parsed?.references) ? parsed.references : [];
  const text = String(rawText || "");
  if (!text || !refs.length) {
    return {
      text: parsed?.text || "",
      reference: null
    };
  }

  return {
    text: parsed.text || "",
    reference: refs[refs.length - 1] || null
  };
}

export function parseSoundboardDirectiveSequence(rawText) {
  const text = String(rawText || "");
  if (!text) {
    return {
      text: "",
      references: [],
      sequence: []
    };
  }

  const sequence = [];
  const references = [];
  let cursor = 0;

  SOUNDBOARD_DIRECTIVE_RE.lastIndex = 0;
  let match = null;
  while ((match = SOUNDBOARD_DIRECTIVE_RE.exec(text))) {
    const fullMatch = String(match?.[0] || "");
    if (!fullMatch) continue;
    const start = Number(match.index || 0);
    const end = start + fullMatch.length;
    if (start > cursor) {
      sequence.push({
        type: "speech",
        text: text.slice(cursor, start)
      });
    }
    const reference = String(match?.[1] || "")
      .trim()
      .slice(0, MAX_SOUNDBOARD_DIRECTIVE_REF_LEN);
    if (reference) {
      references.push(reference);
      sequence.push({
        type: "soundboard",
        reference
      });
    }
    cursor = end;
  }
  SOUNDBOARD_DIRECTIVE_RE.lastIndex = 0;

  if (cursor < text.length) {
    sequence.push({
      type: "speech",
      text: text.slice(cursor)
    });
  }

  const withoutDirective = text
    .replace(SOUNDBOARD_DIRECTIVE_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  SOUNDBOARD_DIRECTIVE_RE.lastIndex = 0;

  return {
    text: withoutDirective,
    references,
    sequence
  };
}

export function shortError(text) {
  return String(text || "unknown error")
    .replace(/\s+/g, " ")
    .slice(0, 220);
}

export function resolveVoiceProvider(settings) {
  return normalizeVoiceProvider(settings?.voice?.voiceProvider, "openai");
}

export function resolveBrainProvider(settings) {
  const voiceProvider = resolveVoiceProvider(settings);
  return normalizeBrainProvider(settings?.voice?.brainProvider, voiceProvider, "openai");
}

export function resolveTranscriberProvider(settings) {
  return normalizeTranscriberProvider(settings?.voice?.transcriberProvider, "openai");
}

export function resolveVoiceRuntimeMode(settings) {
  if (settings?.voice?.mode) {
    return normalizeVoiceRuntimeMode(settings.voice.mode);
  }
  const voiceProvider = resolveVoiceProvider(settings);
  const modeMap = {
    openai: "openai_realtime",
    xai: "voice_agent",
    gemini: "gemini_realtime",
    elevenlabs: "elevenlabs_realtime"
  };
  return (modeMap[voiceProvider] || "openai_realtime") as VoiceRuntimeMode;
}

export function resolveRealtimeProvider(mode) {
  const normalized = String(mode || "")
    .trim()
    .toLowerCase();
  if (normalized === "voice_agent") return "xai";
  if (normalized === "openai_realtime") return "openai";
  if (normalized === "gemini_realtime") return "gemini";
  if (normalized === "elevenlabs_realtime") return "elevenlabs";
  return null;
}

export function isRealtimeMode(mode) {
  return Boolean(resolveRealtimeProvider(mode));
}

export function getRealtimeRuntimeLabel(mode) {
  const provider = resolveRealtimeProvider(mode);
  if (provider === "xai") return "xai";
  if (provider === "openai") return "openai_realtime";
  if (provider === "gemini") return "gemini_realtime";
  if (provider === "elevenlabs") return "elevenlabs_realtime";
  return "realtime";
}

export function parsePreferredSoundboardReferences(values) {
  const source = Array.isArray(values) ? values : [];
  const parsed = source
    .map((value) => parseSoundboardReference(value))
    .filter(Boolean)
    .map((entry) => ({
      ...entry,
      name: null,
      origin: "preferred"
    }));
  return dedupeSoundboardCandidates(parsed).slice(0, SOUNDBOARD_MAX_CANDIDATES);
}

export function dedupeSoundboardCandidates(candidates) {
  const source = Array.isArray(candidates) ? candidates : [];
  const seen = new Set();
  const out = [];

  for (const entry of source) {
    if (!entry || typeof entry !== "object") continue;
    const reference = String(entry.reference || "").trim();
    if (!reference) continue;
    const key = reference.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...entry,
      reference
    });
  }

  return out;
}

export function formatSoundboardCandidateLine(entry) {
  const reference = String(entry?.reference || "").trim();
  const name = String(entry?.name || "").trim();
  if (!reference) return "";
  return name ? `- ${reference} | ${name}` : `- ${reference}`;
}

function normalizeSoundboardReferenceToken(value) {
  return String(value || "")
    .trim()
    .replace(/^[`"'([{<]+/, "")
    .replace(/[`"')\]}>.,!?;:]+$/, "")
    .toLowerCase();
}

export function matchSoundboardReference(options, requestedRef) {
  const token = normalizeSoundboardReferenceToken(requestedRef);
  if (!token) return null;
  return options.find((entry) => String(entry.reference || "").toLowerCase() === token) || null;
}

export function findMentionedSoundboardReference(options, text) {
  const raw = String(text || "").toLowerCase();
  if (!raw) return null;
  return options.find((entry) => raw.includes(String(entry.reference || "").toLowerCase())) || null;
}

export function isBotNameAddressed({
  transcript,
  botName = ""
}) {
  const transcriptTokens = tokenizeWakeTokens(transcript);
  if (!transcriptTokens.length) return false;

  const botTokens = tokenizeWakeTokens(botName);
  if (!botTokens.length) return false;
  if (containsTokenSequence(transcriptTokens, botTokens)) return true;
  const mergedWakeToken = resolveMergedWakeToken(botTokens);
  if (mergedWakeToken && transcriptTokens.some((token) => token === mergedWakeToken)) return true;

  const primaryWakeToken = resolvePrimaryWakeToken(botTokens);
  return primaryWakeToken ? transcriptTokens.some((token) => token === primaryWakeToken) : false;
}

export function isVoiceTurnAddressedToBot(transcript, settings) {
  return isBotNameAddressed({
    transcript,
    botName: settings?.botName || ""
  });
}

export function isLikelyVocativeAddressToOtherParticipant({
  transcript = "",
  participantDisplayNames = [],
  botName = "",
  speakerName = ""
} = {}) {
  const tokens = tokenizeWakeTokens(transcript);
  if (tokens.length < 2) return false;

  const botTokens = new Set(tokenizeWakeTokens(botName));
  const speakerTokens = new Set(tokenizeWakeTokens(speakerName));
  const participantTokens = new Set();
  const names = Array.isArray(participantDisplayNames) ? participantDisplayNames : [];

  for (const displayName of names) {
    const nameTokens = tokenizeWakeTokens(displayName);
    for (const token of nameTokens) {
      if (token.length < 3) continue;
      if (EN_VOCATIVE_IGNORE_TOKENS.has(token)) continue;
      if (botTokens.has(token)) continue;
      if (speakerTokens.has(token)) continue;
      participantTokens.add(token);
    }
  }
  if (!participantTokens.size) return false;

  const firstToken = tokens[0];
  const secondToken = tokens[1];
  if (EN_VOCATIVE_GREETING_TOKENS.has(firstToken) && participantTokens.has(secondToken)) {
    return true;
  }

  const rawTranscript = String(transcript || "").trim();
  const leadingVocativeMatch = rawTranscript.match(/^([\p{L}\p{N}]{2,})[,:]/u);
  if (!leadingVocativeMatch) return false;
  const leadingToken = normalizeWakeText(String(leadingVocativeMatch[1] || ""));
  if (!leadingToken) return false;
  if (botTokens.has(leadingToken)) return false;
  return participantTokens.has(leadingToken);
}

function tokenizeWakeTokens(value = "") {
  const normalized = normalizeWakeText(value);
  const matches = normalized.match(/[\p{L}\p{N}]+/gu);
  return Array.isArray(matches) ? matches : [];
}

function normalizeWakeText(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "");
}

function containsTokenSequence(tokens = [], sequence = []) {
  if (!Array.isArray(tokens) || !Array.isArray(sequence)) return false;
  if (!tokens.length || !sequence.length || sequence.length > tokens.length) return false;
  for (let start = 0; start <= tokens.length - sequence.length; start += 1) {
    let matched = true;
    for (let index = 0; index < sequence.length; index += 1) {
      if (tokens[start + index] !== sequence[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function resolvePrimaryWakeToken(botTokens = []) {
  const candidates = botTokens.filter((token) => token.length >= PRIMARY_WAKE_TOKEN_MIN_LEN);
  if (!candidates.length) return null;
  const preferred = candidates.find((token) => !EN_WAKE_PRIMARY_GENERIC_TOKENS.has(token));
  return preferred || candidates[0];
}

function resolveMergedWakeToken(botTokens = []) {
  if (!Array.isArray(botTokens) || botTokens.length < 2) return null;
  const merged = botTokens.join("");
  return merged.length >= PRIMARY_WAKE_TOKEN_MIN_LEN ? merged : null;
}

export function shouldAllowVoiceNsfwHumor(settings) {
  const voiceFlag = settings?.voice?.allowNsfwHumor;
  if (voiceFlag === true) return true;
  if (voiceFlag === false) return false;
  return false;
}

export function normalizeVoiceAsrLanguageMode(mode = "", fallback = "auto") {
  const normalizedMode = String(mode || fallback || "auto")
    .trim()
    .toLowerCase();
  return VOICE_ASR_LANGUAGE_MODES.has(normalizedMode) ? normalizedMode : "auto";
}

export function normalizeVoiceAsrLanguageHint(hint = "", fallback = "") {
  if (hint === undefined || hint === null) {
    return normalizeVoiceAsrLanguageHint(fallback, "");
  }
  const normalizedHint = String(hint || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (!normalizedHint) return "";
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/u.test(normalizedHint)) {
    return normalizeVoiceAsrLanguageHint(fallback, "");
  }
  return normalizedHint.slice(0, 24);
}

export function resolveVoiceAsrLanguageGuidance(settings = null) {
  const mode = normalizeVoiceAsrLanguageMode(settings?.voice?.asrLanguageMode, "auto");
  const hint = normalizeVoiceAsrLanguageHint(settings?.voice?.asrLanguageHint, "en");
  const fixedLanguage = mode === "fixed" ? hint : "";
  const promptHint = hint
    ? `Language hint: ${hint}. Prefer this language when uncertain, but transcribe the actual spoken language.`
    : "";
  const prompt = mode === "auto" ? promptHint.slice(0, ASR_LANGUAGE_BIAS_PROMPT_MAX_LEN) : "";
  return {
    mode,
    hint,
    language: fixedLanguage || "",
    prompt
  };
}

export function formatRealtimeMemoryFacts(facts, maxItems = REALTIME_MEMORY_FACT_LIMIT) {
  if (!Array.isArray(facts) || !facts.length) return "";
  return facts
    .slice(0, Math.max(1, Number(maxItems) || REALTIME_MEMORY_FACT_LIMIT))
    .map((row) => {
      const fact = normalizeVoiceText(row?.fact || "", 180);
      if (!fact) return "";
      const type = String(row?.fact_type || "")
        .trim()
        .toLowerCase();
      return type && type !== "other" ? `${type}: ${fact}` : fact;
    })
    .filter(Boolean)
    .join(" | ");
}

export function normalizeVoiceText(value, maxChars = 1200) {
  return normalizeWhitespaceText(value, {
    maxLen: maxChars,
    minLen: 40
  });
}

export function buildRealtimeTextUtterancePrompt(text, maxLineChars = 1200) {
  const line = normalizeVoiceText(text, maxLineChars);
  if (!line) return "";
  return `Speak this exact line verbatim and nothing else: ${line}`;
}

export function encodePcm16MonoAsWav(pcmBuffer, sampleRate = 24000) {
  const pcm = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || []);
  const normalizedRate = Math.max(8000, Math.min(48000, Number(sampleRate) || 24000));
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = normalizedRate * blockAlign;
  const dataSize = pcm.length;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(normalizedRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcm.copy(buffer, 44);

  return buffer;
}

function clampUsageTokenCount(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}
