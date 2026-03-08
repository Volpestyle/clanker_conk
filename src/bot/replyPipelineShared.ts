export const UNICODE_REACTIONS = ["🔥", "💀", "😂", "👀", "🤝", "🫡", "😮", "🧠", "💯", "😭"];
export const MAX_MODEL_IMAGE_INPUTS = 8;
export const LOOKUP_CONTEXT_PROMPT_LIMIT = 4;
export const LOOKUP_CONTEXT_PROMPT_MAX_AGE_HOURS = 72;
export const CONVERSATION_HISTORY_PROMPT_LIMIT = 2;
export const CONVERSATION_HISTORY_PROMPT_MAX_AGE_HOURS = 12;
export const CONVERSATION_HISTORY_PROMPT_WINDOW_BEFORE = 1;
export const CONVERSATION_HISTORY_PROMPT_WINDOW_AFTER = 1;
export const REPLY_PERFORMANCE_VERSION = 1;

export type ReplyPerformanceSeed = {
  triggerMessageCreatedAtMs?: number | null;
  queuedAtMs?: number | null;
  ingestMs?: number | null;
};

export type ReplyPerformanceTracker = {
  source: string;
  startedAtMs: number;
  triggerMessageCreatedAtMs: number | null;
  queuedAtMs: number | null;
  ingestMs: number | null;
  memorySliceMs: number | null;
  llm1Ms: number | null;
  followupMs: number | null;
};

export type ReplyPromptCapture = {
  systemPrompt: string;
  initialUserPrompt: string;
  followupUserPrompts: string[];
};

export type LoggedReplyPrompts = {
  hiddenByDefault: boolean;
  systemPrompt: string;
  initialUserPrompt: string;
  followupUserPrompts: string[];
  followupSteps: number;
};

export function normalizeNonNegativeMs(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0) return null;
  return Math.floor(parsed);
}

export function normalizeReplyPerformanceSeed(seed: ReplyPerformanceSeed = {}) {
  const triggerMessageCreatedAtMs = normalizeNonNegativeMs(seed?.triggerMessageCreatedAtMs);
  const queuedAtMs = normalizeNonNegativeMs(seed?.queuedAtMs);
  const ingestMs = normalizeNonNegativeMs(seed?.ingestMs);
  if (triggerMessageCreatedAtMs === null && queuedAtMs === null && ingestMs === null) return null;

  return {
    triggerMessageCreatedAtMs,
    queuedAtMs,
    ingestMs
  };
}

export function createReplyPerformanceTracker({
  messageCreatedAtMs = null,
  source = "message_event",
  seed = null
}: {
  messageCreatedAtMs?: number | null;
  source?: string;
  seed?: ReplyPerformanceSeed | null;
} = {}): ReplyPerformanceTracker {
  const normalizedSeed = normalizeReplyPerformanceSeed({
    triggerMessageCreatedAtMs: seed?.triggerMessageCreatedAtMs ?? messageCreatedAtMs,
    queuedAtMs: seed?.queuedAtMs,
    ingestMs: seed?.ingestMs
  });
  const startedAtMs = Date.now();

  return {
    source: String(source || "message_event"),
    startedAtMs,
    triggerMessageCreatedAtMs: normalizedSeed?.triggerMessageCreatedAtMs ?? normalizeNonNegativeMs(messageCreatedAtMs),
    queuedAtMs: normalizedSeed?.queuedAtMs ?? null,
    ingestMs: normalizedSeed?.ingestMs ?? null,
    memorySliceMs: null,
    llm1Ms: null,
    followupMs: null
  };
}

export function createReplyPromptCapture({
  systemPrompt = "",
  initialUserPrompt = ""
}: {
  systemPrompt?: string;
  initialUserPrompt?: string;
} = {}): ReplyPromptCapture {
  return {
    systemPrompt: String(systemPrompt || ""),
    initialUserPrompt: String(initialUserPrompt || ""),
    followupUserPrompts: []
  };
}

export function buildLoggedReplyPrompts(
  capture: ReplyPromptCapture | null = null,
  followupSteps = 0
): LoggedReplyPrompts | null {
  if (!capture || typeof capture !== "object") return null;
  const systemPrompt = String(capture.systemPrompt || "");
  const initialUserPrompt = String(capture.initialUserPrompt || "");
  const followupUserPrompts = Array.isArray(capture.followupUserPrompts)
    ? capture.followupUserPrompts.map((prompt) => String(prompt || ""))
    : [];
  const resolvedFollowupSteps = Math.max(
    0,
    Number.isFinite(Number(followupSteps))
      ? Math.floor(Number(followupSteps))
      : followupUserPrompts.length
  );

  return {
    hiddenByDefault: true,
    systemPrompt,
    initialUserPrompt,
    followupUserPrompts,
    followupSteps: resolvedFollowupSteps
  };
}

export function finalizeReplyPerformanceSample({
  performance,
  actionKind,
  typingDelayMs = null,
  sendMs = null
}: {
  performance?: ReplyPerformanceTracker | null;
  actionKind?: string;
  typingDelayMs?: number | null;
  sendMs?: number | null;
} = {}) {
  if (!performance || typeof performance !== "object") return null;

  const finishedAtMs = Date.now();
  const triggerMessageCreatedAtMs = normalizeNonNegativeMs(performance.triggerMessageCreatedAtMs);
  const startedAtMs = normalizeNonNegativeMs(performance.startedAtMs);
  const queuedAtMs = normalizeNonNegativeMs(performance.queuedAtMs);
  const normalizedSendMs = normalizeNonNegativeMs(sendMs);
  const normalizedTypingDelayMs = normalizeNonNegativeMs(typingDelayMs);
  const triggerToFinishMs =
    triggerMessageCreatedAtMs !== null ? Math.max(0, finishedAtMs - triggerMessageCreatedAtMs) : null;
  const hasReasonableTriggerBaseline =
    triggerToFinishMs !== null && triggerToFinishMs <= 15 * 60 * 1000;
  const totalMs = hasReasonableTriggerBaseline
    ? triggerToFinishMs
    : queuedAtMs !== null
      ? Math.max(0, finishedAtMs - queuedAtMs)
      : startedAtMs !== null
        ? Math.max(0, finishedAtMs - startedAtMs)
        : null;
  const processingMs = startedAtMs !== null ? Math.max(0, finishedAtMs - startedAtMs) : null;
  const queueMs = startedAtMs !== null && queuedAtMs !== null ? Math.max(0, startedAtMs - queuedAtMs) : null;

  const sample = {
    version: REPLY_PERFORMANCE_VERSION,
    source: String(performance.source || "message_event"),
    actionKind: String(actionKind || "unknown"),
    totalMs: normalizeNonNegativeMs(totalMs),
    queueMs: normalizeNonNegativeMs(queueMs),
    processingMs: normalizeNonNegativeMs(processingMs),
    ingestMs: normalizeNonNegativeMs(performance.ingestMs),
    memorySliceMs: normalizeNonNegativeMs(performance.memorySliceMs),
    llm1Ms: normalizeNonNegativeMs(performance.llm1Ms),
    followupMs: normalizeNonNegativeMs(performance.followupMs),
    typingDelayMs: normalizedTypingDelayMs,
    sendMs: normalizedSendMs
  };

  const hasAnyTiming = [
    sample.totalMs,
    sample.queueMs,
    sample.processingMs,
    sample.ingestMs,
    sample.memorySliceMs,
    sample.llm1Ms,
    sample.followupMs,
    sample.typingDelayMs,
    sample.sendMs
  ].some((value) => typeof value === "number");
  return hasAnyTiming ? sample : null;
}
