import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../api";
import { GuildSelectField } from "./MemoryFormFields";
import { PanelHead } from "../ui";

interface Guild {
  id: string;
  name: string;
}

interface AdaptiveDirective {
  id: number;
  directiveKind: string;
  noteText: string;
  createdAt: string;
  updatedAt: string;
  createdByName: string | null;
  updatedByName: string | null;
  removalReason: string | null;
}

interface AdaptiveDirectiveAuditEvent {
  id: number;
  noteId: number | null;
  createdAt: string;
  directiveKind: string;
  eventType: string;
  actorName: string | null;
  noteText: string;
  detailText: string | null;
}

interface Props {
  guilds: Guild[];
}

type StatusState = {
  text: string;
  tone: "error" | "info";
} | null;

function formatTimestamp(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return "unknown time";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleString();
}

function formatAuditLabel(eventType: string) {
  const normalized = String(eventType || "").trim().toLowerCase();
  if (normalized === "added") return "Added";
  if (normalized === "reactivated") return "Reactivated";
  if (normalized === "edited") return "Edited";
  if (normalized === "removed") return "Removed";
  return normalized || "Event";
}

export default function MemoryAdaptiveDirectives({ guilds }: Props) {
  const [guildId, setGuildId] = useState("");
  const [notes, setNotes] = useState<AdaptiveDirective[]>([]);
  const [auditEvents, setAuditEvents] = useState<AdaptiveDirectiveAuditEvent[]>([]);
  const [draftNote, setDraftNote] = useState("");
  const [draftKind, setDraftKind] = useState("guidance");
  const [kindsById, setKindsById] = useState<Record<number, string>>({});
  const [draftsById, setDraftsById] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [status, setStatus] = useState<StatusState>(null);

  useEffect(() => {
    if (!guildId && guilds.length > 0) {
      setGuildId(guilds[0].id);
    }
  }, [guildId, guilds]);

  useEffect(() => {
    if (!guildId) {
      setNotes([]);
      setAuditEvents([]);
      setDraftsById({});
      return;
    }
    let cancelled = false;
    setLoading(true);
    setStatus(null);
    Promise.all([
      api<{ notes?: AdaptiveDirective[] }>(`/api/memory/adaptive-directives?guildId=${encodeURIComponent(guildId)}&limit=50`),
      api<{ events?: AdaptiveDirectiveAuditEvent[] }>(
        `/api/memory/adaptive-directives/audit?guildId=${encodeURIComponent(guildId)}&limit=120`
      )
    ])
      .then(([notesResponse, auditResponse]) => {
        if (cancelled) return;
        const nextNotes = Array.isArray(notesResponse.notes) ? notesResponse.notes : [];
        setNotes(nextNotes);
        setAuditEvents(Array.isArray(auditResponse.events) ? auditResponse.events : []);
        setKindsById(
          Object.fromEntries(nextNotes.map((note) => [note.id, note.directiveKind || "guidance"]))
        );
        setDraftsById(
          Object.fromEntries(nextNotes.map((note) => [note.id, note.noteText]))
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setStatus({
          text: error instanceof Error ? error.message : String(error),
          tone: "error"
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [guildId]);

  const reload = async () => {
    if (!guildId) return;
    const [notesResponse, auditResponse] = await Promise.all([
      api<{ notes?: AdaptiveDirective[] }>(`/api/memory/adaptive-directives?guildId=${encodeURIComponent(guildId)}&limit=50`),
      api<{ events?: AdaptiveDirectiveAuditEvent[] }>(
        `/api/memory/adaptive-directives/audit?guildId=${encodeURIComponent(guildId)}&limit=120`
      )
    ]);
    const nextNotes = Array.isArray(notesResponse.notes) ? notesResponse.notes : [];
    setNotes(nextNotes);
    setAuditEvents(Array.isArray(auditResponse.events) ? auditResponse.events : []);
    setKindsById(
      Object.fromEntries(nextNotes.map((note) => [note.id, note.directiveKind || "guidance"]))
    );
    setDraftsById(
      Object.fromEntries(nextNotes.map((note) => [note.id, note.noteText]))
    );
  };

  const handleAdd = async (event: FormEvent) => {
    event.preventDefault();
    if (!guildId || !draftNote.trim()) return;
    setSavingId(-1);
    setStatus(null);
    try {
      const result = await api<{ status?: string; note?: AdaptiveDirective }>("/api/memory/adaptive-directives", {
        method: "POST",
        body: {
          guildId,
          directiveKind: draftKind,
          noteText: draftNote.trim()
        }
      });
      setDraftNote("");
      await reload();
      const statusLabel = String(result.status || "saved");
      setStatus({
        text:
          statusLabel === "duplicate_active"
            ? "That adaptive directive is already active."
            : statusLabel === "reactivated"
              ? "Adaptive directive reactivated."
              : "Adaptive directive saved.",
        tone: "info"
      });
    } catch (error: unknown) {
      setStatus({
        text: error instanceof Error ? error.message : String(error),
        tone: "error"
      });
    } finally {
      setSavingId(null);
    }
  };

  const handleSaveEdit = async (noteId: number) => {
    const nextText = String(draftsById[noteId] || "").trim();
    const nextKind = String(kindsById[noteId] || "guidance").trim() || "guidance";
    if (!guildId || !nextText) return;
    setSavingId(noteId);
    setStatus(null);
    try {
      const result = await api<{ status?: string }>(`/api/memory/adaptive-directives/${encodeURIComponent(String(noteId))}`, {
        method: "PATCH",
        body: {
          guildId,
          directiveKind: nextKind,
          noteText: nextText
        }
      });
      await reload();
      setStatus({
        text:
          String(result.status || "") === "duplicate_active"
            ? "That directive already exists as another active adaptive directive."
            : "Adaptive directive updated.",
        tone: "info"
      });
    } catch (error: unknown) {
      setStatus({
        text: error instanceof Error ? error.message : String(error),
        tone: "error"
      });
    } finally {
      setSavingId(null);
    }
  };

  const handleRemove = async (noteId: number) => {
    if (!guildId) return;
    setRemovingId(noteId);
    setStatus(null);
    try {
      await api(`/api/memory/adaptive-directives/${encodeURIComponent(String(noteId))}/remove`, {
        method: "POST",
        body: {
          guildId
        }
      });
      await reload();
      setStatus({
        text: "Adaptive directive removed.",
        tone: "info"
      });
    } catch (error: unknown) {
      setStatus({
        text: error instanceof Error ? error.message : String(error),
        tone: "error"
      });
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="memory-style-layout">
      <PanelHead title="Adaptive Directives" />
      <p className="memory-reflection-copy">
        These are persistent server-level directives that shape how the bot talks and acts across text and voice.
        Use `guidance` for style, tone, persona, or operating guidance, and `behavior` for recurring trigger/action instructions like GIFs or targeted callouts.
      </p>
      <form className="memory-form" onSubmit={handleAdd}>
        <div className="memory-form-row">
          <GuildSelectField guilds={guilds} guildId={guildId} onGuildChange={setGuildId} />
          <label>
            Kind
            <select value={draftKind} onChange={(e) => setDraftKind(e.target.value)}>
              <option value="guidance">Guidance</option>
              <option value="behavior">Behavior</option>
            </select>
          </label>
        </div>
        <label>
          New adaptive directive
          <textarea
            className="memory-style-textarea"
            value={draftNote}
            onChange={(e) => setDraftNote(e.target.value)}
            placeholder="Examples: Use “type shit” occasionally in casual replies. Or: Send a GIF to Tiny Conk whenever they say “what the heli.”"
            rows={3}
          />
        </label>
        <div className="memory-form-action">
          <button type="submit" className="cta" disabled={!guildId || !draftNote.trim() || savingId === -1}>
            {savingId === -1 ? "Saving..." : "Add Directive"}
          </button>
        </div>
      </form>
      {status && (
        <p className={`memory-reflection-inline-status${status.tone === "error" ? " error" : ""}`} role="status">
          {status.text}
        </p>
      )}
      <div className="memory-style-sections">
        <section className="memory-style-section">
          <div className="memory-style-section-head">
            <h4>Active Directives</h4>
            <span className="memory-result-count">
              {loading ? "Loading..." : `${notes.length} active`}
            </span>
          </div>
          {notes.length === 0 ? (
            <p className="memory-result-count">No adaptive directives saved for this server.</p>
          ) : (
            <div className="memory-style-note-list">
              {notes.map((note) => {
                const draftValue = draftsById[note.id] ?? note.noteText;
                const draftKindValue = kindsById[note.id] ?? note.directiveKind ?? "guidance";
                const changed =
                  draftValue.trim() !== note.noteText.trim() ||
                  draftKindValue !== (note.directiveKind || "guidance");
                return (
                  <article key={note.id} className="memory-style-note-card">
                    <div className="memory-style-note-meta">
                      <strong>[S{note.id}]</strong>
                      <span>{draftKindValue}</span>
                      <span>Added by {note.createdByName || "unknown"} · {formatTimestamp(note.createdAt)}</span>
                      <span>Last updated by {note.updatedByName || note.createdByName || "unknown"} · {formatTimestamp(note.updatedAt)}</span>
                    </div>
                    <label>
                      Kind
                      <select
                        value={draftKindValue}
                        onChange={(e) =>
                          setKindsById((current) => ({
                            ...current,
                            [note.id]: e.target.value
                          }))
                        }
                      >
                        <option value="guidance">Guidance</option>
                        <option value="behavior">Behavior</option>
                      </select>
                    </label>
                    <textarea
                      className="memory-style-textarea"
                      value={draftValue}
                      onChange={(e) =>
                        setDraftsById((current) => ({
                          ...current,
                          [note.id]: e.target.value
                        }))
                      }
                      rows={3}
                    />
                    <div className="memory-style-note-actions">
                      <button
                        type="button"
                        className="cta"
                        disabled={!changed || savingId === note.id}
                        onClick={() => handleSaveEdit(note.id)}
                      >
                        {savingId === note.id ? "Saving..." : "Save"}
                      </button>
                      <button
                        type="button"
                        disabled={removingId === note.id}
                        onClick={() => handleRemove(note.id)}
                      >
                        {removingId === note.id ? "Removing..." : "Remove"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
        <section className="memory-style-section">
          <div className="memory-style-section-head">
            <h4>Audit Log</h4>
            <span className="memory-result-count">{auditEvents.length} events</span>
          </div>
          {auditEvents.length === 0 ? (
            <p className="memory-result-count">No adaptive directive activity yet.</p>
          ) : (
            <div className="memory-style-audit-list">
              {auditEvents.map((event) => (
                <article key={event.id} className="memory-style-audit-card">
                  <div className="memory-style-audit-meta">
                    <strong>{formatAuditLabel(event.eventType)}</strong>
                    <span>{event.directiveKind}</span>
                    <span>
                      {event.actorName || "unknown"} · {formatTimestamp(event.createdAt)}
                      {event.noteId ? ` · [S${event.noteId}]` : ""}
                    </span>
                  </div>
                  <p className="memory-style-audit-text">{event.noteText}</p>
                  {event.detailText ? (
                    <p className="memory-style-audit-detail">{event.detailText}</p>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
