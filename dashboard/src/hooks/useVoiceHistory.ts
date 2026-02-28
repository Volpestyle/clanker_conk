import { useState, useEffect, useCallback } from "react";
import { api } from "../api";
import type { VoiceEvent } from "./useVoiceSSE";

export type HistorySession = {
  sessionId: string;
  guildId: string;
  mode: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  endReason: string;
};

export function useVoiceHistory() {
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<VoiceEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(() => {
    api<HistorySession[]>("/api/voice/history/sessions?limit=3")
      .then((rows) => setSessions(Array.isArray(rows) ? rows : []))
      .catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  useEffect(() => {
    if (!selectedSessionId) {
      setEvents([]);
      return;
    }
    setLoading(true);
    setError(null);

    type RawEvent = {
      created_at: string;
      kind: string;
      content?: string;
      guild_id?: string;
      channel_id?: string;
      metadata?: unknown;
    };

    api<RawEvent[]>(`/api/voice/history/sessions/${encodeURIComponent(selectedSessionId)}/events`)
      .then((rows) => {
        const mapped: VoiceEvent[] = (Array.isArray(rows) ? rows : []).map((r) => ({
          kind: r.kind,
          createdAt: r.created_at,
          content: r.content,
          guildId: r.guild_id,
          channelId: r.channel_id,
          metadata: r.metadata
        }));
        setEvents(mapped);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [selectedSessionId]);

  const toggle = useCallback((id: string) => {
    setSelectedSessionId((prev) => (prev === id ? null : id));
  }, []);

  const refresh = useCallback(() => {
    fetchSessions();
  }, [fetchSessions]);

  return { sessions, selectedSessionId, events, loading, error, toggle, refresh };
}
