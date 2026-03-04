import { useEffect, useState } from "react";
import { api } from "../../api";

interface Guild {
  id: string;
  name: string;
}

interface ReflectionFact {
  subject?: string;
  subjectName?: string;
  fact?: string;
  type?: string;
  confidence?: number;
  evidence?: string;
  scope?: string;
  subjectOverride?: string | null;
  userId?: string | null;
  status?: string;
  saveReason?: string;
  storedFact?: string | null;
  storedSubject?: string | null;
}

interface ReflectionRun {
  runId?: string | null;
  dateKey?: string;
  guildId?: string;
  status?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  erroredAt?: string | null;
  durationMs?: number | null;
  strategy?: string | null;
  provider?: string | null;
  model?: string | null;
  extractorProvider?: string | null;
  extractorModel?: string | null;
  adjudicatorProvider?: string | null;
  adjudicatorModel?: string | null;
  usdCost?: number;
  maxFacts?: number | null;
  journalEntryCount?: number | null;
  authorCount?: number | null;
  factsExtracted?: number;
  factsSelected?: number;
  factsAdded?: number;
  factsSaved?: number;
  factsSkipped?: number;
  extractedFacts?: ReflectionFact[];
  selectedFacts?: ReflectionFact[];
  savedFacts?: ReflectionFact[];
  skippedFacts?: ReflectionFact[];
  usage?: Record<string, number> | null;
  startContent?: string | null;
  completionContent?: string | null;
  errorContent?: string | null;
}

interface ReflectionResponse {
  runs?: ReflectionRun[];
}

function formatDateTime(value?: string | null) {
  if (!value) return "Unknown";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function formatUsd(value?: number) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return "$0.0000";
  return `$${amount.toFixed(4)}`;
}

function formatDurationMs(value?: number | null) {
  const durationMs = Number(value);
  if (!Number.isFinite(durationMs) || durationMs < 0) return "n/a";
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatConfidence(value?: number) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return null;
  return `${Math.round(confidence * 100)}%`;
}

function statusLabel(status?: string) {
  if (status === "completed") return "Completed";
  if (status === "error") return "Error";
  return "Running";
}

function strategyLabel(strategy?: string | null) {
  if (strategy === "one_pass_main") return "1-pass main";
  if (strategy === "two_pass_extract_then_main") return "2-pass extract + main";
  return "Unknown";
}

