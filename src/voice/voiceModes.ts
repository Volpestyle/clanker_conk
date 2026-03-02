export const VOICE_PROVIDERS = ["openai", "xai", "gemini", "elevenlabs"] as const;
export const BRAIN_PROVIDERS = ["native", "openai", "anthropic", "xai", "gemini"] as const;
export const TRANSCRIBER_PROVIDERS = ["openai"] as const;

export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];
export type BrainProvider = (typeof BRAIN_PROVIDERS)[number];
export type TranscriberProvider = (typeof TRANSCRIBER_PROVIDERS)[number];

export function normalizeVoiceProvider(value: unknown, fallback: VoiceProvider = "openai"): VoiceProvider {
  const normalized = String(value || fallback || "")
    .trim()
    .toLowerCase();
  if (VOICE_PROVIDERS.includes(normalized as VoiceProvider)) {
    return normalized as VoiceProvider;
  }
  return fallback;
}

export function normalizeBrainProvider(
  value: unknown,
  voiceProvider: unknown,
  fallback: BrainProvider = "native"
): BrainProvider {
  const normalized = String(value || fallback || "")
    .trim()
    .toLowerCase();
  if (BRAIN_PROVIDERS.includes(normalized as BrainProvider)) {
    return normalized as BrainProvider;
  }
  return fallback;
}

export function normalizeTranscriberProvider(
  value: unknown,
  fallback: TranscriberProvider = "openai"
): TranscriberProvider {
  const normalized = String(value || fallback || "")
    .trim()
    .toLowerCase();
  if (TRANSCRIBER_PROVIDERS.includes(normalized as TranscriberProvider)) {
    return normalized as TranscriberProvider;
  }
  return fallback;
}

export const VOICE_RUNTIME_MODES = [
  "voice_agent",
  "openai_realtime",
  "gemini_realtime",
  "elevenlabs_realtime",
  "stt_pipeline"
] as const;

type VoiceRuntimeMode = (typeof VOICE_RUNTIME_MODES)[number];

export function normalizeVoiceRuntimeMode(value: unknown, fallback: VoiceRuntimeMode = "voice_agent"): VoiceRuntimeMode {
  const normalized = String(value || fallback || "")
    .trim()
    .toLowerCase();
  if (normalized === "openai_realtime") return "openai_realtime";
  if (normalized === "gemini_realtime") return "gemini_realtime";
  if (normalized === "elevenlabs_realtime") return "elevenlabs_realtime";
  if (normalized === "stt_pipeline") return "stt_pipeline";
  return "voice_agent";
}

export function parseVoiceRuntimeMode(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "voice_agent") return "voice_agent";
  if (normalized === "openai_realtime") return "openai_realtime";
  if (normalized === "gemini_realtime") return "gemini_realtime";
  if (normalized === "elevenlabs_realtime") return "elevenlabs_realtime";
  if (normalized === "stt_pipeline") return "stt_pipeline";
  return null;
}
