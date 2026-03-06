export const SYSTEM_SPEECH_OPPORTUNITY = {
  JOIN_GREETING: "join_greeting",
  THOUGHT: "thought"
} as const;

export type SystemSpeechOpportunityType =
  typeof SYSTEM_SPEECH_OPPORTUNITY[keyof typeof SYSTEM_SPEECH_OPPORTUNITY];

export const SYSTEM_SPEECH_SOURCE = {
  JOIN_GREETING: "voice_join_greeting",
  THOUGHT: "voice_thought_engine",
  THOUGHT_TTS: "voice_thought_engine_tts"
} as const;

export type SystemSpeechReplyAccounting = "none" | "requested" | "spoken";

type SystemSpeechOpportunityDefinition = {
  type: SystemSpeechOpportunityType;
  sourcePrefixes: readonly string[];
  cancelOnPromotedUserSpeechBeforePlayback: boolean;
  liveCaptureSupersedeBeforePlayback: boolean;
  replyAccountingOnRequest: SystemSpeechReplyAccounting;
  replyAccountingOnLocalPlayback: SystemSpeechReplyAccounting;
};

const SYSTEM_SPEECH_OPPORTUNITY_DEFINITIONS: readonly SystemSpeechOpportunityDefinition[] = [
  {
    type: SYSTEM_SPEECH_OPPORTUNITY.JOIN_GREETING,
    sourcePrefixes: [SYSTEM_SPEECH_SOURCE.JOIN_GREETING],
    cancelOnPromotedUserSpeechBeforePlayback: true,
    liveCaptureSupersedeBeforePlayback: true,
    replyAccountingOnRequest: "requested",
    replyAccountingOnLocalPlayback: "spoken"
  },
  {
    type: SYSTEM_SPEECH_OPPORTUNITY.THOUGHT,
    sourcePrefixes: [SYSTEM_SPEECH_SOURCE.THOUGHT, SYSTEM_SPEECH_SOURCE.THOUGHT_TTS],
    cancelOnPromotedUserSpeechBeforePlayback: true,
    liveCaptureSupersedeBeforePlayback: true,
    replyAccountingOnRequest: "requested",
    replyAccountingOnLocalPlayback: "spoken"
  }
] as const;

function normalizeSource(source: string | null | undefined): string {
  return String(source || "").trim().toLowerCase();
}

function resolveSystemSpeechOpportunityDefinition(
  source: string | null | undefined
): SystemSpeechOpportunityDefinition | null {
  const normalizedSource = normalizeSource(source);
  if (!normalizedSource) return null;

  for (const definition of SYSTEM_SPEECH_OPPORTUNITY_DEFINITIONS) {
    if (definition.sourcePrefixes.some((prefix) => normalizedSource.startsWith(prefix))) {
      return definition;
    }
  }
  return null;
}

export function resolveSystemSpeechOpportunityType(
  source: string | null | undefined
): SystemSpeechOpportunityType | null {
  return resolveSystemSpeechOpportunityDefinition(source)?.type || null;
}

export function isSystemSpeechOpportunitySource(
  source: string | null | undefined
): boolean {
  return resolveSystemSpeechOpportunityDefinition(source) !== null;
}

export function isJoinGreetingOpportunitySource(
  source: string | null | undefined
): boolean {
  return resolveSystemSpeechOpportunityType(source) === SYSTEM_SPEECH_OPPORTUNITY.JOIN_GREETING;
}

export function shouldCancelSystemSpeechBeforeAudioOnPromotedUserSpeech(
  source: string | null | undefined
): boolean {
  return Boolean(resolveSystemSpeechOpportunityDefinition(source)?.cancelOnPromotedUserSpeechBeforePlayback);
}

export function shouldSupersedeSystemSpeechBeforePlayback(
  source: string | null | undefined
): boolean {
  return Boolean(resolveSystemSpeechOpportunityDefinition(source)?.liveCaptureSupersedeBeforePlayback);
}

export function resolveSystemSpeechReplyAccountingOnRequest(
  source: string | null | undefined
): SystemSpeechReplyAccounting | null {
  return resolveSystemSpeechOpportunityDefinition(source)?.replyAccountingOnRequest || null;
}

export function resolveSystemSpeechReplyAccountingOnLocalPlayback(
  source: string | null | undefined
): SystemSpeechReplyAccounting | null {
  return resolveSystemSpeechOpportunityDefinition(source)?.replyAccountingOnLocalPlayback || null;
}
