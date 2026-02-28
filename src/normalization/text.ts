export type TextReplacement = {
  pattern: RegExp;
  replacement: string;
};

export type NormalizeTextOptions = {
  maxLen?: number;
  minLen?: number;
  ellipsis?: boolean;
  replacements?: TextReplacement[];
  trim?: boolean;
};

export function normalizeWhitespaceText(value: unknown, options: NormalizeTextOptions = {}): string {
  const shouldTrim = options.trim !== false;
  let normalized = String(value || "");

  const replacements = Array.isArray(options.replacements) ? options.replacements : [];
  for (const entry of replacements) {
    normalized = normalized.replace(entry.pattern, entry.replacement);
  }

  normalized = normalized.replace(/\s+/g, " ");
  if (shouldTrim) normalized = normalized.trim();

  const maxCandidate = Number(options.maxLen);
  if (!Number.isFinite(maxCandidate)) return normalized;

  const maxLen = Math.max(0, Math.floor(maxCandidate));
  const minLen = Math.max(0, Math.floor(Number(options.minLen) || 0));
  const boundedMax = Math.max(minLen, maxLen);

  if (normalized.length <= boundedMax) return normalized;

  if (options.ellipsis) {
    return `${normalized.slice(0, Math.max(0, boundedMax - 1)).trimEnd()}…`;
  }

  return normalized.slice(0, boundedMax);
}
