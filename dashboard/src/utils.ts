import type { CSSProperties } from "react";

export function rangeStyle(value: number, min = 0, max = 100): CSSProperties {
  const pct = ((value - min) / (max - min)) * 100;
  return {
    background: `linear-gradient(to right, var(--accent) ${pct}%, rgba(255,255,255,0.06) ${pct}%)`
  };
}

export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
