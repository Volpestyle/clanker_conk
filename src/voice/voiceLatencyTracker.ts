import type { VoiceLatencyStageEntry } from "./voiceSessionTypes.ts";

type VoiceLatencyStoreLike = {
  logAction: (entry: {
    kind: string;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    content: string;
    metadata?: Record<string, unknown>;
  }) => void;
};

type VoiceLatencySessionLike = {
  ending?: boolean;
  guildId?: string | null;
  textChannelId?: string | null;
  id?: string | null;
  mode?: string | null;
  latencyStages?: VoiceLatencyStageEntry[] | null;
};

export interface VoiceLatencyTrackerHost {
  store: VoiceLatencyStoreLike;
}

export function computeLatencyMs(startMs = 0, endMs = 0) {
  const normalizedStart = Number(startMs || 0);
  const normalizedEnd = Number(endMs || 0);
  if (!Number.isFinite(normalizedStart) || !Number.isFinite(normalizedEnd)) return null;
  if (normalizedStart <= 0 || normalizedEnd <= 0) return null;
  if (normalizedEnd < normalizedStart) return null;
  return Math.max(0, Math.round(normalizedEnd - normalizedStart));
}

export function buildVoiceLatencyStageMetrics({
  finalizedAtMs = 0,
  asrStartedAtMs = 0,
  asrCompletedAtMs = 0,
  generationStartedAtMs = 0,
  replyRequestedAtMs = 0,
  audioStartedAtMs = 0
} = {}) {
  return {
    finalizedToAsrStartMs: computeLatencyMs(finalizedAtMs, asrStartedAtMs),
    asrToGenerationStartMs: computeLatencyMs(asrCompletedAtMs, generationStartedAtMs),
    generationToReplyRequestMs: computeLatencyMs(generationStartedAtMs, replyRequestedAtMs),
    replyRequestToAudioStartMs: computeLatencyMs(replyRequestedAtMs, audioStartedAtMs)
  };
}

export function logVoiceLatencyStage(
  host: VoiceLatencyTrackerHost,
  payload: {
    session?: VoiceLatencySessionLike | null;
    userId?: string | null;
    botUserId?: string | null;
    stage?: string;
    source?: string;
    captureReason?: string | null;
    requestId?: number | string | null;
    queueWaitMs?: number | null;
    pendingQueueDepth?: number | null;
    finalizedAtMs?: number;
    asrStartedAtMs?: number;
    asrCompletedAtMs?: number;
    generationStartedAtMs?: number;
    replyRequestedAtMs?: number;
    audioStartedAtMs?: number;
  } | null = null
) {
  const {
    session = null,
    userId = null,
    botUserId = null,
    stage = "unknown",
    source = "realtime",
    captureReason = null,
    requestId = null,
    queueWaitMs = null,
    pendingQueueDepth = null,
    finalizedAtMs = 0,
    asrStartedAtMs = 0,
    asrCompletedAtMs = 0,
    generationStartedAtMs = 0,
    replyRequestedAtMs = 0,
    audioStartedAtMs = 0
  } = payload && typeof payload === "object" ? payload : {};
  if (!session || session.ending) return;

  const metrics = buildVoiceLatencyStageMetrics({
    finalizedAtMs,
    asrStartedAtMs,
    asrCompletedAtMs,
    generationStartedAtMs,
    replyRequestedAtMs,
    audioStartedAtMs
  });
  host.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: userId || botUserId || null,
    content: "voice_latency_stage",
    metadata: {
      sessionId: session.id,
      mode: session.mode,
      stage: String(stage || "unknown"),
      source: String(source || "realtime"),
      captureReason: captureReason ? String(captureReason) : null,
      requestId: Number.isFinite(Number(requestId)) && Number(requestId) > 0
        ? Number(requestId)
        : null,
      queueWaitMs: Number.isFinite(Number(queueWaitMs))
        ? Math.max(0, Math.round(Number(queueWaitMs)))
        : null,
      pendingQueueDepth: Number.isFinite(Number(pendingQueueDepth))
        ? Math.max(0, Math.round(Number(pendingQueueDepth)))
        : null,
      finalizedToAsrStartMs: metrics.finalizedToAsrStartMs,
      asrToGenerationStartMs: metrics.asrToGenerationStartMs,
      generationToReplyRequestMs: metrics.generationToReplyRequestMs,
      replyRequestToAudioStartMs: metrics.replyRequestToAudioStartMs
    }
  });

  if (String(stage || "").toLowerCase() !== "audio_started") {
    return;
  }

  const totalMs = [
    metrics.finalizedToAsrStartMs,
    metrics.asrToGenerationStartMs,
    metrics.generationToReplyRequestMs,
    metrics.replyRequestToAudioStartMs
  ].reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  const entry: VoiceLatencyStageEntry = {
    at: Date.now(),
    stage: String(stage),
    source: String(source || "realtime"),
    finalizedToAsrStartMs: metrics.finalizedToAsrStartMs,
    asrToGenerationStartMs: metrics.asrToGenerationStartMs,
    generationToReplyRequestMs: metrics.generationToReplyRequestMs,
    replyRequestToAudioStartMs: metrics.replyRequestToAudioStartMs,
    totalMs,
    queueWaitMs: Number.isFinite(Number(queueWaitMs))
      ? Math.max(0, Math.round(Number(queueWaitMs)))
      : null,
    pendingQueueDepth: Number.isFinite(Number(pendingQueueDepth))
      ? Math.max(0, Math.round(Number(pendingQueueDepth)))
      : null
  };

  if (!Array.isArray(session.latencyStages)) {
    session.latencyStages = [];
  }
  session.latencyStages.push(entry);
  if (session.latencyStages.length > 12) {
    session.latencyStages = session.latencyStages.slice(-12);
  }
}
