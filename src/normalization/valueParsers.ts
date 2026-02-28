const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

type JsonParseOptions = {
  coerceToString?: boolean;
};

export function parseBooleanFlag(value: unknown, fallback = false) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return Boolean(fallback);
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return Boolean(fallback);
}

export function parseNumberOrFallback(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function safeJsonParseFromString(value: unknown, fallback: unknown) {
  return safeJsonParse(value, fallback, { coerceToString: true });
}

export function safeJsonParse(value: unknown, fallback: unknown, { coerceToString = false }: JsonParseOptions = {}) {
  if (coerceToString) {
    try {
      return JSON.parse(String(value || ""));
    } catch {
      return fallback;
    }
  }

  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
