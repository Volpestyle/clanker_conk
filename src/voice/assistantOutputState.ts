export const ASSISTANT_OUTPUT_PHASE = {
  IDLE: "idle",
  RESPONSE_PENDING: "response_pending",
  AWAITING_TOOL_OUTPUTS: "awaiting_tool_outputs",
  SPEAKING_LIVE: "speaking_live",
  SPEAKING_BUFFERED: "speaking_buffered"
} as const;

export type AssistantOutputPhase =
  typeof ASSISTANT_OUTPUT_PHASE[keyof typeof ASSISTANT_OUTPUT_PHASE];

export const TTS_PLAYBACK_STATE = {
  IDLE: "idle",
  BUFFERED: "buffered"
} as const;

export type TtsPlaybackState =
  typeof TTS_PLAYBACK_STATE[keyof typeof TTS_PLAYBACK_STATE];

export const ASSISTANT_OUTPUT_REASON = {
  IDLE: "idle",
  PENDING_RESPONSE: "pending_response",
  OPENAI_ACTIVE_RESPONSE: "openai_active_response",
  AWAITING_TOOL_OUTPUTS: "awaiting_tool_outputs",
  BOT_AUDIO_LIVE: "bot_audio_live",
  BOT_AUDIO_BUFFERED: "bot_audio_buffered"
} as const;

export type AssistantOutputReason =
  typeof ASSISTANT_OUTPUT_REASON[keyof typeof ASSISTANT_OUTPUT_REASON];

export type AssistantOutputLockReason =
  | AssistantOutputReason
  | "music_playback_active"
  | "session_inactive";

export interface AssistantOutputState {
  phase: AssistantOutputPhase;
  reason: AssistantOutputReason;
  phaseEnteredAt: number;
  lastSyncedAt: number;
  requestId: number | null;
  ttsPlaybackState: TtsPlaybackState;
  ttsBufferedSamples: number;
  lastTrigger: string | null;
}

export interface AssistantOutputSignals {
  liveAudioStreaming: boolean;
  pendingResponse: boolean;
  openAiActiveResponse: boolean;
  awaitingToolOutputs: boolean;
  ttsPlaybackState?: string | null;
  ttsBufferedSamples?: number | null;
  requestId?: number | null;
}

export interface ReplyOutputLockState {
  locked: boolean;
  reason: AssistantOutputLockReason;
  phase: AssistantOutputPhase;
  musicActive: boolean;
  botTurnOpen: boolean;
  bufferedBotSpeech: boolean;
  pendingResponse: boolean;
  openAiActiveResponse: boolean;
  awaitingToolOutputs: boolean;
  streamBufferedBytes: number;
}

function normalizePositiveInteger(value: number | null | undefined): number | null {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return Math.round(normalized);
}

export function normalizeAssistantOutputPhase(
  phase: string | null | undefined
): AssistantOutputPhase {
  switch (String(phase || "").trim()) {
    case ASSISTANT_OUTPUT_PHASE.RESPONSE_PENDING:
      return ASSISTANT_OUTPUT_PHASE.RESPONSE_PENDING;
    case ASSISTANT_OUTPUT_PHASE.AWAITING_TOOL_OUTPUTS:
      return ASSISTANT_OUTPUT_PHASE.AWAITING_TOOL_OUTPUTS;
    case ASSISTANT_OUTPUT_PHASE.SPEAKING_LIVE:
      return ASSISTANT_OUTPUT_PHASE.SPEAKING_LIVE;
    case ASSISTANT_OUTPUT_PHASE.SPEAKING_BUFFERED:
      return ASSISTANT_OUTPUT_PHASE.SPEAKING_BUFFERED;
    default:
      return ASSISTANT_OUTPUT_PHASE.IDLE;
  }
}

export function normalizeTtsPlaybackState(
  state: string | null | undefined
): TtsPlaybackState {
  return String(state || "").trim() === TTS_PLAYBACK_STATE.BUFFERED
    ? TTS_PLAYBACK_STATE.BUFFERED
    : TTS_PLAYBACK_STATE.IDLE;
}

export function normalizeAssistantOutputReason(
  reason: string | null | undefined
): AssistantOutputReason | null {
  switch (String(reason || "").trim()) {
    case ASSISTANT_OUTPUT_REASON.PENDING_RESPONSE:
      return ASSISTANT_OUTPUT_REASON.PENDING_RESPONSE;
    case ASSISTANT_OUTPUT_REASON.OPENAI_ACTIVE_RESPONSE:
      return ASSISTANT_OUTPUT_REASON.OPENAI_ACTIVE_RESPONSE;
    case ASSISTANT_OUTPUT_REASON.AWAITING_TOOL_OUTPUTS:
      return ASSISTANT_OUTPUT_REASON.AWAITING_TOOL_OUTPUTS;
    case ASSISTANT_OUTPUT_REASON.BOT_AUDIO_LIVE:
      return ASSISTANT_OUTPUT_REASON.BOT_AUDIO_LIVE;
    case ASSISTANT_OUTPUT_REASON.BOT_AUDIO_BUFFERED:
      return ASSISTANT_OUTPUT_REASON.BOT_AUDIO_BUFFERED;
    case ASSISTANT_OUTPUT_REASON.IDLE:
      return ASSISTANT_OUTPUT_REASON.IDLE;
    default:
      return null;
  }
}

