import { useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import { api } from "../api";
import {
  useVoiceSSE,
  type VoiceSession,
  type VoiceEvent,
  type RealtimeState,
  type VoiceMembershipEvent
} from "../hooks/useVoiceSSE";
import { useVoiceHistory } from "../hooks/useVoiceHistory";

// ---- helpers ----

function deriveBotState(s: VoiceSession): "processing" | "speaking" | "listening" | "idle" | "disconnected" {
  const pendingTurns = (s.stt?.pendingTurns || 0) + (s.realtime?.pendingTurns || 0);
  if (s.botTurnOpen) return "speaking";
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

function timeUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const MODE_LABELS: Record<string, string> = {
  voice_agent: "Voice Agent",
  openai: "OpenAI",
  openai_realtime: "OpenAI RT",
  gemini: "Gemini",
  gemini_realtime: "Gemini RT",
  elevenlabs: "ElevenLabs",
  elevenlabs_realtime: "ElevenLabs RT",
  xai: "xAI",
  xai_realtime: "xAI RT",
  stt_pipeline: "STT Pipeline"
};

const STATE_LABELS: Record<string, string> = {
  speaking: "Speaking",
  processing: "Processing",
  listening: "Listening",
  idle: "Idle",
  disconnected: "Disconnected"
};

const WAKE_WINDOW_FALLBACK_MS = 35_000;
const JOIN_WINDOW_FALLBACK_MS = 25_000;
const DEFAULT_JOIN_TEXT_CHANNEL_ID = "1475944808198574205";

function parseIsoMs(iso?: string | null): number | null {
  const normalized = String(iso || "").trim();
  if (!normalized) return null;
  const parsed = new Date(normalized).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDurationMs(ms: number | null): string {
  if (!Number.isFinite(ms)) return "unknown";
  const normalized = Math.max(0, Math.round(Number(ms)));
  const seconds = Math.ceil(normalized / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatApproxBytes(bytes: number | null | undefined): string {
  const normalized = Math.max(0, Number(bytes) || 0);
  if (normalized < 1024) return `${normalized} B`;
  if (normalized < 1024 * 1024) return `${(normalized / 1024).toFixed(1)} KB`;
  return `${(normalized / (1024 * 1024)).toFixed(2)} MB`;
}

function resolveWakeIndicator(session: VoiceSession): {
  active: boolean;
  stateLabel: "Awake" | "Listening";
} {
  const wake = session.conversation?.wake || null;
  if (wake && typeof wake === "object") {
    const active = Boolean(wake.active);
    return {
      active,
      stateLabel: active ? "Awake" : "Listening"
    };
  }

  const now = Date.now();
  const lastAssistantReplyAtMs = parseIsoMs(session.conversation?.lastAssistantReplyAt);
  const lastDirectAddressAtMs = parseIsoMs(session.conversation?.lastDirectAddressAt);
  const msSinceAssistantReply = lastAssistantReplyAtMs != null ? Math.max(0, now - lastAssistantReplyAtMs) : null;
  const msSinceDirectAddress = lastDirectAddressAtMs != null ? Math.max(0, now - lastDirectAddressAtMs) : null;
  const active =
    Boolean(session.focusedSpeaker) ||
    (msSinceAssistantReply != null && msSinceAssistantReply <= WAKE_WINDOW_FALLBACK_MS) ||
    (msSinceDirectAddress != null && msSinceDirectAddress <= WAKE_WINDOW_FALLBACK_MS);
  return {
    active,
    stateLabel: active ? "Awake" : "Listening"
  };
}

function resolveJoinWindowIndicator(session: VoiceSession): {
  active: boolean;
  remainingMs: number | null;
} {
  const joinWindow = session.conversation?.joinWindow || null;
  if (joinWindow && typeof joinWindow === "object") {
    const windowMs = Number.isFinite(joinWindow.windowMs)
      ? Math.max(0, Math.round(joinWindow.windowMs))
      : JOIN_WINDOW_FALLBACK_MS;
    const ageMs = Number.isFinite(joinWindow.ageMs) ? Math.max(0, Math.round(joinWindow.ageMs)) : null;
    return {
      active: Boolean(joinWindow.active),
      remainingMs: ageMs == null ? null : Math.max(0, windowMs - ageMs)
    };
  }

  const deciderJoinWindow = session.conversation?.modelContext?.decider?.joinWindowActive;
  if (typeof deciderJoinWindow === "boolean") {
    return {
      active: deciderJoinWindow,
      remainingMs: null
    };
  }

  const startedAtMs = parseIsoMs(session.startedAt);
  if (startedAtMs == null) {
    return {
      active: false,
      remainingMs: null
    };
  }
  const ageMs = Math.max(0, Date.now() - startedAtMs);
  return {
    active: ageMs <= JOIN_WINDOW_FALLBACK_MS,
    remainingMs: Math.max(0, JOIN_WINDOW_FALLBACK_MS - ageMs)
  };
}

function snippet(text?: string, max = 120): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "..." : text;
}

function resolveCaptureTargetName(capture: { userId: string; displayName: string | null }): string {
  const displayName = String(capture?.displayName || "").trim();
  if (displayName) return displayName;
  const userId = String(capture?.userId || "").trim();
  return userId ? userId.slice(0, 8) : "unknown";
}

type Guild = {
  id: string;
  name: string;
};

type VoiceJoinResponse = {
  ok: boolean;
  reason: string;
  guildId: string | null;
  voiceChannelId: string | null;
  textChannelId: string | null;
  requesterUserId: string | null;
};

function resolveVoiceJoinStatusMessage(result: VoiceJoinResponse): {
  text: string;
  type: "ok" | "error";
} {
  if (result.ok) {
    if (result.reason === "already_in_channel") {
      return {
        type: "ok",
        text: "Already in the target voice channel."
      };
    }
    return {
      type: "ok",
      text: "Voice join completed."
    };
  }

  if (result.reason === "no_guild_available") {
    return {
      type: "error",
      text: "No guild is available for voice join."
    };
  }
  if (result.reason === "guild_not_found") {
    return {
      type: "error",
      text: "The selected guild was not found."
    };
  }
  if (result.reason === "requester_not_in_voice") {
    return {
      type: "error",
      text: "No matching requester is currently in voice."
    };
  }
  if (result.reason === "requester_is_bot") {
    return {
      type: "error",
      text: "Requester must be a non-bot user in voice."
    };
  }
  if (result.reason === "no_voice_members_found") {
    return {
      type: "error",
      text: "No non-bot members are currently in voice."
    };
  }
  if (result.reason === "text_channel_unavailable") {
    return {
      type: "error",
      text: "No writable text channel was found for voice operations."
    };
  }
  if (result.reason === "join_not_handled" || result.reason === "voice_join_unconfirmed") {
    return {
      type: "error",
      text: "Voice join was requested but did not complete."
    };
  }

  return {
    type: "error",
    text: "Voice join failed."
  };
}

// ---- Collapsible Section ----

function Section({
  title,
  badge,
  defaultOpen = true,
  children
}: {
  title: string;
  badge?: string | number | null;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`vm-section ${open ? "vm-section-open" : ""}`}>
      <button className="vm-section-toggle" onClick={() => setOpen(!open)}>
        <span className="vm-section-arrow">{open ? "\u25BE" : "\u25B8"}</span>
        <span className="vm-section-title">{title}</span>
        {badge != null && <span className="vm-section-badge">{badge}</span>}
      </button>
      {open && <div className="vm-section-body">{children}</div>}
    </div>
  );
}

// ---- Stat Pill ----

function Stat({ label, value, warn }: { label: string; value: ReactNode; warn?: boolean }) {
  return (
    <div className={`vm-stat ${warn ? "vm-stat-warn" : ""}`}>
      <span className="vm-stat-label">{label}</span>
      <span className="vm-stat-value">{value}</span>
    </div>
  );
}

// ---- Pipeline Badge ----

function PipelineBadge({ session }: { session: VoiceSession }) {
  const rt = session.realtime;
  const stt = session.stt;
  const context = session.conversation?.modelContext;
  const generationContext = context?.generation;
  const trackedTurns = Number(context?.trackedTurns || 0);
  const sentTurns = Number(generationContext?.sentTurns || 0);
  const hasContextCoverage = trackedTurns > 0;

  if (rt) {
    const state = rt.state as RealtimeState | null;
    const connected = state?.connected !== false;
    return (
      <div className="vm-pipeline-row">
        <span className={`vm-pipe-dot ${connected ? "vm-pipe-ok" : "vm-pipe-err"}`} />
        <span className="vm-pipe-label">{rt.provider}</span>
        <span className="vm-pipe-detail">
          {rt.inputSampleRateHz / 1000}kHz in / {rt.outputSampleRateHz / 1000}kHz out
        </span>
        {hasContextCoverage && (
          <span className="vm-pipe-detail">
            ctx {sentTurns}/{trackedTurns}
          </span>
        )}
        {rt.drainActive && <span className="vm-pipe-tag vm-pipe-draining">draining</span>}
        {state?.activeResponseId && (
          <span className="vm-pipe-tag vm-pipe-responding">responding</span>
        )}
      </div>
    );
  }

  if (stt) {
    return (
      <div className="vm-pipeline-row">
        <span className="vm-pipe-dot vm-pipe-ok" />
        <span className="vm-pipe-label">STT Pipeline</span>
        <span className="vm-pipe-detail">
          ctx {sentTurns}/{Math.max(trackedTurns, Number(stt.contextMessages || 0))}
        </span>
      </div>
    );
  }

  return null;
}

// ---- Realtime Connection Detail ----

function RealtimeDetail({ session }: { session: VoiceSession }) {
  const rt = session.realtime;
  if (!rt) return null;
  const state = rt.state as RealtimeState | null;
  if (!state) return null;

  return (
    <Section title="Realtime Connection" badge={state.connected ? "connected" : "disconnected"}>
      <div className="vm-detail-grid">
        <Stat
          label="Superseded"
          value={Number(rt.replySuperseded || 0)}
          warn={Number(rt.replySuperseded || 0) > 0}
        />
        {state.sessionId && <Stat label="Session" value={state.sessionId.slice(0, 12) + "..."} />}
        {state.connectedAt && <Stat label="Connected" value={relativeTime(state.connectedAt)} />}
        {state.lastEventAt && <Stat label="Last Event" value={relativeTime(state.lastEventAt)} />}
        {state.lastOutboundEventType && (
          <Stat label="Last Sent" value={state.lastOutboundEventType} />
        )}
        {state.lastOutboundEventAt && (
          <Stat label="Sent At" value={relativeTime(state.lastOutboundEventAt)} />
        )}
        {state.activeResponseId && (
          <Stat label="Active Response" value={state.activeResponseId.slice(0, 12) + "..."} />
        )}
        {state.activeResponseStatus && (
          <Stat label="Response Status" value={state.activeResponseStatus} />
        )}
        {state.lastError && <Stat label="Last Error" value={state.lastError} warn />}
        {state.lastCloseCode != null && (
          <Stat label="Close Code" value={`${state.lastCloseCode} ${state.lastCloseReason || ""}`} warn />
        )}
      </div>
      {state.recentOutboundEvents && state.recentOutboundEvents.length > 0 && (
        <div className="vm-outbound-events">
          <span className="vm-mini-label">Recent outbound</span>
          {state.recentOutboundEvents.map((evt, i) => (
            <div key={i} className="vm-outbound-row">
              <span className="vm-outbound-type">{evt.type}</span>
              <span className="vm-outbound-time">{relativeTime(evt.at)}</span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// ---- Participants ----

function ParticipantList({ session }: { session: VoiceSession }) {
  const ps = session.participants || [];
  if (ps.length === 0) return null;

  return (
    <Section title="Participants" badge={session.participantCount}>
      <div className="vm-participant-list">
        {ps.map((p) => (
          <div
            key={p.userId}
            className={`vm-participant ${
              session.focusedSpeaker?.userId === p.userId ? "vm-participant-focused" : ""
            }`}
          >
            <span className="vm-participant-name">{p.displayName}</span>
            {session.focusedSpeaker?.userId === p.userId && (
              <span className="vm-participant-tag">focused</span>
            )}
            <span className="vm-participant-id">{p.userId.slice(0, 6)}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ---- Membership Changes ----

function MembershipChanges({ session }: { session: VoiceSession }) {
  const allEvents = Array.isArray(session.membershipEvents) ? session.membershipEvents : [];
  const events = allEvents.slice(-8).reverse();
  if (events.length === 0) return null;

  return (
    <Section title="Membership Changes" badge={allEvents.length} defaultOpen={false}>
      <div className="vm-membership-list">
        {events.map((entry: VoiceMembershipEvent, index) => {
          const eventType = String(entry.eventType || "").toLowerCase() === "join" ? "join" : "leave";
          return (
            <div key={`${entry.userId}-${entry.at}-${index}`} className="vm-membership-row">
              <span
                className={`vm-membership-type ${
                  eventType === "join" ? "vm-membership-join" : "vm-membership-leave"
                }`}
              >
                {eventType}
              </span>
              <span className="vm-membership-name">
                {entry.displayName || entry.userId.slice(0, 8)}
              </span>
              <span className="vm-membership-time">{relativeTime(entry.at)}</span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ---- Conversation Context ----

function ConversationContext({ session }: { session: VoiceSession }) {
  const turns = session.recentTurns || [];
  const modelContext = session.conversation?.modelContext || null;
  const generation = modelContext?.generation || null;
  const decider = modelContext?.decider || null;
  const trackedTurns = Number(modelContext?.trackedTurns || 0);
  const trackedTurnLimit = Number(modelContext?.trackedTurnLimit || 0);
  const trackedTranscriptTurns = Number(modelContext?.trackedTranscriptTurns || turns.length);
  const generationAvailableTurns = Number(generation?.availableTurns || trackedTurns);
  const generationSentTurns = Number(generation?.sentTurns || 0);
  const generationMaxTurns = Number(generation?.maxTurns || 0);
  const deciderAvailableTurns = Number(decider?.availableTurns || trackedTurns);
  const deciderMaxTurns = Number(decider?.maxTurns || 0);
  const deciderSentTurns = Math.min(deciderAvailableTurns, deciderMaxTurns || deciderAvailableTurns);
  const wakeIndicator = resolveWakeIndicator(session);
  const joinWindowIndicator = resolveJoinWindowIndicator(session);
  const joinWindowSummary = joinWindowIndicator.active
    ? joinWindowIndicator.remainingMs != null
      ? `${formatDurationMs(joinWindowIndicator.remainingMs)} left`
      : "active"
    : "closed";
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, []);

  if (turns.length === 0) return null;

  return (
    <Section title="Conversation" badge={turns.length}>
      <div className="vm-convo-context-summary">
        <div className="vm-convo-context-row">
          <span>Generation context</span>
          <span>
            {generationSentTurns}/{generationAvailableTurns || 0}
            {generationMaxTurns > 0 ? ` (max ${generationMaxTurns})` : ""}
          </span>
        </div>
        <div className="vm-convo-context-row">
          <span>Decider context</span>
          <span>
            {deciderSentTurns}/{deciderAvailableTurns || 0}
            {deciderMaxTurns > 0 ? ` (max ${deciderMaxTurns})` : ""}
          </span>
        </div>
        <div className="vm-convo-context-row">
          <span>Tracked turns</span>
          <span>
            {trackedTurns}
            {trackedTurnLimit > 0 ? ` (limit ${trackedTurnLimit})` : ""}
          </span>
        </div>
        <div className="vm-convo-context-row">
          <span>Transcript log turns</span>
          <span>{trackedTranscriptTurns}</span>
        </div>
        <div className="vm-convo-context-row">
          <span>Wake mode</span>
          <span>{wakeIndicator.stateLabel}</span>
        </div>
        <div className="vm-convo-context-row">
          <span>Join window</span>
          <span>{joinWindowSummary}</span>
        </div>
      </div>
      <div className="vm-convo-feed">
        {turns.map((t, i) => (
          <div key={i} className={`vm-convo-msg vm-convo-${t.role}`}>
            <div className="vm-convo-meta">
              <span className={`vm-convo-role vm-convo-role-${t.role}`}>
                {t.role === "assistant" ? "bot" : t.speakerName || t.role}
              </span>
              {t.at && <span className="vm-convo-time">{relativeTime(t.at)}</span>}
            </div>
            <div className="vm-convo-text">{t.text || "(empty)"}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ---- Stream Watch ----

function StreamWatchDetail({ session }: { session: VoiceSession }) {
  const sw = session.streamWatch;
  const visualFeed = Array.isArray(sw.visualFeed) ? sw.visualFeed : [];
  const brainContextPayload = sw.brainContextPayload;
  const hasBrainPayloadNotes = Boolean(
    brainContextPayload &&
      Array.isArray(brainContextPayload.notes) &&
      brainContextPayload.notes.length > 0
  );
  const hasAnyStreamWatchData =
    Boolean(sw.active) ||
    Number(sw.ingestedFrameCount || 0) > 0 ||
    visualFeed.length > 0 ||
    hasBrainPayloadNotes;
  if (!hasAnyStreamWatchData) return null;

  return (
    <Section title="Stream Watch" badge={sw.active ? "active" : "idle"}>
      <div className="vm-detail-grid">
        <Stat label="Target" value={sw.targetUserId?.slice(0, 8) || "none"} />
        <Stat label="Frames" value={sw.ingestedFrameCount} />
        <Stat label="Window Frames" value={Number(sw.acceptedFrameCountInWindow || 0)} />
        {sw.frameWindowStartedAt && <Stat label="Window Started" value={relativeTime(sw.frameWindowStartedAt)} />}
        {sw.lastFrameAt && <Stat label="Last Frame" value={relativeTime(sw.lastFrameAt)} />}
        {sw.latestFrameAt && <Stat label="Latest Frame" value={relativeTime(sw.latestFrameAt)} />}
        {sw.latestFrameMimeType && <Stat label="Frame Mime" value={sw.latestFrameMimeType} />}
        {Number(sw.latestFrameApproxBytes || 0) > 0 && (
          <Stat label="Frame Size" value={formatApproxBytes(sw.latestFrameApproxBytes)} />
        )}
        {sw.lastCommentaryAt && <Stat label="Last Commentary" value={relativeTime(sw.lastCommentaryAt)} />}
        {sw.lastBrainContextAt && <Stat label="Last Brain Note" value={relativeTime(sw.lastBrainContextAt)} />}
        <Stat label="Brain Notes" value={Number(sw.brainContextCount || visualFeed.length)} />
        {(sw.lastBrainContextProvider || sw.lastBrainContextModel) && (
          <Stat
            label="Brain Model"
            value={[sw.lastBrainContextProvider, sw.lastBrainContextModel].filter(Boolean).join(" / ")}
          />
        )}
      </div>

      {visualFeed.length > 0 && (
        <>
          <span className="vm-mini-label">Raw Visual Analysis Feed</span>
          <div className="vm-convo-feed">
            {visualFeed.slice(-10).reverse().map((entry, index) => (
              <div key={`${entry.at || "na"}-${index}`} className="vm-convo-msg vm-convo-user">
                <div className="vm-convo-meta">
                  <span className="vm-convo-role vm-convo-role-user">
                    {entry.speakerName || "visual"}
                  </span>
                  {(entry.provider || entry.model) && (
                    <span className="vm-convo-time">
                      {[entry.provider, entry.model].filter(Boolean).join(" / ")}
                    </span>
                  )}
                  {entry.at && <span className="vm-convo-time">{relativeTime(entry.at)}</span>}
                </div>
                <div className="vm-convo-text">{entry.text}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {brainContextPayload && (
        <>
          <span className="vm-mini-label">Brain Context Payload</span>
          <div className="vm-convo-context-summary">
            <div className="vm-convo-meta">
              <span className="vm-convo-role vm-convo-role-assistant">Prompt</span>
              {brainContextPayload.lastAt && (
                <span className="vm-convo-time">{relativeTime(brainContextPayload.lastAt)}</span>
              )}
              {(brainContextPayload.provider || brainContextPayload.model) && (
                <span className="vm-convo-time">
                  {[brainContextPayload.provider, brainContextPayload.model].filter(Boolean).join(" / ")}
                </span>
              )}
            </div>
            <div className="vm-convo-text">{brainContextPayload.prompt || "(none)"}</div>
          </div>
          {Array.isArray(brainContextPayload.notes) && brainContextPayload.notes.length > 0 && (
            <div className="vm-convo-feed">
              {brainContextPayload.notes.map((note, index) => (
                <div key={`${index}-${note.slice(0, 18)}`} className="vm-convo-msg vm-convo-assistant">
                  <div className="vm-convo-text">{note}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

// ---- Expanded Session Card ----

function SessionCard({ session }: { session: VoiceSession }) {
  const [, setTick] = useState(0);
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const state = deriveBotState(session);
  const pendingTurns = (session.stt?.pendingTurns || 0) + (session.realtime?.pendingTurns || 0);
  const totalPending = pendingTurns + session.pendingDeferredTurns;
  const wakeIndicator = resolveWakeIndicator(session);
  const joinWindowIndicator = resolveJoinWindowIndicator(session);
  const joinWindowPill = joinWindowIndicator.active
    ? joinWindowIndicator.remainingMs != null
      ? `${formatDurationMs(joinWindowIndicator.remainingMs)} left`
      : "Active"
    : "Closed";
  const activeCaptures = Array.isArray(session.activeCaptures) ? session.activeCaptures : [];
  const transcribingSummary = activeCaptures.length > 0
    ? activeCaptures
        .slice(0, 3)
        .map((capture) => resolveCaptureTargetName(capture))
        .join(", ")
    : "";
  const transcribingSummaryWithOverflow =
    activeCaptures.length <= 3
      ? transcribingSummary
      : `${transcribingSummary} +${activeCaptures.length - 3}`;

  return (
    <div className={`vm-card panel vm-card-${state}`}>
      {/* Header */}
      <div className="vm-card-header" onClick={() => setExpanded(!expanded)}>
        <span className={`vm-mode-badge vm-mode-${session.mode}`}>
          {MODE_LABELS[session.mode] || session.mode}
        </span>
        <span className={`vm-state-dot vm-state-${state}`} title={STATE_LABELS[state]} />
        <span className="vm-state-label">{STATE_LABELS[state]}</span>
        <span className="vm-card-expand">{expanded ? "\u25B4" : "\u25BE"}</span>
      </div>

      {/* Quick stats row - always visible */}
      <div className="vm-card-quick">
        <Stat label="Duration" value={elapsed(session.startedAt)} />
        <Stat label="Humans" value={session.participantCount} />
        <Stat label="Inputs" value={session.activeInputStreams} />
        <Stat label="Pending" value={totalPending} warn={totalPending > 2} />
        {session.realtime && (
          <Stat
            label="Superseded"
            value={Number(session.realtime.replySuperseded || 0)}
            warn={Number(session.realtime.replySuperseded || 0) > 0}
          />
        )}
        <Stat label="Lookups" value={session.voiceLookupBusyCount} warn={session.voiceLookupBusyCount > 0} />
        <Stat label="Soundboard" value={session.soundboard.playCount} />
      </div>

      {/* Pipeline bar */}
      <PipelineBadge session={session} />

      {/* Turn state indicators */}
      <div className="vm-turn-state">
        <span
          className={`vm-ts-pill ${
            wakeIndicator.active ? "vm-ts-wake-awake" : "vm-ts-wake-listening"
          }`}
        >
          Wake: {wakeIndicator.stateLabel}
        </span>
        <span
          className={`vm-ts-pill ${
            joinWindowIndicator.active ? "vm-ts-join-active" : "vm-ts-join-inactive"
          }`}
        >
          Join: {joinWindowPill}
        </span>
        {session.botTurnOpen && <span className="vm-ts-pill vm-ts-speaking">Bot Speaking</span>}
        {session.activeInputStreams > 0 && (
          <span className="vm-ts-pill vm-ts-capturing">
            Transcribing: {transcribingSummaryWithOverflow || `${session.activeInputStreams} capture(s)`}
          </span>
        )}
        {session.realtime?.drainActive && (
          <span className="vm-ts-pill vm-ts-draining">Turn Draining</span>
        )}
        {session.pendingDeferredTurns > 0 && (
          <span className="vm-ts-pill vm-ts-deferred">
            {session.pendingDeferredTurns} Deferred
          </span>
        )}
        {session.voiceLookupBusyCount > 0 && (
          <span className="vm-ts-pill vm-ts-lookup">
            {session.voiceLookupBusyCount} Lookup{session.voiceLookupBusyCount !== 1 ? "s" : ""}
          </span>
        )}
        {session.focusedSpeaker && (
          <span className="vm-ts-pill vm-ts-focus">
            Focus: {session.focusedSpeaker.displayName || session.focusedSpeaker.userId.slice(0, 8)}
          </span>
        )}
      </div>

      {/* Expanded detail sections */}
      {expanded && (
        <div className="vm-card-detail">
          {/* Timers */}
          <Section title="Session Timers" defaultOpen={false}>
            <div className="vm-detail-grid">
              <Stat label="Started" value={relativeTime(session.startedAt)} />
              <Stat label="Last Activity" value={relativeTime(session.lastActivityAt)} />
              {session.maxEndsAt && <Stat label="Max Duration" value={timeUntil(session.maxEndsAt)} />}
              {session.inactivityEndsAt && (
                <Stat label="Inactivity Timeout" value={timeUntil(session.inactivityEndsAt)} warn />
              )}
              {session.soundboard.lastPlayedAt && (
                <Stat label="Last Soundboard" value={relativeTime(session.soundboard.lastPlayedAt)} />
              )}
            </div>
          </Section>

          {/* Realtime connection */}
          <RealtimeDetail session={session} />

          {/* Participants */}
          <ParticipantList session={session} />

          {activeCaptures.length > 0 && (
            <Section title="Active Transcription Targets" badge={activeCaptures.length} defaultOpen={false}>
              <div className="vm-participant-list">
                {activeCaptures.map((capture, index) => (
                  <div key={`${capture.userId}-${index}`} className="vm-participant">
                    <span className="vm-participant-name">{resolveCaptureTargetName(capture)}</span>
                    {capture.startedAt && (
                      <span className="vm-participant-tag">{relativeTime(capture.startedAt)}</span>
                    )}
                    <span className="vm-participant-id">{capture.userId.slice(0, 6)}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Membership changes */}
          <MembershipChanges session={session} />

          {/* Conversation context */}
          <ConversationContext session={session} />

          {/* Stream watch */}
          <StreamWatchDetail session={session} />
        </div>
      )}

      {/* Footer */}
      <div className="vm-card-footer">
        <span className="vm-card-id" title={session.guildId}>
          {session.guildId.slice(0, 8)}...
        </span>
        <span className="vm-card-id" title={session.voiceChannelId}>
          vc:{session.voiceChannelId.slice(0, 6)}
        </span>
        {session.realtime?.provider && (
          <span className="vm-card-provider">{session.realtime.provider}</span>
        )}
      </div>
    </div>
  );
}

// ---- Event Row ----

const EVENT_KIND_COLORS: Record<string, string> = {
  session_start: "#4ade80",
  session_end: "#f87171",
  turn_in: "#60a5fa",
  turn_out: "#bef264",
  turn_addressing: "#c084fc",
  soundboard_play: "#fb923c",
  error: "#f87171",
  runtime: "#64748b",
  intent_detected: "#22d3ee"
};

function EventRow({ event, defaultExpanded }: { event: VoiceEvent; defaultExpanded?: boolean }) {
  const [, setTick] = useState(0);
  const [expanded, setExpanded] = useState(defaultExpanded || false);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, []);

  const kindShort = (event.kind || "").replace(/^voice_/, "");
  const meta = event.metadata as Record<string, unknown> | undefined;

  return (
    <div className="vm-event-row-wrap">
      <div className="vm-event-row" onClick={() => meta && setExpanded(!expanded)}>
        <span className="vm-event-time">{relativeTime(event.createdAt)}</span>
        <span
          className="vm-event-badge"
          style={{
            background: `${EVENT_KIND_COLORS[kindShort] || "#64748b"}18`,
            color: EVENT_KIND_COLORS[kindShort] || "#64748b"
          }}
        >
          {kindShort}
        </span>
        <span className="vm-event-content">{snippet(event.content)}</span>
        {meta && <span className="vm-event-expand-hint">{expanded ? "\u25B4" : "\u22EF"}</span>}
      </div>
      {expanded && meta && (
        <div className="vm-event-meta">
          {Object.entries(meta).map(([k, v]) => (
            <div key={k} className="vm-meta-row">
              <span className="vm-meta-key">{k}</span>
              <span className="vm-meta-val">
                {typeof v === "object" ? JSON.stringify(v) : String(v ?? "")}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Event Kind Filter ----

const EVENT_KINDS = [
  "session_start", "session_end", "turn_in", "turn_out",
  "turn_addressing", "soundboard_play", "error", "runtime", "intent_detected"
];

function EventFilter({
  active,
  onToggle,
  showRuntime,
  onToggleRuntime
}: {
  active: Set<string>;
  onToggle: (kind: string) => void;
  showRuntime: boolean;
  onToggleRuntime: () => void;
}) {
  return (
    <div className="vm-event-filters">
      {EVENT_KINDS.map((kind) => {
        if (kind === "runtime" && !showRuntime) return null;
        const isActive = active.has(kind);
        return (
          <button
            key={kind}
            className={`vm-filter-chip ${isActive ? "vm-filter-active" : "vm-filter-inactive"}`}
            style={{
              borderColor: isActive ? (EVENT_KIND_COLORS[kind] || "#64748b") : undefined,
              color: isActive ? (EVENT_KIND_COLORS[kind] || "#64748b") : undefined
            }}
            onClick={() => onToggle(kind)}
          >
            {kind.replace(/_/g, " ")}
          </button>
        );
      })}
      <label className="vm-runtime-toggle">
        <input type="checkbox" checked={showRuntime} onChange={onToggleRuntime} />
        runtime
      </label>
    </div>
  );
}

// ---- Voice History Viewer ----

function HistoryTranscript({ events }: { events: VoiceEvent[] }) {
  const turns = events
    .filter((e) => {
      const meta = e.metadata as Record<string, unknown> | undefined;
      return e.kind === "voice_runtime" && meta?.transcript;
    })
    .map((e) => {
      const meta = e.metadata as Record<string, unknown>;
      return {
        role: String(meta.transcriptSource || "user"),
        text: String(meta.transcript || ""),
        at: e.createdAt
      };
    });

  if (turns.length === 0) return null;

  return (
    <Section title="Transcript" badge={turns.length} defaultOpen>
      <div className="vm-convo-feed">
        {turns.map((t, i) => (
          <div key={i} className={`vm-convo-msg vm-convo-${t.role}`}>
            <div className="vm-convo-meta">
              <span className={`vm-convo-role vm-convo-role-${t.role}`}>
                {t.role === "assistant" ? "bot" : t.role}
              </span>
              {t.at && <span className="vm-convo-time">{relativeTime(t.at)}</span>}
            </div>
            <div className="vm-convo-text">{t.text || "(empty)"}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function VoiceHistoryViewer({
  history
}: {
  history: ReturnType<typeof useVoiceHistory>;
}) {
  const { sessions, selectedSessionId, events, loading, error, toggle } = history;
  const [historyActiveKinds, setHistoryActiveKinds] = useState<Set<string>>(
    () => new Set(EVENT_KINDS.filter((k) => k !== "runtime"))
  );
  const [historyShowRuntime, setHistoryShowRuntime] = useState(false);

  if (sessions.length === 0) return null;

  const selected = sessions.find((s) => s.sessionId === selectedSessionId) || null;

  const filteredEvents = events.filter((e) => {
    const kindShort = (e.kind || "").replace(/^voice_/, "");
    if (kindShort === "runtime" && !historyShowRuntime) return false;
    return historyActiveKinds.has(kindShort);
  });

  return (
    <section className="vm-history panel">
      <h3>Past Sessions</h3>
      <div className="vm-history-picker">
        {sessions.map((s) => (
          <button
            key={s.sessionId}
            className={`vm-history-pill ${s.sessionId === selectedSessionId ? "vm-history-pill-active" : ""}`}
            onClick={() => toggle(s.sessionId)}
          >
            <span className="vm-history-pill-mode">{MODE_LABELS[s.mode] || s.mode}</span>
            <span className="vm-history-pill-time">{relativeTime(s.startedAt)}</span>
            <span className="vm-history-pill-dur">{formatDuration(s.durationSeconds)}</span>
          </button>
        ))}
      </div>

      {selectedSessionId && (
        <div className="vm-history-detail">
          {loading && <p className="vm-empty">Loading session...</p>}
          {error && <p className="vm-empty" style={{ color: "var(--danger)" }}>{error}</p>}

          {selected && !loading && (
            <>
              <div className="vm-detail-grid">
                <Stat label="Mode" value={MODE_LABELS[selected.mode] || selected.mode} />
                <Stat label="Duration" value={formatDuration(selected.durationSeconds)} />
                <Stat label="End Reason" value={selected.endReason} />
              </div>

              <HistoryTranscript events={events} />

              <Section title="Events" badge={filteredEvents.length} defaultOpen={false}>
                <EventFilter
                  active={historyActiveKinds}
                  onToggle={(kind) =>
                    setHistoryActiveKinds((prev) => {
                      const next = new Set(prev);
                      if (next.has(kind)) next.delete(kind);
                      else next.add(kind);
                      return next;
                    })
                  }
                  showRuntime={historyShowRuntime}
                  onToggleRuntime={() => setHistoryShowRuntime(!historyShowRuntime)}
                />
                <div className="vm-timeline-feed">
                  {filteredEvents.length === 0 ? (
                    <p className="vm-empty">No events</p>
                  ) : (
                    filteredEvents.map((e, i) => (
                      <EventRow key={`${e.createdAt}-${i}`} event={e} />
                    ))
                  )}
                </div>
              </Section>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ---- Main Component ----

export default function VoiceMonitor() {
  const { voiceState, events, status } = useVoiceSSE();
  const history = useVoiceHistory();
  const { refresh: refreshHistory, ingestLiveEvent } = history;
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [selectedGuildId, setSelectedGuildId] = useState("");
  const [joinTextChannelId, setJoinTextChannelId] = useState(DEFAULT_JOIN_TEXT_CHANNEL_ID);
  const [joinPending, setJoinPending] = useState(false);
  const [joinStatus, setJoinStatus] = useState<{
    text: string;
    type: "ok" | "error" | "";
  }>({
    text: "",
    type: ""
  });
  const [showRuntime, setShowRuntime] = useState(false);
  const [activeKinds, setActiveKinds] = useState<Set<string>>(
    () => new Set(EVENT_KINDS.filter((k) => k !== "runtime"))
  );
  const timelineRef = useRef<HTMLDivElement>(null);
  const prevSessionIdsRef = useRef<Set<string>>(new Set());
  const lastProcessedLiveEventKeyRef = useRef("");

  const sessions = useMemo(() => voiceState?.sessions || [], [voiceState?.sessions]);

  // Auto-refresh history when a live session disappears
  useEffect(() => {
    const currentIds = new Set(sessions.map((s) => s.sessionId));
    const prevIds = prevSessionIdsRef.current;
    if (prevIds.size > 0 && currentIds.size < prevIds.size) {
      refreshHistory();
    }
    prevSessionIdsRef.current = currentIds;
  }, [sessions, refreshHistory]);

  // Keep history panels synced with live voice events.
  useEffect(() => {
    const latestEvent = events[0];
    if (!latestEvent) return;
    const key = `${String(latestEvent.createdAt || "")}|${String(latestEvent.kind || "")}|${String(latestEvent.content || "")}`;
    if (!key || key === lastProcessedLiveEventKeyRef.current) return;
    lastProcessedLiveEventKeyRef.current = key;

    ingestLiveEvent(latestEvent);
    const normalizedKind = String(latestEvent.kind || "").trim().toLowerCase();
    if (normalizedKind === "voice_session_start" || normalizedKind === "voice_session_end") {
      refreshHistory();
    }
  }, [events, ingestLiveEvent, refreshHistory]);

  useEffect(() => {
    let cancelled = false;

    api<Guild[]>("/api/guilds")
      .then((rows) => {
        if (cancelled) return;
        const nextGuilds = Array.isArray(rows) ? rows : [];
        setGuilds(nextGuilds);
        setSelectedGuildId((current) => {
          if (current && nextGuilds.some((guild) => guild.id === current)) return current;
          return nextGuilds[0]?.id || "";
        });
      })
      .catch(() => {
        if (cancelled) return;
        setGuilds([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const toggleKind = (kind: string) => {
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const filteredEvents = events.filter((e) => {
    const kindShort = (e.kind || "").replace(/^voice_/, "");
    if (kindShort === "runtime" && !showRuntime) return false;
    return activeKinds.has(kindShort);
  });

  const requestVoiceJoin = async () => {
    setJoinPending(true);
    try {
      const payload: Record<string, string> = {
        source: "dashboard_voice_tab"
      };
      if (selectedGuildId) payload.guildId = selectedGuildId;
      const normalizedTextChannelId = joinTextChannelId.trim();
      if (normalizedTextChannelId) payload.textChannelId = normalizedTextChannelId;

      const result = await api<VoiceJoinResponse>("/api/voice/join", {
        method: "POST",
        body: payload
      });
      setJoinStatus(resolveVoiceJoinStatusMessage(result));
    } catch (error: unknown) {
      setJoinStatus({
        type: "error",
        text: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setJoinPending(false);
    }
  };

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

      <section className="vm-join panel">
        <div className="vm-join-row">
          <div className="vm-join-field">
            <label className="vm-join-label" htmlFor="vm-join-guild">Guild</label>
            <select
              id="vm-join-guild"
              value={selectedGuildId}
              onChange={(event) => setSelectedGuildId(event.target.value)}
              disabled={joinPending || guilds.length <= 1}
            >
              {guilds.length === 0 && <option value="">Auto-detect</option>}
              {guilds.map((guild) => (
                <option key={guild.id} value={guild.id}>
                  {guild.name}
                </option>
              ))}
            </select>
          </div>
          <div className="vm-join-field">
            <label className="vm-join-label" htmlFor="vm-join-source-channel">
              Summoned From Channel ID
            </label>
            <input
              id="vm-join-source-channel"
              type="text"
              value={joinTextChannelId}
              onChange={(event) => setJoinTextChannelId(event.target.value)}
              disabled={joinPending}
              placeholder={DEFAULT_JOIN_TEXT_CHANNEL_ID}
            />
          </div>
          <button type="button" onClick={requestVoiceJoin} disabled={joinPending}>
            {joinPending ? "Joining..." : "Join VC"}
          </button>
        </div>
        {joinStatus.text && (
          <p className={`vm-join-status ${joinStatus.type}`} role="status" aria-live="polite">
            {joinStatus.text}
          </p>
        )}
      </section>

      {/* Session panels */}
      <section className="vm-sessions">
        {sessions.length === 0 ? (
          <p className="vm-empty">No active voice sessions</p>
        ) : (
          <div className="vm-card-stack">
            {sessions.map((s) => (
              <SessionCard key={s.sessionId} session={s} />
            ))}
          </div>
        )}
      </section>

      {/* Past session history */}
      <VoiceHistoryViewer history={history} />

      {/* Event timeline */}
      <section className="vm-timeline panel">
        <div className="vm-timeline-header">
          <h3>Event Timeline</h3>
          <span className="vm-event-count">{filteredEvents.length} events</span>
        </div>
        <EventFilter
          active={activeKinds}
          onToggle={toggleKind}
          showRuntime={showRuntime}
          onToggleRuntime={() => setShowRuntime(!showRuntime)}
        />
        <div className="vm-timeline-feed" ref={timelineRef}>
          {filteredEvents.length === 0 ? (
            <p className="vm-empty">No voice events yet</p>
          ) : (
            filteredEvents.map((e, i) => (
              <EventRow key={`${e.createdAt}-${i}`} event={e} />
            ))
          )}
        </div>
      </section>
    </div>
  );
}
