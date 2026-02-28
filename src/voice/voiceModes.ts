export const VOICE_RUNTIME_MODES = [
  "voice_agent",
  "openai_realtime",
  "gemini_realtime",
  "stt_pipeline"
] as const;

type VoiceRuntimeMode = (typeof VOICE_RUNTIME_MODES)[number];

export function normalizeVoiceRuntimeMode(value: unknown, fallback: VoiceRuntimeMode = "voice_agent"): VoiceRuntimeMode {
  const normalized = String(value || fallback || "")
    .trim()
    .toLowerCase();
  if (normalized === "openai_realtime") return "openai_realtime";
  if (normalized === "gemini_realtime") return "gemini_realtime";
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
  if (normalized === "stt_pipeline") return "stt_pipeline";
  return null;
}
