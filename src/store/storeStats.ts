// Extracted Store Methods
import type { Database } from "bun:sqlite";

import { clamp } from "../utils.ts";
import { safeJsonParse } from "../normalization/valueParsers.ts";
import { pushPerformanceMetric, summarizeLatencyMetric } from "./storePerformance.ts";

type LatencyMetricSummary = ReturnType<typeof summarizeLatencyMetric>;

interface StatsStore {
  db: Database;
  getReplyPerformanceStats(args?: {
    windowHours?: number;
    maxSamples?: number;
    guildId?: string | null;
  }): {
    windowHours: number;
    sampleLimit: number;
    sampleCount: number;
    byKind: {
      sent_reply: number;
      sent_message: number;
      reply_skipped: number;
    };
    totalMs: LatencyMetricSummary;
    processingMs: LatencyMetricSummary;
    phases: {
      queueMs: LatencyMetricSummary;
      ingestMs: LatencyMetricSummary;
      memorySliceMs: LatencyMetricSummary;
      llm1Ms: LatencyMetricSummary;
      followupMs: LatencyMetricSummary;
      typingDelayMs: LatencyMetricSummary;
      sendMs: LatencyMetricSummary;
    };
  };
}

interface ActionMetadataRow {
  kind: string;
  metadata: string | null;
}

interface ActionKindCountRow {
  kind: string;
  count: number;
}

interface TotalCostRow {
  total: number;
}

interface DayCostRow {
  day: string;
  usd: number;
}

export function getReplyPerformanceStats(
  store: StatsStore,
  { windowHours = 24, maxSamples = 4000, guildId = null }: { windowHours?: number; maxSamples?: number; guildId?: string | null } = {}
) {
const boundedHours = clamp(Math.floor(Number(windowHours) || 24), 1, 168);
const boundedSamples = clamp(Math.floor(Number(maxSamples) || 4000), 100, 20000);
const sinceIso = new Date(Date.now() - boundedHours * 60 * 60 * 1000).toISOString();
const normalizedGuildId = String(guildId || "").trim();
const conditions = [
  "created_at >= ?",
  "kind IN ('sent_reply', 'sent_message', 'reply_skipped')"
];
const params: Array<string | number> = [sinceIso];
if (normalizedGuildId) {
  conditions.push("guild_id = ?");
  params.push(normalizedGuildId);
}
params.push(boundedSamples);

const rows = store.db
  .prepare<ActionMetadataRow, Array<string | number>>(
    `SELECT kind, metadata
         FROM actions
         WHERE ${conditions.join(" AND ")}
         ORDER BY id DESC
         LIMIT ?`
  )
  .all(...params);

const byKind = {
  sent_reply: 0,
  sent_message: 0,
  reply_skipped: 0
};
const totalMsValues = [];
const processingMsValues = [];
const queueMsValues = [];
const ingestMsValues = [];
const memorySliceMsValues = [];
const llm1MsValues = [];
const followupMsValues = [];
const typingDelayMsValues = [];
const sendMsValues = [];

for (const row of rows) {
  const metadata = safeJsonParse(row?.metadata, null);
  const performance = metadata?.performance;
  if (!performance || typeof performance !== "object") continue;

  const kind = String(row?.kind || "");
  if (kind in byKind) byKind[kind] += 1;

  pushPerformanceMetric(totalMsValues, performance.totalMs);
  pushPerformanceMetric(processingMsValues, performance.processingMs);
  pushPerformanceMetric(queueMsValues, performance.queueMs);
  pushPerformanceMetric(ingestMsValues, performance.ingestMs);
  pushPerformanceMetric(memorySliceMsValues, performance.memorySliceMs);
  pushPerformanceMetric(llm1MsValues, performance.llm1Ms);
  pushPerformanceMetric(followupMsValues, performance.followupMs);
  pushPerformanceMetric(typingDelayMsValues, performance.typingDelayMs);
  pushPerformanceMetric(sendMsValues, performance.sendMs);
}

return {
  windowHours: boundedHours,
  sampleLimit: boundedSamples,
  sampleCount: totalMsValues.length,
  byKind,
  totalMs: summarizeLatencyMetric(totalMsValues),
  processingMs: summarizeLatencyMetric(processingMsValues),
  phases: {
    queueMs: summarizeLatencyMetric(queueMsValues),
    ingestMs: summarizeLatencyMetric(ingestMsValues),
    memorySliceMs: summarizeLatencyMetric(memorySliceMsValues),
    llm1Ms: summarizeLatencyMetric(llm1MsValues),
    followupMs: summarizeLatencyMetric(followupMsValues),
    typingDelayMs: summarizeLatencyMetric(typingDelayMsValues),
    sendMs: summarizeLatencyMetric(sendMsValues)
  }
};
}

export function getStats(store: StatsStore, { guildId = null }: { guildId?: string | null } = {}) {
const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const normalizedGuildId = String(guildId || "").trim();
const actionConditions = ["created_at >= ?"];
const actionParams: Array<string | number> = [since24h];
if (normalizedGuildId) {
  actionConditions.push("guild_id = ?");
  actionParams.push(normalizedGuildId);
}

const rows = store.db
  .prepare<ActionKindCountRow, Array<string | number>>(
    `SELECT kind, COUNT(*) AS count
         FROM actions
         WHERE ${actionConditions.join(" AND ")}
         GROUP BY kind`
  )
  .all(...actionParams);

const totalCostRow = normalizedGuildId
  ? store.db
    .prepare<TotalCostRow, [string]>(
      `SELECT COALESCE(SUM(usd_cost), 0) AS total
           FROM actions
           WHERE guild_id = ?`
    )
    .get(normalizedGuildId)
  : store.db
    .prepare<TotalCostRow, []>(
      `SELECT COALESCE(SUM(usd_cost), 0) AS total
           FROM actions`
    )
    .get();

const dailySinceIso = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
const dayCostRows = normalizedGuildId
  ? store.db
    .prepare<DayCostRow, [string, string]>(
      `SELECT substr(created_at, 1, 10) AS day, COALESCE(SUM(usd_cost), 0) AS usd
           FROM actions
           WHERE created_at >= ?
             AND guild_id = ?
           GROUP BY day
           ORDER BY day DESC
           LIMIT 14`
    )
    .all(dailySinceIso, normalizedGuildId)
  : store.db
    .prepare<DayCostRow, [string]>(
      `SELECT substr(created_at, 1, 10) AS day, COALESCE(SUM(usd_cost), 0) AS usd
           FROM actions
           WHERE created_at >= ?
           GROUP BY day
           ORDER BY day DESC
           LIMIT 14`
    )
    .all(dailySinceIso);

  const out = {
  last24h: {
    sent_reply: 0,
    sent_message: 0,
    initiative_post: 0,
    reacted: 0,
    llm_call: 0,
    image_call: 0,
    gif_call: 0,
    search_call: 0,
    video_context_call: 0,
    asr_call: 0,
    voice_session_start: 0,
    voice_session_end: 0,
    voice_intent_detected: 0,
    voice_turn_in: 0,
    voice_turn_out: 0,
    voice_soundboard_play: 0,
    voice_error: 0
  },
  totalCostUsd: Number(totalCostRow?.total ?? 0),
  dailyCost: dayCostRows,
  performance: store.getReplyPerformanceStats({
    windowHours: 24,
    maxSamples: 4000,
    guildId: normalizedGuildId || null
  })
};

for (const row of rows) {
  if (row.kind in out.last24h) {
    out.last24h[row.kind] = Number(row.count ?? 0);
  }
}

return out;
}
