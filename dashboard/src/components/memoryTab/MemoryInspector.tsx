import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { GuildSelectField, getLastGuildId, saveLastGuildId } from "./MemoryFormFields";

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

export default function MemoryInspector({ guilds }: Props) {
  const [guildId, setGuildId] = useState("");
  const [subjects, setSubjects] = useState<SubjectRow[]>([]);
  const [selectedSubject, setSelectedSubject] = useState<string | null>(null);
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [subjectFilter, setSubjectFilter] = useState("");
  const [factQuery, setFactQuery] = useState("");
  const [loadingSubjects, setLoadingSubjects] = useState(false);
  const [loadingFacts, setLoadingFacts] = useState(false);
  const [status, setStatus] = useState<StatusState>(null);
  const [factLimit, setFactLimit] = useState(120);

  useEffect(() => {
    if (!guildId && guilds.length > 0) {
      const saved = getLastGuildId();
      const restored = saved && guilds.some((guild) => guild.id === saved);
      const next = restored ? saved : guilds[0].id;
      setGuildId(next);
      saveLastGuildId(next);
    }
  }, [guildId, guilds]);

  const loadSubjects = useCallback(async () => {
    if (!guildId) return;
    setLoadingSubjects(true);
    setStatus(null);
    try {
      const data = await api<{ subjects: SubjectRow[] }>(
        `/api/memory/subjects?guildId=${encodeURIComponent(guildId)}&limit=300`
      );
      setSubjects(Array.isArray(data.subjects) ? data.subjects : []);
    } catch (error: unknown) {
      setSubjects([]);
      setStatus({
        text: error instanceof Error ? error.message : String(error),
        tone: "error"
      });
    } finally {
      setLoadingSubjects(false);
    }
  }, [guildId]);

  const loadFacts = useCallback(async (subject: string | null) => {
    if (!guildId) return;
    setLoadingFacts(true);
    setStatus(null);
    try {
      const params = new URLSearchParams({ guildId, limit: String(factLimit) });
      if (subject) params.set("subject", subject);
      if (factQuery.trim()) params.set("q", factQuery.trim());
      const data = await api<{ facts: FactRow[] }>(`/api/memory/facts?${params}`);
      setFacts(Array.isArray(data.facts) ? data.facts : []);
    } catch (error: unknown) {
      setFacts([]);
      setStatus({
        text: error instanceof Error ? error.message : String(error),
        tone: "error"
      });
    } finally {
      setLoadingFacts(false);
    }
  }, [factLimit, factQuery, guildId]);

  useEffect(() => {
    if (!guildId) return;
    setSelectedSubject(null);
    setFacts([]);
    setStatus(null);
    void loadSubjects();
  }, [guildId, loadSubjects]);

  useEffect(() => {
    if (!guildId) return;
    void loadFacts(selectedSubject);
  }, [guildId, loadFacts, selectedSubject]);

  const filteredSubjects = useMemo(() => {
    const query = subjectFilter.trim().toLowerCase();
    if (!query) return subjects;
    return subjects.filter((subject) => String(subject.subject || "").toLowerCase().includes(query));
  }, [subjectFilter, subjects]);

  return (
    <div className="memory-style-layout">
      <p className="memory-reflection-copy">
        Browse raw durable facts by subject. This view is inspection-only; documented memory writes go through
        `memory_write`, micro-reflection, or daily reflection.
      </p>
      {status ? (
        <p className={`memory-reflection-inline-status${status.tone === "error" ? " error" : ""}`} role="status">
          {status.text}
        </p>
      ) : null}
      <div className="memory-form-row">
        <GuildSelectField guilds={guilds} guildId={guildId} onGuildChange={setGuildId} />
        <label>
          Subject Filter
          <input
            type="text"
            value={subjectFilter}
            onChange={(event) => setSubjectFilter(event.target.value)}
            placeholder="Filter subjects"
          />
        </label>
      </div>
      <div className="memory-style-sections">
        <section className="memory-style-section">
          <div className="memory-style-section-head">
            <h4>Subjects</h4>
            <span className="memory-result-count">
              {loadingSubjects ? "Loading..." : `${filteredSubjects.length} shown`}
            </span>
          </div>
          <div className="memory-reflection-chip-row">
            <button
              type="button"
              className={!selectedSubject ? "cta sm" : "sm"}
              onClick={() => setSelectedSubject(null)}
            >
              All
            </button>
            {filteredSubjects.map((subject) => (
              <button
                key={`${subject.guild_id}:${subject.subject}`}
                type="button"
                className={selectedSubject === subject.subject ? "cta sm" : "sm"}
                onClick={() => setSelectedSubject(subject.subject)}
                title={formatTimestamp(subject.last_seen_at)}
              >
                {subject.subject} ({subject.fact_count})
              </button>
            ))}
          </div>
        </section>
        <section className="memory-style-section">
          <div className="memory-style-section-head">
            <h4>Facts</h4>
            <span className="memory-result-count">
              {loadingFacts ? "Loading..." : `${facts.length} shown`}
            </span>
          </div>
          <div className="memory-form-row">
            <label>
              Query
              <input
                type="text"
                value={factQuery}
                onChange={(event) => setFactQuery(event.target.value)}
                placeholder="Filter fact text"
              />
            </label>
            <label className="inspector-limit-label">
              Limit
              <select value={factLimit} onChange={(event) => setFactLimit(Number(event.target.value))}>
                {[60, 120, 250, 500].map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>
          </div>
          {facts.length === 0 && !loadingFacts ? (
            <p className="memory-result-count">No matching facts found.</p>
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
                    <tr key={fact.id}>
                      <td className="inspector-td-id">{fact.id}</td>
                      <td className="inspector-td-subject">{fact.subject}</td>
                      <td className="inspector-td-type">
                        <span className="inspector-type-badge">{fact.fact_type}</span>
                      </td>
                      <td className="inspector-td-fact">
                        <div>{fact.fact}</div>
                        {fact.evidence_text ? (
                          <div className="memory-reflection-footnote">{fact.evidence_text}</div>
                        ) : null}
                        <div className="memory-reflection-footnote">
                          {fact.channel_id ? `Channel ${fact.channel_id} · ` : ""}
                          {fact.source_message_id ? `Source ${fact.source_message_id} · ` : ""}
                          Created {formatTimestamp(fact.created_at)}
                        </div>
                      </td>
                      <td className="inspector-td-conf">{Math.round(Number(fact.confidence || 0) * 100)}%</td>
                      <td className="inspector-td-updated">{timeAgo(fact.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
