import { useCallback, useEffect, useRef, useState } from "react";
import { getToken } from "../api";

export type ActivitySSEStatus = "connecting" | "open" | "closed";

type ActivityAction = {
  id?: number;
  created_at?: string;
  kind?: string;
  content?: string;
  metadata?: unknown;
  [key: string]: unknown;
};

type ActivitySnapshot = {
  actions?: ActivityAction[];
  stats?: any;
};

const MAX_ACTIONS = 220;
const RECONNECT_DELAY_MS = 3_000;

export function useActivitySSE() {
  const [actions, setActions] = useState<ActivityAction[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [status, setStatus] = useState<ActivitySSEStatus>("connecting");
  const [lastSuccess, setLastSuccess] = useState<number | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const connect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const token = getToken();
    const url = `/api/activity/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const es = new EventSource(url);
    esRef.current = es;
    setStatus("connecting");

    es.addEventListener("activity_snapshot", (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as ActivitySnapshot;
        setActions(Array.isArray(payload?.actions) ? payload.actions.slice(0, MAX_ACTIONS) : []);
        setStats(payload?.stats ?? null);
        setLastSuccess(Date.now());
      } catch {
        // ignore malformed payload
      }
    });

    es.addEventListener("action_event", (event: MessageEvent) => {
      try {
        const action = JSON.parse(event.data) as ActivityAction;
        setActions((previous) => {
          const actionId = Number(action?.id || 0);
          if (actionId > 0 && previous.some((row) => Number(row?.id || 0) === actionId)) {
            return previous;
          }
          const next = [action, ...previous];
          return next.length > MAX_ACTIONS ? next.slice(0, MAX_ACTIONS) : next;
        });
        setLastSuccess(Date.now());
      } catch {
        // ignore malformed payload
      }
    });

    es.addEventListener("stats_update", (event: MessageEvent) => {
      try {
        setStats(JSON.parse(event.data));
        setLastSuccess(Date.now());
      } catch {
        // ignore malformed payload
      }
    });

    es.onopen = () => {
      setStatus("open");
    };

    es.onerror = () => {
      es.close();
      setStatus("closed");
      reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      esRef.current?.close();
    };
  }, [connect]);

  return {
    actions,
    stats,
    status,
    lastSuccess
  };
}
