export function nowIso() {
  return new Date().toISOString();
}

const BOT_KEYWORD_SUFFIX_PATTERN = "(?:a|er|s|or|ey|ie|r|y)?";
const BOT_KEYWORD_PATTERN = `\\b(?:clank${BOT_KEYWORD_SUFFIX_PATTERN}|clunk${BOT_KEYWORD_SUFFIX_PATTERN})\\b`;
const BOT_KEYWORD_RE = new RegExp(BOT_KEYWORD_PATTERN, "i");
const BOT_KEYWORD_GLOBAL_RE = new RegExp(BOT_KEYWORD_PATTERN, "gi");

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function chance(probability) {
  return Math.random() < probability;
}

export function pickRandom(values) {
  if (!values.length) return null;
  return values[Math.floor(Math.random() * values.length)] ?? null;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function deepMerge(base, patch) {
  if (!isObject(base) || !isObject(patch)) {
    return patch;
  }

  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (Array.isArray(value)) {
      out[key] = value.slice();
      continue;
    }

    if (isObject(value)) {
      out[key] = deepMerge(isObject(base[key]) ? base[key] : {}, value);
      continue;
    }

    out[key] = value;
  }
  return out;
}

export function uniqueIdList(input) {
  if (Array.isArray(input)) {
    return [...new Set(input.map((x) => String(x).trim()).filter(Boolean))];
  }

  if (typeof input !== "string") return [];

  const split = input
    .split(/[\n,]/g)
    .map((x) => x.trim())
    .filter(Boolean);

  return [...new Set(split)];
}

const DISCORD_MESSAGE_SAFE_LIMIT = 1900;

export function sanitizeBotText(text, maxLen = DISCORD_MESSAGE_SAFE_LIMIT) {
  if (!text) return "";

  let clean = String(text).trim();
  clean = clean.replace(/^"|"$/g, "");
  clean = clean.replace(/\n{3,}/g, "\n\n");
  clean = clean.replace(/@everyone|@here/g, "");

  const limit = Number(maxLen);
  if (Number.isFinite(limit) && limit > 0 && clean.length > limit) {
    const sliceLen = Math.max(1, Math.floor(limit) - 1);
    clean = clean.slice(0, sliceLen).trimEnd() + "…";
  }

  return clean;
}

export function hasBotKeyword(text) {
  return BOT_KEYWORD_RE.test(String(text || ""));
}

export function stripBotKeywords(text) {
  return String(text || "").replace(BOT_KEYWORD_GLOBAL_RE, " ");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
