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
const WAKE_SUFFIX_VARIANT_MIN_WAKE_LEN = 6;
const WAKE_SUFFIX_VARIANT_MAX_EXTRA_CHARS = 4;
const WAKE_FUZZY_MIN_LEN = 5;
const WAKE_TWO_EDIT_DISTANCE_MIN_LEN = 9;

export function defaultExitMessage(reason) {
  if (reason === "max_duration") return "time cap reached, dipping from vc.";
  if (reason === "inactivity_timeout") return "been quiet for a bit, leaving vc.";
  if (reason === "connection_lost" || reason === "bot_disconnected") return "lost the voice connection, i bounced.";
  if (reason === "realtime_runtime_error" || reason === "realtime_socket_closed") {
    return "voice runtime dropped, i'm out.";
  }
  if (reason === "response_stalled") return "voice output got stuck, so i bounced.";
  if (reason === "settings_disabled") return "voice mode was disabled, so i dipped.";
  if (reason === "settings_channel_blocked" || reason === "settings_channel_not_allowlisted") {
    return "voice settings changed, so i left this vc.";
  }
  if (reason === "switch_channel") return "moving channels.";
  return "leaving vc.";
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

export function formatNaturalList(values) {
  const items = (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (!items.length) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
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
  const normalized = String(transcript || "")
    .trim()
    .toLowerCase();
  if (!normalized) return false;

  const normalizedBotName = String(botName || "")
    .trim()
    .toLowerCase();
  if (normalizedBotName && normalized.includes(normalizedBotName)) return true;

  const transcriptTokens = tokenizeWakeTokens(normalized);
  const botWakeTokens = buildBotWakeTokens(normalizedBotName);
  if (transcriptTokens.length && botWakeTokens.length) {
    for (let tokenIndex = 0; tokenIndex < transcriptTokens.length; tokenIndex += 1) {
      const spokenToken = transcriptTokens[tokenIndex];
      const spokenCandidates = buildSpokenWakeTokenCandidates(spokenToken);
      const matchedWakeToken = botWakeTokens.find((wakeToken) =>
        spokenCandidates.some((candidate) => isLikelyWakeTokenVariant(candidate, wakeToken))
      );
      if (matchedWakeToken) {
        return true;
      }
    }
  }

  return false;
}

export function isVoiceTurnAddressedToBot(transcript, settings) {
  return isBotNameAddressed({
    transcript,
    botName: settings?.botName || ""
  });
}

function tokenizeWakeTokens(value = "") {
  return String(value || "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || [];
}

function buildBotWakeTokens(botName = "") {
  const baseTokens = tokenizeWakeTokens(botName).filter((token) => token.length >= 3);
  const expanded = new Set();
  for (const token of baseTokens) {
    expanded.add(token);
    if (token.endsWith("er") && token.length >= 6) {
      expanded.add(token.slice(0, -2));
    }
  }
  return [...expanded];
}

function buildSpokenWakeTokenCandidates(spokenToken = "") {
  const normalized = String(spokenToken || "").trim().toLowerCase();
  if (!normalized) return [];

  const candidates = new Set([normalized]);
  const withoutPossessive = normalized.replace(/[’']s$/u, "");
  if (withoutPossessive && withoutPossessive !== normalized) {
    candidates.add(withoutPossessive);
  }

  // ASR often pluralizes wake words ("clakers", "clankers") when speakers are clipped.
  for (const candidate of [...candidates]) {
    if (candidate.endsWith("ers") && candidate.length >= 6) {
      candidates.add(candidate.slice(0, -1));
      continue;
    }
    if (candidate.endsWith("s") && candidate.length >= 6 && !candidate.endsWith("ss")) {
      candidates.add(candidate.slice(0, -1));
    }
  }

  return [...candidates];
}

function isLikelyWakeTokenVariant(spokenToken = "", wakeToken = "") {
  const spoken = String(spokenToken || "").trim().toLowerCase();
  const wake = String(wakeToken || "").trim().toLowerCase();
  if (!spoken || !wake) return false;
  if (spoken === wake) return true;
  if (spoken.length < 3 || wake.length < 3) return false;
  if (spoken[0] !== wake[0]) return false;
  if (wake.length < WAKE_FUZZY_MIN_LEN) return false;

  // Support common nickname contraction like "clanker" -> "clanky".
  if (wake.endsWith("er") && wake.length >= 6 && spoken.endsWith("y")) {
    const yVariant = `${wake.slice(0, -2)}y`;
    if (spoken === yVariant) return true;
  }

  if (Math.abs(spoken.length - wake.length) <= 1 && spoken.at(-1) !== wake.at(-1)) return false;

  const maxLen = Math.max(spoken.length, wake.length);
  const maxDistance = maxLen >= WAKE_TWO_EDIT_DISTANCE_MIN_LEN ? 2 : 1;
  if (Math.abs(spoken.length - wake.length) <= maxDistance) {
    const distance = boundedLevenshteinDistance(spoken, wake, maxDistance);
    if (distance <= maxDistance) {
      const similarity = 1 - distance / maxLen;
      const minSimilarity = maxLen >= WAKE_TWO_EDIT_DISTANCE_MIN_LEN ? 0.74 : 0.82;
      if (similarity >= minSimilarity) {
        return true;
      }
    }
  }

  // Allow nickname-style suffix variants on longer wake tokens.
  if (
    wake.length >= WAKE_SUFFIX_VARIANT_MIN_WAKE_LEN &&
    spoken.length > wake.length
  ) {
    const extraChars = spoken.length - wake.length;
    if (extraChars <= WAKE_SUFFIX_VARIANT_MAX_EXTRA_CHARS) {
      const spokenPrefix = spoken.slice(0, wake.length);
      const prefixDistance = boundedLevenshteinDistance(spokenPrefix, wake, 1);
      if (prefixDistance <= 1) {
        const prefixSimilarity = 1 - prefixDistance / wake.length;
        if (prefixSimilarity >= 0.84) {
          return true;
        }
      }
    }
  }

  return false;
}

function boundedLevenshteinDistance(left = "", right = "", maxDistance = 2) {
  const leftWord = String(left || "");
  const rightWord = String(right || "");
  if (leftWord === rightWord) return 0;
  if (!leftWord.length) return rightWord.length;
  if (!rightWord.length) return leftWord.length;
  if (Math.abs(leftWord.length - rightWord.length) > maxDistance) return maxDistance + 1;

  let previous = Array.from({ length: rightWord.length + 1 }, (_, index) => index);
  for (let row = 1; row <= leftWord.length; row += 1) {
    const current = [row];
    let rowMin = current[0];
    for (let column = 1; column <= rightWord.length; column += 1) {
      const substitutionCost = leftWord[row - 1] === rightWord[column - 1] ? 0 : 1;
      const insertion = current[column - 1] + 1;
      const deletion = previous[column] + 1;
      const substitution = previous[column - 1] + substitutionCost;
      const value = Math.min(insertion, deletion, substitution);
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[rightWord.length];
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
