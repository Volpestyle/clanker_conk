import type { MessageRow } from "./types.ts";

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function isoInWindow(value: string, start: string, end: string) {
  if (!value) return false;
  if (!start && !end) return false;
  if (start && value < start) return false;
  if (end && value > end) return false;
  return true;
}

export function parseJsonSafe(rawText: string) {
  try {
    return JSON.parse(rawText);
  } catch {
    return null;
  }
}

export function parseJsonObjectFromText(rawText: string) {
  const value = String(rawText || "").trim();
  if (!value) return null;
  const direct = parseJsonSafe(value);
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  const sliced = value.slice(firstBrace, lastBrace + 1);
  const parsed = parseJsonSafe(sliced);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  return null;
}

export function stableNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function toRecentMessagesDesc(history: MessageRow[], maxItems: number) {
  const bounded = Math.max(1, Math.floor(maxItems) || 1);
  return history.slice(-bounded).slice().reverse();
}

export function truncateText(value: string, maxChars: number) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 3))}...`;
}

export function formatPct(numerator: number, denominator: number) {
  if (denominator <= 0) return 0;
  return (100 * numerator) / denominator;
}

export function computeContextSince(since: string, historyLookbackHours: number) {
  const sinceMs = Date.parse(since);
  const lookbackMs = Math.max(0, Math.floor(Number(historyLookbackHours) || 0)) * 60 * 60 * 1000;
  if (!Number.isFinite(sinceMs) || sinceMs <= 0) return since;
  return new Date(Math.max(0, sinceMs - lookbackMs)).toISOString();
}
