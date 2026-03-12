export const REALTIME_INTERRUPT_ACCEPTANCE_MODES = [
  "immediate_provider_ack",
  "local_cut_async_confirmation"
] as const;

export type RealtimeInterruptAcceptanceMode =
  (typeof REALTIME_INTERRUPT_ACCEPTANCE_MODES)[number];

export function normalizeRealtimeInterruptAcceptanceMode(
  value: unknown
): RealtimeInterruptAcceptanceMode {
  if (value === "local_cut_async_confirmation") {
    return "local_cut_async_confirmation";
  }
  return "immediate_provider_ack";
}
