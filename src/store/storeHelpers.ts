import { nowIso } from "../utils.ts";
import { safeJsonParse } from "../normalization/valueParsers.ts";

export function normalizeEmbeddingVector(rawEmbedding) {
  if (!Array.isArray(rawEmbedding) || !rawEmbedding.length) return [];
  const normalized = [];
  for (const value of rawEmbedding) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) continue;
    normalized.push(numeric);
  }
  return normalized;
}

export function vectorToBlob(embedding) {
  return Buffer.from(new Float32Array(embedding).buffer);
}

export function parseEmbeddingBlob(rawBlob) {
  if (!rawBlob) return [];
  let buffer = rawBlob;
  if (!Buffer.isBuffer(buffer)) {
    try {
      buffer = Buffer.from(buffer);
    } catch {
      return [];
    }
  }
  if (!buffer.length || buffer.length % 4 !== 0) return [];
  const values = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
  const out = [];
  for (const value of values) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return [];
    out.push(numeric);
  }
  return out;
}

export function normalizeAutomationStatus(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "active") return "active";
  if (normalized === "paused") return "paused";
  if (normalized === "deleted") return "deleted";
  return "";
}

export function normalizeAutomationRunStatus(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "ok") return "ok";
  if (normalized === "error") return "error";
  if (normalized === "skipped") return "skipped";
  return "ok";
}

export function normalizeAutomationStatusFilter(statuses) {
  const list = Array.isArray(statuses) ? statuses : [statuses];
  const raw = list
    .map((status) => String(status || "").trim().toLowerCase())
    .filter(Boolean);
  if (raw.includes("all")) {
    return ["active", "paused", "deleted"];
  }
  return [
    ...new Set(
      raw
        .map((status) => normalizeAutomationStatus(status))
        .filter(Boolean)
    )
  ];
}

export function mapAutomationRow(row) {
  if (!row) return null;
  const schedule = safeJsonParse(row.schedule_json, null);
  if (!schedule || typeof schedule !== "object") return null;

  return {
    id: Number(row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
    guild_id: row.guild_id,
    channel_id: row.channel_id,
    created_by_user_id: row.created_by_user_id,
    created_by_name: row.created_by_name || null,
    title: row.title,
    instruction: row.instruction,
    schedule,
    next_run_at: row.next_run_at || null,
    status: row.status,
    is_running: Number(row.is_running || 0) === 1,
    running_started_at: row.running_started_at || null,
    last_run_at: row.last_run_at || null,
    last_error: row.last_error || null,
    last_result: row.last_result || null,
    match_text: row.match_text || ""
  };
}

export function normalizeMessageCreatedAt(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : nowIso();
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric).toISOString();
  }

  const text = String(value || "").trim();
  if (text) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  return nowIso();
}
