const DEFAULT_BOT_NAME = "clanker conk";
const DEFAULT_STYLE = "playful slang";

export const PROMPT_CAPABILITY_HONESTY_LINE = "Never claim capabilities you do not have.";

export function getPromptBotName(settings, fallback = DEFAULT_BOT_NAME) {
  const configured = String(settings?.botName || "").trim();
  return configured || String(fallback || DEFAULT_BOT_NAME);
}

export function getPromptStyle(settings, fallback = DEFAULT_STYLE) {
  const configured = String(settings?.persona?.flavor || "").trim();
  return configured || String(fallback || DEFAULT_STYLE);
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
