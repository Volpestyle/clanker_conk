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

function extractSessionId(metadata: unknown): string {
  if (!metadata || typeof metadata !== "object") return "";
  const rawSessionId = (metadata as { sessionId?: unknown }).sessionId;
  return String(rawSessionId || "").trim();
}

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

  const ingestLiveEvent = useCallback((event: VoiceEvent | null | undefined) => {
    const liveEvent = event && typeof event === "object" ? event : null;
    if (!liveEvent) return;
    if (!selectedSessionId) return;
    const sessionId = extractSessionId(liveEvent.metadata);
    if (!sessionId || sessionId !== selectedSessionId) return;

    setEvents((previous) => {
      const createdAt = String(liveEvent.createdAt || "").trim();
      const kind = String(liveEvent.kind || "").trim();
      const content = String(liveEvent.content || "").trim();
      const alreadyPresent = previous.some((row) => {
        const rowCreatedAt = String(row?.createdAt || "").trim();
        const rowKind = String(row?.kind || "").trim();
        const rowContent = String(row?.content || "").trim();
        return rowCreatedAt === createdAt && rowKind === kind && rowContent === content;
      });
      if (alreadyPresent) return previous;

      const next = [...previous, liveEvent];
      next.sort((a, b) => {
        const aAt = String(a?.createdAt || "");
        const bAt = String(b?.createdAt || "");
        if (aAt === bAt) return 0;
        return aAt > bAt ? 1 : -1;
      });
      return next;
    });
  }, [selectedSessionId]);

  return { sessions, selectedSessionId, events, loading, error, toggle, refresh, ingestLiveEvent };
}