export default function MemoryReflections({ guilds }: { guilds: Guild[] }) {
  const [runs, setRuns] = useState<ReflectionRun[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [limit, setLimit] = useState(20);
  const [rerunKey, setRerunKey] = useState("");
  const [rerunStatus, setRerunStatus] = useState("");

  const loadRuns = async (nextLimit = limit) => {
    setLoading(true);
    setError("");
    try {
      const data = await api<ReflectionResponse>(`/api/memory/reflections?limit=${encodeURIComponent(String(nextLimit))}`);
      setRuns(Array.isArray(data?.runs) ? data.runs : []);
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  };

  const handleRerun = async (run: ReflectionRun) => {
    const dateKey = String(run.dateKey || "").trim();
    const guildId = String(run.guildId || "").trim();
    if (!dateKey || !guildId) return;

    const nextRerunKey = `${dateKey}:${guildId}`;
    setRerunKey(nextRerunKey);
    setRerunStatus("");
    try {
      await api("/api/memory/reflections/rerun", {
        method: "POST",
        body: {
          dateKey,
          guildId
        }
      });
      setRerunStatus(`Reran reflection for ${dateKey}.`);
      await loadRuns(limit);
    } catch (rerunError: unknown) {
      setRerunStatus(rerunError instanceof Error ? rerunError.message : String(rerunError));
    } finally {
      setRerunKey("");
    }
  };

  useEffect(() => {
    void loadRuns(limit);
  }, [limit]);

  const guildNameFor = (guildId?: string) =>
    guilds.find((guild) => guild.id === guildId)?.name || guildId || "Unknown guild";

  return (
    <div>
      <div className="panel-head">
        <h3>Daily Reflections</h3>
        <div className="memory-reflection-controls">
          <label>
            Runs
            <select
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
            >
              {[10, 20, 40, 80].map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <button type="button" className="sm" onClick={() => void loadRuns(limit)} disabled={loading}>
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>

      <p className="memory-reflection-copy">
        Review each daily reflection run, what the model extracted, and which facts were actually persisted into durable memory.
      </p>

      {error ? (
        <p className="memory-reflection-inline-status error" role="status">{error}</p>
      ) : null}

      {runs === null && !error ? (
        <div className="memory-box">Loading reflection history...</div>
      ) : null}

      {runs !== null && runs.length === 0 ? (
        <div className="memory-box">No daily reflection runs yet.</div>
      ) : null}

      {Array.isArray(runs) && runs.length > 0 ? (
        <div className="memory-reflection-list">
          {runs.map((run) => {
            const extractedFacts = Array.isArray(run.extractedFacts) ? run.extractedFacts : [];
            const selectedFacts = Array.isArray(run.selectedFacts) ? run.selectedFacts : [];
            const savedFacts = Array.isArray(run.savedFacts) ? run.savedFacts : [];
            const skippedFacts = Array.isArray(run.skippedFacts) ? run.skippedFacts : [];
            return (
              <details key={`${run.runId || "legacy"}:${run.dateKey}:${run.guildId}`} className="memory-reflection-card">
                <summary className="memory-reflection-summary">
                  <div>
                    <div className="memory-reflection-title-row">
                      <strong>{run.dateKey || "Unknown date"}</strong>
                      <span className={`memory-reflection-status memory-reflection-status-${run.status || "running"}`}>
                        {statusLabel(run.status)}
                      </span>
                    </div>
                    <div className="memory-reflection-subtitle">
                      <span>{guildNameFor(run.guildId)}</span>
                      <span>{run.provider || "unknown"}:{run.model || "unknown"}</span>
                    </div>
                  </div>
                  <div className="memory-reflection-chip-row">
                    <span className="memory-reflection-chip">Extracted {run.factsExtracted || 0}</span>
                    <span className="memory-reflection-chip">Selected {run.factsSelected || 0}</span>
                    <span className="memory-reflection-chip">Saved {run.factsSaved ?? run.factsAdded ?? 0}</span>
                    <span className="memory-reflection-chip">Skipped {run.factsSkipped || 0}</span>
                    <span className="memory-reflection-chip">{formatUsd(run.usdCost)}</span>
                  </div>
                </summary>

                <div className="memory-reflection-grid">
                  <div className="memory-reflection-meta">
                    <div><span>Started</span><strong>{formatDateTime(run.startedAt)}</strong></div>
                    <div><span>Finished</span><strong>{formatDateTime(run.completedAt || run.erroredAt)}</strong></div>
                    <div><span>Duration</span><strong>{formatDurationMs(run.durationMs)}</strong></div>
                    <div><span>Strategy</span><strong>{strategyLabel(run.strategy)}</strong></div>
                    <div>
                      <span>Main LLM</span>
                      <strong>{run.adjudicatorProvider || run.provider || "unknown"}:{run.adjudicatorModel || run.model || "unknown"}</strong>
                    </div>
                    <div>
                      <span>Memory LLM</span>
                      <strong>
                        {run.extractorProvider && run.extractorModel
                          ? `${run.extractorProvider}:${run.extractorModel}`
                          : "Not used"}
                      </strong>
                    </div>
                    <div><span>Journal entries</span><strong>{run.journalEntryCount ?? "n/a"}</strong></div>
                    <div><span>Authors</span><strong>{run.authorCount ?? "n/a"}</strong></div>
                    <div><span>Max facts</span><strong>{run.maxFacts ?? "n/a"}</strong></div>
                  </div>

                  {run.usage ? (
                    <div className="memory-reflection-usage">
                      <div><span>Input tokens</span><strong>{Number(run.usage.inputTokens || 0)}</strong></div>
                      <div><span>Output tokens</span><strong>{Number(run.usage.outputTokens || 0)}</strong></div>
                      <div><span>Cache write</span><strong>{Number(run.usage.cacheWriteTokens || 0)}</strong></div>
                      <div><span>Cache read</span><strong>{Number(run.usage.cacheReadTokens || 0)}</strong></div>
                    </div>
                  ) : null}
                </div>

                <div className="memory-reflection-section memory-reflection-actions">
                  <button
                    type="button"
                    className="sm"
                    onClick={() => void handleRerun(run)}
                    disabled={
                      loading ||
                      rerunKey === `${String(run.dateKey || "").trim()}:${String(run.guildId || "").trim()}` ||
                      !run.dateKey ||
                      !run.guildId
                    }
                  >
                    {rerunKey === `${String(run.dateKey || "").trim()}:${String(run.guildId || "").trim()}`
                      ? "Rerunning..."
                      : "Rerun reflection"}
                  </button>
                  {rerunStatus && rerunKey === "" ? (
                    <p className={`memory-reflection-inline-status${rerunStatus.startsWith("API ") ? " error" : ""}`}>
                      {rerunStatus}
                    </p>
                  ) : null}
                </div>

                {run.errorContent ? (
                  <div className="memory-reflection-section">
                    <h4>Error</h4>
                    <p className="memory-reflection-inline-status error">{run.errorContent}</p>
                  </div>
                ) : null}

                <div className="memory-reflection-section">
                  <h4>Extracted Facts</h4>
                  {extractedFacts.length ? (
                    <div className="memory-reflection-facts">
                      {extractedFacts.map((fact, index) => (
                        <article key={`extracted:${index}:${fact.fact || ""}`} className="memory-reflection-fact">
                          <div className="memory-reflection-fact-head">
                            <strong>{fact.subjectName || fact.subject || "unknown"}</strong>
                            <span>{fact.type || "other"}</span>
                            {formatConfidence(fact.confidence) ? <span>{formatConfidence(fact.confidence)}</span> : null}
                          </div>
                          <p>{fact.fact || "(empty fact)"}</p>
                          <blockquote>{fact.evidence || "(no evidence)"}</blockquote>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="memory-reflection-empty">No durable facts extracted.</p>
                  )}
                </div>

                <div className="memory-reflection-section">
                  <h4>Selected By Main LLM</h4>
                  {selectedFacts.length ? (
                    <div className="memory-reflection-facts">
                      {selectedFacts.map((fact, index) => (
                        <article key={`selected:${index}:${fact.fact || ""}`} className="memory-reflection-fact">
                          <div className="memory-reflection-fact-head">
                            <strong>{fact.subjectName || fact.subject || "unknown"}</strong>
                            <span>{fact.type || "other"}</span>
                            {formatConfidence(fact.confidence) ? <span>{formatConfidence(fact.confidence)}</span> : null}
                          </div>
                          <p>{fact.fact || "(empty fact)"}</p>
                          <blockquote>{fact.evidence || "(no evidence)"}</blockquote>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="memory-reflection-empty">The main LLM did not select any facts for durable memory.</p>
                  )}
                </div>

                <div className="memory-reflection-section">
                  <h4>Saved To Durable Memory</h4>
                  {savedFacts.length ? (
                    <div className="memory-reflection-facts">
                      {savedFacts.map((fact, index) => (
                        <article key={`saved:${index}:${fact.fact || ""}`} className="memory-reflection-fact memory-reflection-fact-saved">
                          <div className="memory-reflection-fact-head">
                            <strong>{fact.subjectName || fact.subject || "unknown"}</strong>
                            <span>{fact.scope || "unknown scope"}</span>
                            <span>{fact.saveReason || "saved"}</span>
                          </div>
                          <p>{fact.fact || "(empty fact)"}</p>
                          <div className="memory-reflection-footnote">
                            Stored as {fact.storedFact || "(unknown)"} on {fact.storedSubject || "(unknown subject)"}
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="memory-reflection-empty">No facts were persisted for this run.</p>
                  )}
                </div>

                <div className="memory-reflection-section">
                  <h4>Skipped Facts</h4>
                  {skippedFacts.length ? (
                    <div className="memory-reflection-facts">
                      {skippedFacts.map((fact, index) => (
                        <article key={`skipped:${index}:${fact.fact || ""}`} className="memory-reflection-fact memory-reflection-fact-skipped">
                          <div className="memory-reflection-fact-head">
                            <strong>{fact.subjectName || fact.subject || "unknown"}</strong>
                            <span>{fact.scope || "unknown scope"}</span>
                            <span>{fact.saveReason || "skipped"}</span>
                          </div>
                          <p>{fact.fact || "(empty fact)"}</p>
                          <blockquote>{fact.evidence || "(no evidence)"}</blockquote>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="memory-reflection-empty">No skipped facts recorded.</p>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
