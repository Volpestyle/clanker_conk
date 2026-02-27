const VOICE_LOW_SIGNAL_MIN_ALNUM_CHARS = 10;
const VOICE_LOW_SIGNAL_MIN_WORDS = 2;
const OPENAI_REALTIME_SHORT_CLIP_ASR_MS = 1200;
const PCM16_MONO_BYTES_PER_SAMPLE = 2;

export function isLowSignalVoiceFragment(transcript = "") {
  const normalized = String(transcript || "").trim();
  if (!normalized) return true;
  if (/[?¿؟？]/u.test(normalized)) return false;
  if (/^(who|what|when|where|why|how|can|could|would|should|do|does|did|is|are|am|will|won'?t)\b/i.test(normalized)) {
    return false;
  }

  const alnumChars = (normalized.match(/[\p{L}\p{N}]/gu) || []).length;
  const wordCount = normalized.split(/\s+/u).filter(Boolean).length;
  if (wordCount >= 3 && alnumChars >= 6) {
    return false;
  }
  if (alnumChars >= VOICE_LOW_SIGNAL_MIN_ALNUM_CHARS && wordCount >= VOICE_LOW_SIGNAL_MIN_WORDS) {
    return false;
  }

  return true;
}

export function isLikelyWakeWordPing(transcript = "") {
  const normalized = String(transcript || "")
    .toLowerCase()
    .trim();
  if (!normalized) return false;

  const tokenCount = normalized
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/u)
    .filter(Boolean).length;
  return tokenCount > 0 && tokenCount <= 3;
}

export function normalizeVoiceReplyDecisionProvider(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "anthropic") return "anthropic";
  if (normalized === "xai") return "xai";
  if (normalized === "claude-code") return "claude-code";
  return "openai";
}

export function defaultVoiceReplyDecisionModel(provider) {
  if (provider === "anthropic") return "claude-haiku-4-5";
  if (provider === "xai") return "grok-3-mini-latest";
  if (provider === "claude-code") return "sonnet";
  return "gpt-4.1-mini";
}

export function resolveRealtimeTurnTranscriptionPlan({
  mode,
  configuredModel = "gpt-4o-mini-transcribe",
  pcmByteLength = 0,
  sampleRateHz = 24000
}) {
  const normalizedModel = String(configuredModel || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
  if (String(mode || "") !== "openai_realtime") {
    return {
      primaryModel: normalizedModel,
      fallbackModel: null,
      reason: "configured_model"
    };
  }

  if (normalizedModel !== "gpt-4o-mini-transcribe") {
    return {
      primaryModel: normalizedModel,
      fallbackModel: null,
      reason: "configured_non_mini_model"
    };
  }

  const clipDurationMs = estimatePcm16MonoDurationMs(pcmByteLength, sampleRateHz);
  if (clipDurationMs > 0 && clipDurationMs <= OPENAI_REALTIME_SHORT_CLIP_ASR_MS) {
    return {
      primaryModel: "gpt-4o-transcribe",
      fallbackModel: null,
      reason: "short_clip_prefers_full_model"
    };
  }

  return {
    primaryModel: normalizedModel,
    fallbackModel: "gpt-4o-transcribe",
    reason: "mini_with_full_fallback"
  };
}

export function parseVoiceDecisionContract(rawText) {
  const normalized = String(rawText || "").trim();
  if (!normalized) {
    return {
      allow: false,
      confident: false
    };
  }

  const unwrapped = normalized.replace(/^```(?:[a-z]+)?\s*/i, "").replace(/```$/i, "").trim();
  try {
    const parsedJson = JSON.parse(unwrapped);
    const jsonDecisionValue =
      typeof parsedJson === "string"
        ? parsedJson
        : parsedJson && typeof parsedJson === "object"
          ? parsedJson.decision || parsedJson.answer || parsedJson.value || ""
          : "";
    const jsonDecision = String(jsonDecisionValue || "").trim().toUpperCase();
    if (jsonDecision === "YES") {
      return {
        allow: true,
        confident: true
      };
    }
    if (jsonDecision === "NO") {
      return {
        allow: false,
        confident: true
      };
    }
  } catch {
    // ignore invalid JSON and continue with token parsing fallback
  }

  const quoted = unwrapped
    .replace(/^["'`]\s*/g, "")
    .replace(/\s*["'`]$/g, "")
    .trim()
    .toUpperCase();
  if (quoted === "YES") {
    return {
      allow: true,
      confident: true
    };
  }
  if (quoted === "NO") {
    return {
      allow: false,
      confident: true
    };
  }

  return {
    allow: false,
    confident: false
  };
}

function estimatePcm16MonoDurationMs(pcmByteLength, sampleRateHz = 24000) {
  const normalizedBytes = Math.max(0, Number(pcmByteLength) || 0);
  const normalizedRate = Math.max(1, Number(sampleRateHz) || 24000);
  return Math.round((normalizedBytes / (PCM16_MONO_BYTES_PER_SAMPLE * normalizedRate)) * 1000);
}
