import { PassThrough } from "node:stream";
import {
  AudioPlayerStatus,
  createAudioResource,
  StreamType
} from "@discordjs/voice";
import { parseSoundboardReference } from "./soundboardDirector.ts";

export const REALTIME_MEMORY_FACT_LIMIT = 8;
export const SOUNDBOARD_MAX_CANDIDATES = 40;
const OPENAI_REALTIME_MIN_COMMIT_AUDIO_MS = 100;
const SOUNDBOARD_DIRECTIVE_RE = /\[\[SOUNDBOARD:\s*([\s\S]*?)\s*\]\]/gi;
const MAX_SOUNDBOARD_DIRECTIVE_REF_LEN = 180;
const PRIMARY_WAKE_TOKEN_MIN_LEN = 4;
const PRIMARY_WAKE_GENERIC_TOKENS = new Set(["bot", "ai", "assistant"]);

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

  const normalizedMessage = String(message || "")
    .trim()
    .toLowerCase();
  if (!normalizedMessage) return false;
  if (normalizedMessage.includes("active response in progress")) return true;
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

export function ensureBotAudioPlaybackReady({ session, store, botUserId = null }) {
  if (!session || !session.audioPlayer || !session.connection) return false;

  const restartAudioPipeline = (reason) => {
    const now = Date.now();
    if (now - Number(session.lastAudioPipelineRepairAt || 0) < 600) {
      return true;
    }
    session.lastAudioPipelineRepairAt = now;

    try {
      if (!session.botAudioStream || session.botAudioStream.destroyed || session.botAudioStream.writableEnded) {
        session.botAudioStream = new PassThrough();
      }

      const resource = createAudioResource(session.botAudioStream, {
        inputType: StreamType.Raw
      });
      session.audioPlayer.play(resource);
      session.connection.subscribe(session.audioPlayer);
      store?.logAction?.({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: botUserId,
        content: "bot_audio_pipeline_restarted",
        metadata: {
          sessionId: session.id,
          reason
        }
      });
      return true;
    } catch (error) {
      store?.logAction?.({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: botUserId,
        content: `bot_audio_pipeline_restart_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          reason
        }
      });
      return false;
    }
  };

  if (!session.botAudioStream || session.botAudioStream.destroyed || session.botAudioStream.writableEnded) {
    return restartAudioPipeline("stream_unavailable");
  }

  const status = session.audioPlayer.state?.status || null;
  if (status === AudioPlayerStatus.Idle || status === AudioPlayerStatus.AutoPaused) {
    return restartAudioPipeline(`player_${String(status).toLowerCase()}`);
  }

  return true;
}

export function transcriptSourceFromEventType(eventType) {
  const normalized = String(eventType || "").trim();
  if (!normalized) return "unknown";
  if (normalized === "conversation.item.input_audio_transcription.completed") return "input";
  if (normalized.includes("input_audio_transcription")) return "input";
  if (normalized.includes("output_audio_transcription")) return "output";
  if (normalized.includes("server_content_text")) return "output";
  if (normalized.includes("response.text")) return "output";
  if (normalized.includes("output_text")) return "output";
  if (/audio_transcript/i.test(normalized)) return "output";
  if (/transcript/i.test(normalized)) return "unknown";
  return "unknown";
}

export function extractSoundboardDirective(rawText) {
  const text = String(rawText || "");
  if (!text) {
    return {
      text: "",
      reference: null
    };
  }

  let lastReference = "";
  SOUNDBOARD_DIRECTIVE_RE.lastIndex = 0;
  let match = null;
  while ((match = SOUNDBOARD_DIRECTIVE_RE.exec(text))) {
    lastReference = String(match?.[1] || "")
      .trim()
      .slice(0, MAX_SOUNDBOARD_DIRECTIVE_REF_LEN);
  }
  SOUNDBOARD_DIRECTIVE_RE.lastIndex = 0;

  const withoutDirective = text
    .replace(SOUNDBOARD_DIRECTIVE_RE, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    text: withoutDirective,
    reference: lastReference || null
  };
}

export function shortError(text) {
  return String(text || "unknown error")
    .replace(/\s+/g, " ")
    .slice(0, 220);
}

export function resolveVoiceRuntimeMode(settings) {
  const normalized = String(settings?.voice?.mode || "")
    .trim()
    .toLowerCase();
  if (normalized === "gemini_realtime") return "gemini_realtime";
  if (normalized === "openai_realtime") return "openai_realtime";
  if (normalized === "stt_pipeline") return "stt_pipeline";
  return "voice_agent";
}

export function resolveRealtimeProvider(mode) {
  const normalized = String(mode || "")
    .trim()
    .toLowerCase();
  if (normalized === "voice_agent") return "xai";
  if (normalized === "openai_realtime") return "openai";
  if (normalized === "gemini_realtime") return "gemini";
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
  const preferred = candidates.find((token) => !PRIMARY_WAKE_GENERIC_TOKENS.has(token));
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

export function normalizeVoiceText(value, maxChars = 520) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(40, Number(maxChars) || 520));
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
