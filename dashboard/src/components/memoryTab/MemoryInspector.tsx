import { useCallback, useDeferredValue, useEffect, useState } from "react";
import { api } from "../../api";
import { GuildSelectField } from "./MemoryFormFields";

interface Guild {
  id: string;
  name: string;
}

interface SubjectRow {
  guild_id: string;
  subject: string;
  last_seen_at: string;
  fact_count: number;
}

interface FactRow {
  id: number;
  created_at: string;
  updated_at: string;
  guild_id: string;
  channel_id: string | null;
  subject: string;
  fact: string;
  fact_type: string;
  evidence_text: string | null;
  source_message_id: string | null;
  confidence: number;
}

interface FactDraft {
  subject: string;
  factType: string;
  fact: string;
  evidenceText: string;
  confidence: string;
}

interface FactAuditEvent {
  id: number | null;
  createdAt: string | null;
  eventType: string;
  actorName: string | null;
  source: string | null;
  factId: number | null;
  subject: string | null;
  factType: string | null;
  fact: string | null;
  previousFact: string | null;
  nextFact: string | null;
  channelId: string | null;
  sourceMessageId: string | null;
  removalReason: string | null;
}

interface Props {
  guilds: Guild[];
}

type StatusState = {
  text: string;
  tone: "error" | "info";
} | null;

