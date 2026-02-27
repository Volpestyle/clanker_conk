const DEFAULT_BOT_NAME = "clanker conk";
const DEFAULT_STYLE = "playful slang";

export const PROMPT_CAPABILITY_HONESTY_LINE = "Never claim capabilities you do not have.";
const DEFAULT_IMPOSSIBLE_ACTION_LINE = "If asked to do something impossible, say it casually and suggest a text-only alternative.";
const DEFAULT_MEMORY_ENABLED_LINE =
  "You have persistent memory across conversations via saved durable facts and logs. Do not claim each conversation starts from zero.";
const DEFAULT_MEMORY_DISABLED_LINE =
  "Persistent memory is disabled right now. Do not claim long-term memory across separate conversations.";
const DEFAULT_SKIP_LINE = "If you should not send a message, output exactly [SKIP].";
const DEFAULT_MEDIA_PROMPT_CRAFT_GUIDANCE = [
  "Write media prompts as vivid scene descriptions, not abstract concepts.",
  "Include: subject/action, visual style or medium (photo, illustration, 3D render, pixel art, etc.), lighting/mood, camera angle or framing, and color palette when relevant.",
  "Be specific: 'a golden retriever leaping through autumn leaves, warm backlit sunset, low angle, film grain' beats 'a dog outside'.",
  "For video prompts, describe the motion arc: what starts, what changes, and how it ends.",
  "Never put text, words, or UI elements in media prompts."
].join(" ");

export function getPromptBotName(settings, fallback = DEFAULT_BOT_NAME) {
  const configured = String(settings?.botName || "").trim();
  return configured || String(fallback || DEFAULT_BOT_NAME);
}

export function getPromptStyle(settings, fallback = DEFAULT_STYLE) {
  const configured = String(settings?.persona?.flavor || "").trim();
  return configured || String(fallback || DEFAULT_STYLE);
}

export function getPromptCapabilityHonestyLine(settings, fallback = PROMPT_CAPABILITY_HONESTY_LINE) {
  const configured = String(settings?.prompt?.capabilityHonestyLine || "").trim();
  return configured || String(fallback || PROMPT_CAPABILITY_HONESTY_LINE);
}

export function getPromptImpossibleActionLine(settings, fallback = DEFAULT_IMPOSSIBLE_ACTION_LINE) {
  const configured = String(settings?.prompt?.impossibleActionLine || "").trim();
  return configured || String(fallback || DEFAULT_IMPOSSIBLE_ACTION_LINE);
}

export function getPromptMemoryEnabledLine(settings, fallback = DEFAULT_MEMORY_ENABLED_LINE) {
  const configured = String(settings?.prompt?.memoryEnabledLine || "").trim();
  return configured || String(fallback || DEFAULT_MEMORY_ENABLED_LINE);
}

export function getPromptMemoryDisabledLine(settings, fallback = DEFAULT_MEMORY_DISABLED_LINE) {
  const configured = String(settings?.prompt?.memoryDisabledLine || "").trim();
  return configured || String(fallback || DEFAULT_MEMORY_DISABLED_LINE);
}

export function getPromptSkipLine(settings, fallback = DEFAULT_SKIP_LINE) {
  const configured = String(settings?.prompt?.skipLine || "").trim();
  return configured || String(fallback || DEFAULT_SKIP_LINE);
}

export function getPromptTextGuidance(settings, fallback = []) {
  return normalizePromptLineList(settings?.prompt?.textGuidance, fallback);
}

export function getPromptVoiceGuidance(settings, fallback = []) {
  return normalizePromptLineList(settings?.prompt?.voiceGuidance, fallback);
}

export function getPromptVoiceOperationalGuidance(settings, fallback = []) {
  return normalizePromptLineList(settings?.prompt?.voiceOperationalGuidance, fallback);
}

export function getMediaPromptCraftGuidance(settings, fallback = DEFAULT_MEDIA_PROMPT_CRAFT_GUIDANCE) {
  const configured = String(settings?.prompt?.mediaPromptCraftGuidance || "").trim();
  return configured || String(fallback || DEFAULT_MEDIA_PROMPT_CRAFT_GUIDANCE);
}

export function getPromptHardLimits(settings, { maxItems = null } = {}) {
  const source = Array.isArray(settings?.persona?.hardLimits) ? settings.persona.hardLimits : [];
  const limits = source
    .map((line) => String(line || "").trim())
    .filter(Boolean);
  if (!Number.isFinite(Number(maxItems))) return limits;
  const count = Math.max(0, Math.floor(Number(maxItems)));
  return limits.slice(0, count);
}

export function buildHardLimitsSection(settings, { maxItems = null } = {}) {
  return [
    "Hard limitations:",
    ...getPromptHardLimits(settings, { maxItems }).map((line) => `- ${line}`)
  ];
}

export function buildVoiceToneGuardrails() {
  return [
    "Match your normal text-chat persona in voice: same attitude, slang level, and casual cadence.",
    "Keep turns tight: one clear idea, usually one short sentence.",
    "Use a second short sentence only when needed for clarity or when asked for detail.",
    "Avoid assistant-like preambles, disclaimers, and over-explaining.",
    "Avoid bullet lists and rigid formatting unless someone explicitly asks for structured steps."
  ];
}

function normalizePromptLineList(source, fallback = []) {
  const list = Array.isArray(source) ? source : Array.isArray(fallback) ? fallback : [];
  return list
    .map((line) => String(line || "").trim())
    .filter(Boolean);
}
