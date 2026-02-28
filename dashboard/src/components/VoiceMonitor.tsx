import { useState, useEffect, useRef } from "react";
import { useVoiceSSE, type VoiceSession, type VoiceEvent } from "../hooks/useVoiceSSE";

// ---- helpers ----

function deriveBotState(s: VoiceSession): "processing" | "listening" | "idle" | "disconnected" {
  const pendingTurns = (s.stt?.pendingTurns || 0) + (s.realtime?.pendingTurns || 0);
  if (pendingTurns > 0) return "processing";
  if (s.activeInputStreams > 0) return "listening";
  const connected = s.realtime?.state
    ? (s.realtime.state as { connected?: boolean })?.connected !== false
    : true;
  if (!connected) return "disconnected";
  return "idle";
}

function elapsed(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

const MODE_LABELS: Record<string, string> = {
  voice_agent: "Voice Agent",
  openai: "OpenAI",
  gemini: "Gemini",
  xai: "xAI",
  stt_pipeline: "STT Pipeline"
};

const STATE_LABELS: Record<string, string> = {
  processing: "Processing",
  listening: "Listening",
  idle: "Idle",
  disconnected: "Disconnected"
};

function snippet(text?: string, max = 120): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "..." : text;
}

// ---- Session Card ----

function SessionCard({ session }: { session: VoiceSession }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const state = deriveBotState(session);
  const pendingTurns = (session.stt?.pendingTurns || 0) + (session.realtime?.pendingTurns || 0);

  return (
    <div className="vm-card panel">
      <div className="vm-card-header">
        <span className={`vm-mode-badge vm-mode-${session.mode}`}>
          {MODE_LABELS[session.mode] || session.mode}
        </span>
        <span className={`vm-state-dot vm-state-${state}`} title={STATE_LABELS[state]} />
        <span className="vm-state-label">{STATE_LABELS[state]}</span>
      </div>
      <div className="vm-card-body">
        <div className="vm-stat">
          <span className="vm-stat-label">Duration</span>
          <span className="vm-stat-value">{elapsed(session.startedAt)}</span>
        </div>
        <div className="vm-stat">
          <span className="vm-stat-label">Inputs</span>
          <span className="vm-stat-value">{session.activeInputStreams}</span>
        </div>
        <div className="vm-stat">
          <span className="vm-stat-label">Pending</span>
          <span className="vm-stat-value">{pendingTurns}</span>
        </div>
        <div className="vm-stat">
          <span className="vm-stat-label">Soundboard</span>
          <span className="vm-stat-value">{session.soundboard.playCount}</span>
        </div>
      </div>
      <div className="vm-card-footer">
        <span className="vm-card-id" title={session.guildId}>
          {session.guildId.slice(0, 8)}...
        </span>
        {session.realtime?.provider && (
          <span className="vm-card-provider">{session.realtime.provider}</span>
        )}
      </div>
    </div>
  );
}

// ---- Event Row ----

function EventRow({ event }: { event: VoiceEvent }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, []);

  const kindShort = (event.kind || "").replace(/^voice_/, "");

  return (
    <div className="vm-event-row">
      <span className="vm-event-time">{relativeTime(event.createdAt)}</span>
      <span className={`vm-event-badge vm-kind-${kindShort}`}>{kindShort}</span>
      <span className="vm-event-content">{snippet(event.content)}</span>
    </div>
  );
}

// ---- Main Component ----

export default function VoiceMonitor() {
  const { voiceState, events, status } = useVoiceSSE();
  const [showRuntime, setShowRuntime] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);

  const sessions = voiceState?.sessions || [];
  const filteredEvents = showRuntime
    ? events
    : events.filter((e) => e.kind !== "voice_runtime");

  return (
    <div className="vm-container">
      {/* Connection status */}
      <div className="vm-connection-bar">
        <span className={`vm-conn-dot vm-conn-${status}`} />
        <span className="vm-conn-label">
          {status === "open" ? "Live" : status === "connecting" ? "Connecting..." : "Disconnected"}
        </span>
        {voiceState && (
          <span className="vm-conn-count">
            {voiceState.activeCount} active session{voiceState.activeCount !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Session cards */}
      <section className="vm-sessions">
        {sessions.length === 0 ? (
          <p className="vm-empty">No active voice sessions</p>
        ) : (
          <div className="vm-card-grid">
            {sessions.map((s) => (
              <SessionCard key={s.sessionId} session={s} />
            ))}
          </div>
        )}
      </section>

      {/* Event timeline */}
      <section className="vm-timeline panel">
        <div className="vm-timeline-header">
          <h3>Event Timeline</h3>
          <label className="vm-runtime-toggle">
            <input
              type="checkbox"
              checked={showRuntime}
              onChange={(e) => setShowRuntime(e.target.checked)}
            />
            Show runtime
          </label>
        </div>
        <div className="vm-timeline-feed" ref={timelineRef}>
          {filteredEvents.length === 0 ? (
            <p className="vm-empty">No voice events yet</p>
          ) : (
            filteredEvents.map((e, i) => <EventRow key={`${e.createdAt}-${i}`} event={e} />)
          )}
        </div>
      </section>
    </div>
  );
}
