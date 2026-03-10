import type {
  LoggedVoicePromptBundle,
  VoiceLivePromptSlot,
  VoiceLivePromptState,
  VoiceSession
} from "./voiceSessionTypes.ts";

export function createEmptyVoiceLivePromptState(): VoiceLivePromptState {
  return {
    classifier: null,
    generation: null,
    bridge: null
  };
}

export function setVoiceLivePromptSnapshot(
  session: VoiceSession | null | undefined,
  slot: VoiceLivePromptSlot,
  {
    replyPrompts = null,
    source = null,
    updatedAt = Date.now()
  }: {
    replyPrompts?: LoggedVoicePromptBundle | null;
    source?: string | null;
    updatedAt?: number;
  } = {}
) {
  if (!session || !replyPrompts) return null;

  const state =
    session.livePromptState && typeof session.livePromptState === "object"
      ? session.livePromptState
      : createEmptyVoiceLivePromptState();
  const normalizedUpdatedAt = Number.isFinite(Number(updatedAt))
    ? Math.max(0, Math.round(Number(updatedAt)))
    : Date.now();

  const snapshot = {
    updatedAt: normalizedUpdatedAt,
    source: String(source || "").trim() || null,
    replyPrompts
  };

  state[slot] = snapshot;
  session.livePromptState = state;
  return snapshot;
}
