import { useCallback, useEffect, useState } from "react";
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

interface Props {
  guilds: Guild[];
}

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

export default function MemoryInspector({ guilds }: Props) {
  const [guildId, setGuildId] = useState("");
  const [subjects, setSubjects] = useState<SubjectRow[]>([]);
  const [selectedSubject, setSelectedSubject] = useState<string | null>(null);
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [expandedFactId, setExpandedFactId] = useState<number | null>(null);
  const [subjectFilter, setSubjectFilter] = useState("");
  const [loadingSubjects, setLoadingSubjects] = useState(false);
  const [loadingFacts, setLoadingFacts] = useState(false);
  const [factLimit, setFactLimit] = useState(120);

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
      const data = await api<{ facts: FactRow[] }>(`/api/memory/facts?${params}`);
      setFacts(Array.isArray(data.facts) ? data.facts : []);
    } catch {
      setFacts([]);
    } finally {
      setLoadingFacts(false);
    }
  }, [guildId, factLimit]);

  useEffect(() => {
    if (guildId) {
      void loadSubjects();
      setSelectedSubject(null);
      setFacts([]);
    }
  }, [guildId, loadSubjects]);

  useEffect(() => {
    if (guildId) {
      void loadFacts(selectedSubject);
    }
  }, [guildId, selectedSubject, loadFacts]);

  const totalFacts = subjects.reduce((sum, s) => sum + s.fact_count, 0);

  const filteredSubjects = subjectFilter.trim()
    ? subjects.filter((s) =>
        s.subject.toLowerCase().includes(subjectFilter.toLowerCase())
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
            onClick={() => { void loadSubjects(); void loadFacts(selectedSubject); }}
            disabled={loadingSubjects || loadingFacts}
          >
            Reload
          </button>
        </div>
      </div>

      <div className="inspector-body">
        <aside className="inspector-subjects">
          <div className="inspector-subjects-header">
            <span className="inspector-subjects-title">SUBJECTS</span>
            <span className="inspector-subjects-count">{filteredSubjects.length}</span>
          </div>
          <input
            className="inspector-subjects-filter"
            type="text"
            placeholder="Filter subjects..."
            value={subjectFilter}
            onChange={(e) => setSubjectFilter(e.target.value)}
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
            {filteredSubjects.map((s) => (
              <button
                key={s.subject}
                type="button"
                className={`inspector-subject-item${selectedSubject === s.subject ? " active" : ""}`}
                onClick={() => setSelectedSubject(s.subject)}
                title={`Last updated: ${timeAgo(s.last_seen_at)}`}
              >
                <span className="inspector-subject-name">{s.subject}</span>
                <span className="inspector-subject-count">{s.fact_count}</span>
              </button>
            ))}
          </div>
        </aside>

        <div className="inspector-facts">
          <div className="inspector-facts-header">
            <span className="inspector-facts-title">
              {selectedSubject ? `FACTS FOR ${selectedSubject}` : "ALL FACTS"}
            </span>
            <div className="inspector-facts-controls">
              <label className="inspector-limit-label">
                Limit
                <select
                  value={factLimit}
                  onChange={(e) => setFactLimit(Number(e.target.value))}
                >
                  {[60, 120, 250, 500].map((n) => (
                    <option key={n} value={n}>{n}</option>
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
              {guildId ? "No facts found." : "Select a guild to inspect memory."}
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
                  {facts.map((f) => {
                    const isOpen = expandedFactId === f.id;
                    return (
                      <FactRowView
                        key={f.id}
                        fact={f}
                        isOpen={isOpen}
                        onToggle={() => setExpandedFactId(isOpen ? null : f.id)}
                      />
                    );
                  })}
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
  isOpen,
  onToggle
}: {
  fact: FactRow;
  isOpen: boolean;
  onToggle: () => void;
}) {
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
                  <span className="inspector-detail-label">FACT ID</span>
                  <span className="inspector-detail-value">{fact.id}</span>
                </div>
                <div>
                  <span className="inspector-detail-label">GUILD</span>
                  <span className="inspector-detail-value">{fact.guild_id}</span>
                </div>
                <div>
                  <span className="inspector-detail-label">CHANNEL</span>
                  <span className="inspector-detail-value">{fact.channel_id || "—"}</span>
                </div>
                <div>
                  <span className="inspector-detail-label">SOURCE MSG</span>
                  <span className="inspector-detail-value">{fact.source_message_id || "—"}</span>
                </div>
                <div>
                  <span className="inspector-detail-label">CREATED</span>
                  <span className="inspector-detail-value">{new Date(fact.created_at).toLocaleString()}</span>
                </div>
                <div>
                  <span className="inspector-detail-label">UPDATED</span>
                  <span className="inspector-detail-value">{new Date(fact.updated_at).toLocaleString()}</span>
                </div>
                <div>
                  <span className="inspector-detail-label">CONFIDENCE</span>
                  <span className="inspector-detail-value">{(fact.confidence * 100).toFixed(1)}%</span>
                </div>
                <div>
                  <span className="inspector-detail-label">TYPE</span>
                  <span className="inspector-detail-value">{fact.fact_type}</span>
                </div>
              </div>
              <div className="inspector-detail-section">
                <span className="inspector-detail-label">FULL FACT</span>
                <p className="inspector-detail-text">{fact.fact}</p>
              </div>
              {fact.evidence_text && (
                <div className="inspector-detail-section">
                  <span className="inspector-detail-label">EVIDENCE</span>
                  <p className="inspector-detail-evidence">{fact.evidence_text}</p>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
