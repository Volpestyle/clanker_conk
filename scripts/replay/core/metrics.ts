export type NumericStats = {
  count: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
};

export function quantile(values: number[], q: number) {
  const sorted = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] || 0;
}

export function summarizeNumericSeries(values: number[]): NumericStats | null {
  const normalized = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (!normalized.length) return null;
  const total = normalized.reduce((sum, value) => sum + value, 0);
  return {
    count: normalized.length,
    minMs: Math.min(...normalized),
    maxMs: Math.max(...normalized),
    avgMs: total / normalized.length,
    p50Ms: quantile(normalized, 0.5),
    p95Ms: quantile(normalized, 0.95)
  };
}

export function summarizeNamedMetricRows(
  rows: Array<Record<string, number>>,
  { skipNonPositive = true }: { skipNonPositive?: boolean } = {}
): Record<string, NumericStats> {
  const buckets = new Map<string, number[]>();

  for (const row of rows) {
    for (const [key, value] of Object.entries(row || {})) {
      const numericValue = Number(value);
      if (!Number.isFinite(numericValue)) continue;
      if (skipNonPositive && numericValue <= 0) continue;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)?.push(numericValue);
    }
  }

  const out: Record<string, NumericStats> = {};
  for (const [key, values] of buckets.entries()) {
    const stats = summarizeNumericSeries(values);
    if (!stats) continue;
    out[key] = stats;
  }

  return out;
}