export function assistantOutputPhaseToReason(
  phase: AssistantOutputPhase,
  {
    pendingResponse = false,
    openAiActiveResponse = false
  }: {
    pendingResponse?: boolean;
    openAiActiveResponse?: boolean;
  } = {}
): AssistantOutputReason {
  switch (normalizeAssistantOutputPhase(phase)) {
    case ASSISTANT_OUTPUT_PHASE.SPEAKING_LIVE:
      return ASSISTANT_OUTPUT_REASON.BOT_AUDIO_LIVE;
    case ASSISTANT_OUTPUT_PHASE.SPEAKING_BUFFERED:
      return ASSISTANT_OUTPUT_REASON.BOT_AUDIO_BUFFERED;
    case ASSISTANT_OUTPUT_PHASE.AWAITING_TOOL_OUTPUTS:
      return ASSISTANT_OUTPUT_REASON.AWAITING_TOOL_OUTPUTS;
    case ASSISTANT_OUTPUT_PHASE.RESPONSE_PENDING:
      return pendingResponse
        ? ASSISTANT_OUTPUT_REASON.PENDING_RESPONSE
        : openAiActiveResponse
          ? ASSISTANT_OUTPUT_REASON.OPENAI_ACTIVE_RESPONSE
          : ASSISTANT_OUTPUT_REASON.PENDING_RESPONSE;
    default:
      return ASSISTANT_OUTPUT_REASON.IDLE;
  }
}

export function createAssistantOutputState({
  now = Date.now(),
  trigger = "session_start"
}: {
  now?: number;
  trigger?: string | null;
} = {}): AssistantOutputState {
  return {
    phase: ASSISTANT_OUTPUT_PHASE.IDLE,
    reason: ASSISTANT_OUTPUT_REASON.IDLE,
    phaseEnteredAt: now,
    lastSyncedAt: now,
    requestId: null,
    ttsPlaybackState: TTS_PLAYBACK_STATE.IDLE,
    ttsBufferedSamples: 0,
    lastTrigger: String(trigger || "").trim() || null
  };
}

export function normalizeAssistantOutputState(
  state: Partial<AssistantOutputState> | null | undefined,
  { now = Date.now() }: { now?: number } = {}
): AssistantOutputState {
  const seeded = createAssistantOutputState({ now, trigger: "normalize" });
  if (!state || typeof state !== "object") {
    return seeded;
  }

  const phase = normalizeAssistantOutputPhase(state.phase);
  const reason =
    normalizeAssistantOutputReason(state.reason) ||
    assistantOutputPhaseToReason(phase);

  return {
    phase,
    reason,
    phaseEnteredAt: Math.max(0, Number(state.phaseEnteredAt || 0)) || now,
    lastSyncedAt: Math.max(0, Number(state.lastSyncedAt || 0)) || now,
    requestId: normalizePositiveInteger(state.requestId),
    ttsPlaybackState: normalizeTtsPlaybackState(state.ttsPlaybackState),
    ttsBufferedSamples: Math.max(0, Number(state.ttsBufferedSamples || 0)),
    lastTrigger: String(state.lastTrigger || "").trim() || null
  };
}

export function patchAssistantOutputState(
  previousState: Partial<AssistantOutputState> | null | undefined,
  {
    now = Date.now(),
    trigger = null,
    requestId,
    ttsPlaybackState,
    ttsBufferedSamples
  }: {
    now?: number;
    trigger?: string | null;
    requestId?: number | null;
    ttsPlaybackState?: string | null;
    ttsBufferedSamples?: number | null;
  } = {}
): AssistantOutputState {
  const state = normalizeAssistantOutputState(previousState, { now });
  const nextState: AssistantOutputState = {
    ...state,
    lastSyncedAt: now,
    lastTrigger: String(trigger || "").trim() || state.lastTrigger
  };

  if (requestId !== undefined) {
    nextState.requestId = normalizePositiveInteger(requestId);
  }
  if (ttsPlaybackState !== undefined) {
    nextState.ttsPlaybackState = normalizeTtsPlaybackState(ttsPlaybackState);
  }
  if (ttsBufferedSamples !== undefined) {
    nextState.ttsBufferedSamples = Math.max(0, Number(ttsBufferedSamples || 0));
  }
  if (nextState.ttsBufferedSamples > 0) {
    nextState.ttsPlaybackState = TTS_PLAYBACK_STATE.BUFFERED;
  }
  return nextState;
}

