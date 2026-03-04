export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
export const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";

export const OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
export const OPENAI_REALTIME_SUPPORTED_TRANSCRIPTION_MODELS = new Set([
  "whisper-1",
  "gpt-4o-transcribe-latest",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe-2025-12-15",
  "gpt-4o-mini-transcribe"
]);

export function normalizeOpenAiBaseUrl(value: unknown) {
  const raw = String(value || DEFAULT_OPENAI_BASE_URL).trim();
  const normalized = raw || DEFAULT_OPENAI_BASE_URL;
  return normalized.replace(/\/+$/, "");
}

export function normalizeOpenAiRealtimeTranscriptionModel(
  value: unknown,
  fallback = OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL
) {
  const normalized =
    String(value || "").trim() || String(fallback || "").trim() || OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL;
  return OPENAI_REALTIME_SUPPORTED_TRANSCRIPTION_MODELS.has(normalized)
    ? normalized
    : OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL;
}

export function normalizeGeminiBaseUrl(value: unknown) {
  const raw = String(value || DEFAULT_GEMINI_BASE_URL).trim();
  if (!raw) return DEFAULT_GEMINI_BASE_URL;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return DEFAULT_GEMINI_BASE_URL;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return DEFAULT_GEMINI_BASE_URL;
  }
}

export function normalizeElevenLabsBaseUrl(value: unknown) {
  const target = String(value || DEFAULT_ELEVENLABS_BASE_URL).trim() || DEFAULT_ELEVENLABS_BASE_URL;
  try {
    const parsed = new URL(target);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return DEFAULT_ELEVENLABS_BASE_URL;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return DEFAULT_ELEVENLABS_BASE_URL;
  }
}