function timeAgo(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatTimestamp(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return "unknown time";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleString();
}

function formatAuditLabel(eventType: string) {
  const normalized = String(eventType || "").trim().toLowerCase();
  if (normalized === "removed") return "Removed";
  if (normalized === "updated") return "Edited";
  return "Added";
}

function createDraft(fact: FactRow): FactDraft {
  return {
    subject: fact.subject,
    factType: fact.fact_type,
    fact: fact.fact,
    evidenceText: fact.evidence_text || "",
    confidence: Number.isFinite(fact.confidence) ? String(fact.confidence) : "0.5"
  };
}

function hasDraftChanges(fact: FactRow, draft: FactDraft | undefined) {
  if (!draft) return false;
  const nextConfidence = Number(draft.confidence);
  return (
    draft.subject.trim() !== fact.subject.trim() ||
    draft.factType.trim() !== fact.fact_type.trim() ||
    draft.fact.trim() !== fact.fact.trim() ||
    draft.evidenceText.trim() !== String(fact.evidence_text || "").trim() ||
    !Number.isFinite(nextConfidence) ||
    Math.abs(nextConfidence - Number(fact.confidence || 0)) > 0.0001
  );
}

function buildAuditSummary(event: FactAuditEvent) {
  if (event.eventType === "updated") {
    if (event.previousFact && event.nextFact && event.previousFact !== event.nextFact) {
      return `${event.previousFact} -> ${event.nextFact}`;
    }
    return event.nextFact || event.fact || "Fact updated.";
  }
  if (event.eventType === "removed") {
    return event.previousFact || event.fact || "Fact removed.";
  }
  return event.nextFact || event.fact || "Fact added.";
}

export default function MemoryInspector({ guilds }: Props) {
  const [guildId, setGuildId] = useState("");
  const [subjects, setSubjects] = useState<SubjectRow[]>([]);
  const [selectedSubject, setSelectedSubject] = useState<string | null>(null);
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [expandedFactId, setExpandedFactId] = useState<number | null>(null);
  const [subjectFilter, setSubjectFilter] = useState("");
  const [factQuery, setFactQuery] = useState("");
  const [draftsById, setDraftsById] = useState<Record<number, FactDraft>>({});
  const [auditByFactId, setAuditByFactId] = useState<Record<number, FactAuditEvent[]>>({});
  const [loadingSubjects, setLoadingSubjects] = useState(false);
  const [loadingFacts, setLoadingFacts] = useState(false);
  const [loadingAuditFactId, setLoadingAuditFactId] = useState<number | null>(null);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [status, setStatus] = useState<StatusState>(null);
  const [factLimit, setFactLimit] = useState(120);
  const deferredFactQuery = useDeferredValue(factQuery);

  useEffect(() => {
    if (!guildId && guilds.length > 0) {
      setGuildId(guilds[0].id);
    }
  }, [guildId, guilds]);

  const loadSubjects = useCallback(async () => {
    if (!guildId) return;
    setLoadingSubjects(true);
    try {
      const data = await api<{ subjects: SubjectRow[] }>(
        `/api/memory/subjects?guildId=${encodeURIComponent(guildId)}&limit=300`
      );
      setSubjects(Array.isArray(data.subjects) ? data.subjects : []);
    } catch {
      setSubjects([]);
    } finally {
      setLoadingSubjects(false);
    }
  }, [guildId]);

  const loadFacts = useCallback(async (subject: string | null) => {
    if (!guildId) return;
    setLoadingFacts(true);
    try {
      const params = new URLSearchParams({ guildId, limit: String(factLimit) });
      if (subject) params.set("subject", subject);
      if (deferredFactQuery.trim()) params.set("q", deferredFactQuery.trim());
      const data = await api<{ facts: FactRow[] }>(`/api/memory/facts?${params}`);
      const nextFacts = Array.isArray(data.facts) ? data.facts : [];
      setFacts(nextFacts);
      setDraftsById(Object.fromEntries(nextFacts.map((fact) => [fact.id, createDraft(fact)])));
    } catch {
      setFacts([]);
      setDraftsById({});
    } finally {
      setLoadingFacts(false);
    }
  }, [deferredFactQuery, factLimit, guildId]);

  const loadAuditForFact = useCallback(async (factId: number) => {
    if (!guildId || !Number.isInteger(factId) || factId <= 0) return;
    setLoadingAuditFactId(factId);
    try {
      const data = await api<{ events: FactAuditEvent[] }>(
        `/api/memory/facts/audit?guildId=${encodeURIComponent(guildId)}&factId=${encodeURIComponent(String(factId))}&limit=12`
      );
      setAuditByFactId((current) => ({
        ...current,
        [factId]: Array.isArray(data.events) ? data.events : []
      }));
    } catch {
      setAuditByFactId((current) => ({
        ...current,
        [factId]: []
      }));
    } finally {
      setLoadingAuditFactId((current) => (current === factId ? null : current));
    }
  }, [guildId]);

  useEffect(() => {
    if (!guildId) return;
    setSelectedSubject(null);
    setFacts([]);
    setDraftsById({});
    setAuditByFactId({});
    setExpandedFactId(null);
    setStatus(null);
    void loadSubjects();
  }, [guildId, loadSubjects]);

  useEffect(() => {
    if (guildId) {
      void loadFacts(selectedSubject);
    }
  }, [guildId, loadFacts, selectedSubject]);

  useEffect(() => {
    if (expandedFactId === null) return;
    if (!facts.some((fact) => fact.id === expandedFactId)) {
      setExpandedFactId(null);
    }
  }, [expandedFactId, facts]);

  useEffect(() => {
    if (!expandedFactId) return;
    if (auditByFactId[expandedFactId]) return;
    void loadAuditForFact(expandedFactId);
  }, [auditByFactId, expandedFactId, loadAuditForFact]);

  const refreshInspector = useCallback(async () => {
    await Promise.all([
      loadSubjects(),
      loadFacts(selectedSubject)
    ]);
  }, [loadFacts, loadSubjects, selectedSubject]);

  const handleSaveFact = useCallback(async (fact: FactRow) => {
    const draft = draftsById[fact.id];
    if (!guildId || !draft) return;

    const nextSubject = draft.subject.trim();
    const nextFactType = draft.factType.trim() || "general";
    const nextFact = draft.fact.trim();
    const nextEvidenceText = draft.evidenceText.trim();
    const nextConfidence = Number(draft.confidence);

    if (!nextSubject || !nextFact) {
      setStatus({
        text: "Subject and fact text are required.",
        tone: "error"
      });
      return;
    }
    if (!Number.isFinite(nextConfidence) || nextConfidence < 0 || nextConfidence > 1) {
      setStatus({
        text: "Confidence must be between 0 and 1.",
        tone: "error"
      });
      return;
    }

    setSavingId(fact.id);
    setStatus(null);
    try {
      await api(`/api/memory/facts/${encodeURIComponent(String(fact.id))}`, {
        method: "PATCH",
        body: {
          guildId,
          subject: nextSubject,
          factType: nextFactType,
          fact: nextFact,
          evidenceText: nextEvidenceText || null,
          confidence: nextConfidence
        }
      });
      await refreshInspector();
      await loadAuditForFact(fact.id);
      setStatus({
        text: "Memory fact updated.",
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
  }, [draftsById, guildId, loadAuditForFact, refreshInspector]);

  const handleRemoveFact = useCallback(async (fact: FactRow) => {
    if (!guildId) return;
    setRemovingId(fact.id);
    setStatus(null);
    try {
      await api(`/api/memory/facts/${encodeURIComponent(String(fact.id))}/remove`, {
        method: "POST",
        body: {
          guildId
        }
      });
      setAuditByFactId((current) => {
        const next = { ...current };
        delete next[fact.id];
        return next;
      });
      if (expandedFactId === fact.id) {
        setExpandedFactId(null);
      }
      await refreshInspector();
      setStatus({
        text: "Memory fact removed.",
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
  }, [expandedFactId, guildId, refreshInspector]);

  const totalFacts = subjects.reduce((sum, subject) => sum + subject.fact_count, 0);

  const filteredSubjects = subjectFilter.trim()
    ? subjects.filter((subject) =>
        subject.subject.toLowerCase().includes(subjectFilter.toLowerCase())
      )
    : subjects;

  return (
    <div className="inspector-layout">
      <div className="inspector-toolbar">
        <div className="inspector-toolbar-left">
          <GuildSelectField guilds={guilds} guildId={guildId} onGuildChange={setGuildId} />
        </div>
        <div className="inspector-toolbar-right">
          <span className="inspector-stat">
            {subjects.length} subject{subjects.length !== 1 ? "s" : ""}
          </span>
          <span className="inspector-stat-sep" />
          <span className="inspector-stat">
            {totalFacts} fact{totalFacts !== 1 ? "s" : ""}
          </span>
          <button
            type="button"
            className="sm"
            onClick={() => {
              void refreshInspector();
            }}
            disabled={loadingSubjects || loadingFacts}
          >
            Reload
          </button>
        </div>
      </div>

      <p className="memory-reflection-copy">
        Inspect the durable facts feeding long-term memory, search them by content or source metadata, then edit or remove stale entries without touching the raw SQLite file.
      </p>

      {status && (
        <p className={`memory-reflection-inline-status${status.tone === "error" ? " error" : ""}`} role="status">
          {status.text}
        </p>
      )}

      <div className="inspector-body">
        <aside className="inspector-subjects">
          <div className="inspector-subjects-header">
            <span className="inspector-subjects-title">Subjects</span>
            <span className="inspector-subjects-count">{filteredSubjects.length}</span>
          </div>
          <input
            className="inspector-subjects-filter"
            type="text"
            placeholder="Filter subjects..."
            value={subjectFilter}
            onChange={(event) => setSubjectFilter(event.target.value)}
          />
          <button
            type="button"
            className={`inspector-subject-item${selectedSubject === null ? " active" : ""}`}
            onClick={() => setSelectedSubject(null)}
          >
            <span className="inspector-subject-name">All Subjects</span>
            <span className="inspector-subject-count">{totalFacts}</span>
          </button>
          <div className="inspector-subjects-list">
            {loadingSubjects && subjects.length === 0 && (
              <div className="inspector-empty">Loading...</div>
            )}
            {filteredSubjects.map((subject) => (
              <button
                key={subject.subject}
                type="button"
                className={`inspector-subject-item${selectedSubject === subject.subject ? " active" : ""}`}
                onClick={() => setSelectedSubject(subject.subject)}
                title={`Last updated: ${timeAgo(subject.last_seen_at)}`}
              >
                <span className="inspector-subject-name">{subject.subject}</span>
                <span className="inspector-subject-count">{subject.fact_count}</span>
              </button>
            ))}
          </div>
        </aside>

        <div className="inspector-facts">
          <div className="inspector-facts-header">
            <span className="inspector-facts-title">
              {selectedSubject ? `Facts For ${selectedSubject}` : "All Facts"}
            </span>
            <div className="inspector-facts-controls">
              <input
                className="inspector-facts-filter"
                type="text"
                value={factQuery}
                onChange={(event) => setFactQuery(event.target.value)}
                placeholder="Search fact text, evidence, channel, source..."
              />
              <label className="inspector-limit-label">
                Limit
                <select
                  value={factLimit}
                  onChange={(event) => setFactLimit(Number(event.target.value))}
                >
                  {[60, 120, 250, 500].map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </select>
              </label>
              <span className="inspector-facts-count">
                {loadingFacts ? "Loading..." : `${facts.length} shown`}
              </span>
            </div>
          </div>

          {facts.length === 0 && !loadingFacts ? (
            <div className="inspector-empty">
              {guildId ? "No matching facts found." : "Select a guild to inspect memory."}
            </div>
          ) : (
            <div className="inspector-facts-table-wrap">
              <table className="inspector-table">
                <thead>
                  <tr>
                    <th className="inspector-th-id">ID</th>
                    <th className="inspector-th-subject">Subject</th>
                    <th className="inspector-th-type">Type</th>
                    <th className="inspector-th-fact">Fact</th>
                    <th className="inspector-th-conf">Conf</th>
                    <th className="inspector-th-updated">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {facts.map((fact) => (
                    <FactRowView
                      key={fact.id}
                      fact={fact}
                      draft={draftsById[fact.id]}
                      isOpen={expandedFactId === fact.id}
                      isSaving={savingId === fact.id}
                      isRemoving={removingId === fact.id}
                      auditEvents={auditByFactId[fact.id] || []}
                      auditLoading={loadingAuditFactId === fact.id}
                      onToggle={() => setExpandedFactId((current) => (current === fact.id ? null : fact.id))}
                      onDraftChange={(patch) =>
                        setDraftsById((current) => ({
                          ...current,
                          [fact.id]: {
                            ...createDraft(fact),
                            ...current[fact.id],
                            ...patch
                          }
                        }))
                      }
                      onSave={() => {
                        void handleSaveFact(fact);
                      }}
                      onRemove={() => {
                        void handleRemoveFact(fact);
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FactRowView({
  fact,
  draft,
  isOpen,
  isSaving,
  isRemoving,
  auditEvents,
  auditLoading,
  onToggle,
  onDraftChange,
  onSave,
  onRemove
}: {
  fact: FactRow;
  draft: FactDraft | undefined;
  isOpen: boolean;
  isSaving: boolean;
  isRemoving: boolean;
  auditEvents: FactAuditEvent[];
  auditLoading: boolean;
  onToggle: () => void;
  onDraftChange: (patch: Partial<FactDraft>) => void;
  onSave: () => void;
  onRemove: () => void;
}) {
  const changed = hasDraftChanges(fact, draft);

  return (
    <>
      <tr
        className={`inspector-row${isOpen ? " inspector-row-open" : ""}`}
        onClick={onToggle}
        tabIndex={0}
      >
        <td className="inspector-td-id">
          <span className={`inspector-expand${isOpen ? " open" : ""}`}>&#9654;</span>
          {fact.id}
        </td>
        <td className="inspector-td-subject">{fact.subject}</td>
        <td className="inspector-td-type">
          <span className="inspector-type-badge">{fact.fact_type}</span>
        </td>
        <td className="inspector-td-fact">{fact.fact}</td>
        <td className="inspector-td-conf">
          {Math.round(fact.confidence * 100)}%
        </td>
        <td className="inspector-td-updated">{timeAgo(fact.updated_at)}</td>
      </tr>
      {isOpen && (
        <tr className="inspector-detail-row">
          <td colSpan={6}>
            <div className="inspector-detail">
              <div className="inspector-detail-grid">
                <div>
                  <span className="inspector-detail-label">Fact ID</span>
                  <span className="inspector-detail-value">{fact.id}</span>
                </div>
                <div>
                  <span className="inspector-detail-label">Guild</span>
                  <span className="inspector-detail-value">{fact.guild_id}</span>
                </div>
                <div>
                  <span className="inspector-detail-label">Channel</span>
                  <span className="inspector-detail-value">{fact.channel_id || "—"}</span>
                </div>
                <div>
                  <span className="inspector-detail-label">Source Msg</span>
                  <span className="inspector-detail-value">{fact.source_message_id || "—"}</span>
                </div>
                <div>
                  <span className="inspector-detail-label">Created</span>
                  <span className="inspector-detail-value">{formatTimestamp(fact.created_at)}</span>
                </div>
                <div>
                  <span className="inspector-detail-label">Updated</span>
                  <span className="inspector-detail-value">{formatTimestamp(fact.updated_at)}</span>
                </div>
                <div>
                  <span className="inspector-detail-label">Confidence</span>
                  <span className="inspector-detail-value">{(fact.confidence * 100).toFixed(1)}%</span>
                </div>
                <div>
                  <span className="inspector-detail-label">Type</span>
                  <span className="inspector-detail-value">{fact.fact_type}</span>
                </div>
              </div>

              <div className="inspector-editor-grid">
                <label>
                  Subject
                  <input
                    type="text"
                    value={draft?.subject || ""}
                    onChange={(event) => onDraftChange({ subject: event.target.value })}
                  />
                </label>
                <label>
                  Type
                  <input
                    type="text"
                    value={draft?.factType || ""}
                    onChange={(event) => onDraftChange({ factType: event.target.value })}
                  />
                </label>
                <label>
                  Confidence
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={draft?.confidence || ""}
                    onChange={(event) => onDraftChange({ confidence: event.target.value })}
                  />
                </label>
              </div>

              <div className="inspector-detail-section">
                <span className="inspector-detail-label">Editable Fact</span>
                <textarea
                  className="inspector-editor-textarea"
                  value={draft?.fact || ""}
                  onChange={(event) => onDraftChange({ fact: event.target.value })}
                  rows={3}
                />
              </div>

              <div className="inspector-detail-section">
                <span className="inspector-detail-label">Evidence / Source Note</span>
                <textarea
                  className="inspector-editor-textarea inspector-editor-textarea-subtle"
                  value={draft?.evidenceText || ""}
                  onChange={(event) => onDraftChange({ evidenceText: event.target.value })}
                  rows={3}
                />
              </div>

              <div className="inspector-detail-actions">
                <button
                  type="button"
                  className="cta"
                  disabled={!changed || isSaving || isRemoving}
                  onClick={onSave}
                >
                  {isSaving ? "Saving..." : "Save Fact"}
                </button>
                <button
                  type="button"
                  disabled={isSaving || isRemoving}
                  onClick={onRemove}
                >
                  {isRemoving ? "Removing..." : "Remove Fact"}
                </button>
              </div>

              <div className="inspector-detail-section">
                <span className="inspector-detail-label">Audit Trail</span>
                {auditLoading ? (
                  <p className="inspector-detail-text">Loading fact history...</p>
                ) : auditEvents.length === 0 ? (
                  <p className="inspector-detail-text">
                    No explicit edit/remove events yet. Current timestamps and source metadata above still show when this fact was created and last updated.
                  </p>
                ) : (
                  <div className="inspector-audit-list">
                    {auditEvents.map((event) => (
                      <article
                        key={`${String(event.id || "audit")}:${String(event.createdAt || "")}:${event.eventType}`}
                        className="inspector-audit-card"
                      >
                        <div className="inspector-audit-meta">
                          <strong>{formatAuditLabel(event.eventType)}</strong>
                          <span>{formatTimestamp(event.createdAt)}</span>
                          <span>{event.actorName ? `by ${event.actorName}` : "actor unknown"}</span>
                          {event.source ? <span>{event.source}</span> : null}
                        </div>
                        <p className="inspector-audit-text">{buildAuditSummary(event)}</p>
                        {(event.removalReason || event.channelId || event.sourceMessageId) && (
                          <div className="inspector-audit-submeta">
                            {event.removalReason ? <span>Reason: {event.removalReason}</span> : null}
                            {event.channelId ? <span>Channel: {event.channelId}</span> : null}
                            {event.sourceMessageId ? <span>Source: {event.sourceMessageId}</span> : null}
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