export function getAssistantOutputActivityAt(
  state: Partial<AssistantOutputState> | null | undefined
): number {
  const normalized = normalizeAssistantOutputState(state, { now: Date.now() });
  return normalized.phase === ASSISTANT_OUTPUT_PHASE.IDLE
    ? 0
    : Math.max(0, Number(normalized.phaseEnteredAt || 0));
}

export function syncAssistantOutputStateRecord(
  previousState: Partial<AssistantOutputState> | null | undefined,
  {
    now = Date.now(),
    trigger = null,
    liveAudioStreaming = false,
    pendingResponse = false,
    openAiActiveResponse = false,
    awaitingToolOutputs = false,
    ttsPlaybackState,
    ttsBufferedSamples = 0,
    requestId = null
  }: AssistantOutputSignals & {
    now?: number;
    trigger?: string | null;
  }
): AssistantOutputState {
  const state = normalizeAssistantOutputState(previousState, { now });
  const normalizedBufferedSamples = Math.max(0, Number(ttsBufferedSamples || 0));
  let normalizedTtsPlaybackState = normalizeTtsPlaybackState(
    ttsPlaybackState ?? state.ttsPlaybackState
  );
  if (normalizedBufferedSamples > 0) {
    normalizedTtsPlaybackState = TTS_PLAYBACK_STATE.BUFFERED;
  }

  const bufferedBotSpeech =
    normalizedTtsPlaybackState === TTS_PLAYBACK_STATE.BUFFERED || normalizedBufferedSamples > 0;

  let phase: AssistantOutputPhase = ASSISTANT_OUTPUT_PHASE.IDLE;
  if (liveAudioStreaming) {
    phase = ASSISTANT_OUTPUT_PHASE.SPEAKING_LIVE;
  } else if (bufferedBotSpeech) {
    phase = ASSISTANT_OUTPUT_PHASE.SPEAKING_BUFFERED;
  } else if (awaitingToolOutputs) {
    phase = ASSISTANT_OUTPUT_PHASE.AWAITING_TOOL_OUTPUTS;
  } else if (pendingResponse || openAiActiveResponse) {
    phase = ASSISTANT_OUTPUT_PHASE.RESPONSE_PENDING;
  }

  const reason = assistantOutputPhaseToReason(phase, {
    pendingResponse,
    openAiActiveResponse
  });

  return {
    phase,
    reason,
    phaseEnteredAt: state.phase === phase ? state.phaseEnteredAt : now,
    lastSyncedAt: now,
    requestId:
      phase === ASSISTANT_OUTPUT_PHASE.IDLE
        ? null
        : normalizePositiveInteger(requestId) ?? state.requestId,
    ttsPlaybackState: normalizedTtsPlaybackState,
    ttsBufferedSamples: normalizedBufferedSamples,
    lastTrigger: String(trigger || "").trim() || state.lastTrigger
  };
}

export function buildReplyOutputLockState({
  assistantOutput,
  musicActive = false,
  botTurnOpen = false,
  pendingResponse = false,
  openAiActiveResponse = false,
  awaitingToolOutputs = false,
  streamBufferedBytes = 0
}: {
  assistantOutput: Partial<AssistantOutputState> | null | undefined;
  musicActive?: boolean;
  botTurnOpen?: boolean;
  pendingResponse?: boolean;
  openAiActiveResponse?: boolean;
  awaitingToolOutputs?: boolean;
  streamBufferedBytes?: number;
}): ReplyOutputLockState {
  const normalizedAssistantOutput = normalizeAssistantOutputState(assistantOutput, {
    now: Date.now()
  });
  const phase = normalizeAssistantOutputPhase(normalizedAssistantOutput.phase);
  const locked = Boolean(musicActive) || phase !== ASSISTANT_OUTPUT_PHASE.IDLE;
  const bufferedBotSpeech = phase === ASSISTANT_OUTPUT_PHASE.SPEAKING_BUFFERED;

  let reason: AssistantOutputLockReason = ASSISTANT_OUTPUT_REASON.IDLE;
  if (musicActive) {
    reason = "music_playback_active";
  } else if (normalizedAssistantOutput.reason) {
    reason = normalizedAssistantOutput.reason;
  }

  return {
    locked,
    reason,
    phase,
    musicActive: Boolean(musicActive),
    botTurnOpen: Boolean(botTurnOpen),
    bufferedBotSpeech,
    pendingResponse: Boolean(pendingResponse),
    openAiActiveResponse: Boolean(openAiActiveResponse),
    awaitingToolOutputs: Boolean(awaitingToolOutputs),
    streamBufferedBytes: Math.max(0, Number(streamBufferedBytes || 0))
  };
}
