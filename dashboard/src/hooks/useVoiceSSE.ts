import { useState, useEffect, useRef, useCallback } from "react";
import { getToken } from "../api";

export type VoiceState = {
  activeCount: number;
  sessions: VoiceSession[];
};

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
  soundboard: { playCount: number; lastPlayedAt: string | null };
  mode: string;
  streamWatch: {
    active: boolean;
    targetUserId: string | null;
    requestedByUserId: string | null;
    lastFrameAt: string | null;
    lastCommentaryAt: string | null;
    ingestedFrameCount: number;
  };
  stt: { pendingTurns: number; contextMessages: number } | null;
  realtime: {
    provider: string;
    inputSampleRateHz: number;
    outputSampleRateHz: number;
    recentVoiceTurns: number;
    pendingTurns: number;
    state: unknown;
  } | null;
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
