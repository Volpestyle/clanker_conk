import { clamp } from "../utils.ts";

function normalizePerformanceMetricMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

export function pushPerformanceMetric(target, value) {
  const normalized = normalizePerformanceMetricMs(value);
  if (normalized === null) return;
  target.push(normalized);
}

function percentileNearestRank(sortedValues, percentile) {
  const values = Array.isArray(sortedValues) ? sortedValues : [];
  if (!values.length) return null;
  const p = clamp(Number(percentile) || 0, 0, 100);
  if (p <= 0) return values[0];
  if (p >= 100) return values[values.length - 1];

  const rank = Math.ceil((p / 100) * values.length);
  const index = clamp(rank - 1, 0, values.length - 1);
  return values[index];
}

export function summarizeLatencyMetric(values) {
  const numeric = (Array.isArray(values) ? values : [])
    .map((value) => normalizePerformanceMetricMs(value))
    .filter((value) => value !== null);
  if (!numeric.length) {
    return {
      count: 0,
      minMs: null,
      p50Ms: null,
      p95Ms: null,
      avgMs: null,
      maxMs: null
    };
  }

  const sorted = [...numeric].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    count: sorted.length,
    minMs: sorted[0],
    p50Ms: percentileNearestRank(sorted, 50),
    p95Ms: percentileNearestRank(sorted, 95),
    avgMs: Number((sum / sorted.length).toFixed(1)),
    maxMs: sorted[sorted.length - 1]
  };
}
