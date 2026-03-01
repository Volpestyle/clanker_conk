import { useState, useEffect, useRef, useCallback } from "react";
import { getToken } from "../api";

export type VoiceState = {
  activeCount: number;
  sessions: VoiceSession[];
};

export type VoiceTurn = {
  role: string;
  speakerName: string;
  text: string;
  at: string | null;
};

export type VoiceParticipant = {
  userId: string;
  displayName: string;
};

export type VoiceActiveCapture = {
  userId: string;
  displayName: string | null;
  startedAt: string | null;
  ageMs: number | null;
};

export type VoiceVisualFeedEntry = {
  text: string;
  at: string | null;
  provider: string | null;
  model: string | null;
  speakerName: string | null;
};

export type VoiceBrainContextPayload = {
  prompt: string;
  notes: string[];
  lastAt: string | null;
  provider: string | null;
  model: string | null;
} | null;

export type VoiceMembershipEvent = {
  userId: string;
  displayName: string;
  eventType: "join" | "leave" | string;
  at: string;
  ageMs: number;
};

export type RealtimeState = {
  connected?: boolean;
  connectedAt?: string;
  lastEventAt?: string;
  sessionId?: string;
  lastError?: string;
  lastCloseCode?: number;
  lastCloseReason?: string;
  lastOutboundEventType?: string;
  lastOutboundEventAt?: string;
  activeResponseId?: string;
  activeResponseStatus?: string;
  recentOutboundEvents?: Array<{ type: string; at: string; payloadSummary?: string }>;
  [key: string]: unknown;
};

export type LatencyTurnEntry = {
  at: string;
  finalizedToAsrStartMs: number | null;
  asrToGenerationStartMs: number | null;
  generationToReplyRequestMs: number | null;
  replyRequestToAudioStartMs: number | null;
  totalMs: number | null;
  queueWaitMs: number | null;
  pendingQueueDepth: number | null;
};

export type LatencyAverages = {
  finalizedToAsrStartMs: number | null;
  asrToGenerationStartMs: number | null;
  generationToReplyRequestMs: number | null;
  replyRequestToAudioStartMs: number | null;
  totalMs: number | null;
};

export type SessionLatency = {
  recentTurns: LatencyTurnEntry[];
  averages: LatencyAverages;
  turnCount: number;
} | null;

export type VoiceSession = {
  sessionId: string;
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  startedAt: string;
  lastActivityAt: string;
  maxEndsAt: string | null;
  inactivityEndsAt: string | null;
  activeInputStreams: number;
  activeCaptures: VoiceActiveCapture[];
  soundboard: { playCount: number; lastPlayedAt: string | null };
  mode: string;
  botTurnOpen: boolean;
  focusedSpeaker: { userId: string; displayName: string | null; since: string | null } | null;
  conversation: {
    lastAssistantReplyAt: string | null;
    lastDirectAddressAt: string | null;
    lastDirectAddressUserId: string | null;
    wake: {
      state: "awake" | "listening" | string;
      active: boolean;
      engagementState: string;
      engagedWithCurrentSpeaker: boolean;
      recentAssistantReply: boolean;
      recentDirectAddress: boolean;
      msSinceAssistantReply: number | null;
      msSinceDirectAddress: number | null;
      windowMs: number;
    };
    joinWindow: {
      active: boolean;
      ageMs: number;
      windowMs: number;
    };
    thoughtEngine: {
      busy: boolean;
      nextAttemptAt: string | null;
      lastAttemptAt: string | null;
      lastSpokenAt: string | null;
    };
    modelContext: {
      generation: {
        source: string;
        capturedAt: string;
        availableTurns: number;
        sentTurns: number;
        maxTurns: number;
        contextChars: number;
        transcriptChars: number;
        directAddressed: boolean;
      } | null;
      decider: {
        source: string;
        capturedAt: string;
        availableTurns: number;
        maxTurns: number;
        promptHistoryChars: number;
        transcriptChars: number;
        directAddressed: boolean;
        joinWindowActive: boolean;
      } | null;
      trackedTurns: number;
      trackedTurnLimit: number;
      trackedTranscriptTurns: number;
    };
  };
  participants: VoiceParticipant[];
  participantCount: number;
  membershipEvents: VoiceMembershipEvent[];
  voiceLookupBusyCount: number;
  pendingDeferredTurns: number;
  recentTurns: VoiceTurn[];
  streamWatch: {
    active: boolean;
    targetUserId: string | null;
    requestedByUserId: string | null;
    lastFrameAt: string | null;
    lastCommentaryAt: string | null;
    latestFrameAt: string | null;
    latestFrameMimeType: string | null;
    latestFrameApproxBytes: number;
    acceptedFrameCountInWindow: number;
    frameWindowStartedAt: string | null;
    ingestedFrameCount: number;
    lastBrainContextAt: string | null;
    lastBrainContextProvider: string | null;
    lastBrainContextModel: string | null;
    brainContextCount: number;
    visualFeed: VoiceVisualFeedEntry[];
    brainContextPayload: VoiceBrainContextPayload;
  };
  stt: { pendingTurns: number; contextMessages: number } | null;
  realtime: {
    provider: string;
    inputSampleRateHz: number;
    outputSampleRateHz: number;
    recentVoiceTurns: number;
    replySuperseded: number;
    pendingTurns: number;
    drainActive: boolean;
    state: RealtimeState | null;
  } | null;
  latency: SessionLatency;
};

export type VoiceEvent = {
  kind: string;
  createdAt: string;
  content?: string;
  guildId?: string;
  channelId?: string;
  metadata?: unknown;
  [key: string]: unknown;
};

export type SSEStatus = "connecting" | "open" | "closed";

const MAX_EVENTS = 200;
const RECONNECT_DELAY_MS = 3_000;

export function useVoiceSSE() {
  const [voiceState, setVoiceState] = useState<VoiceState | null>(null);
  const [events, setEvents] = useState<VoiceEvent[]>([]);
  const [status, setStatus] = useState<SSEStatus>("connecting");
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    const token = getToken();
    const url = `/api/voice/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const es = new EventSource(url);
    esRef.current = es;
    setStatus("connecting");

    es.addEventListener("voice_state", (e: MessageEvent) => {
      try {
        setVoiceState(JSON.parse(e.data));
      } catch { /* malformed */ }
    });

    es.addEventListener("voice_event", (e: MessageEvent) => {
      try {
        const evt: VoiceEvent = JSON.parse(e.data);
        setEvents((prev) => {
          const next = [evt, ...prev];
          return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
        });
      } catch { /* malformed */ }
    });

    es.onopen = () => setStatus("open");

    es.onerror = () => {
      es.close();
      setStatus("closed");
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      esRef.current?.close();
    };
  }, [connect]);

  return { voiceState, events, status };
}
