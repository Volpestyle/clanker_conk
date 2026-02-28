import { useState } from "react";

interface FactResult {
  subject?: string;
  factType?: string;
  fact?: string;
  confidence?: number;
  score?: number;
  semanticScore?: number;
  lexicalScore?: number;
  evidence?: string[];
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export default function MemoryResultsTable({ results }: { results: FactResult[] }) {
  const [expanded, setExpanded] = useState<number | null>(null);

  if (!results?.length) {
    return <p style={{ color: "var(--ink-3)", fontSize: "0.84rem", padding: "12px 0" }}>No results</p>;
  }

  return (
    <div className="table-wrap">
      <table className="action-table">
        <thead>
          <tr>
            <th style={{ width: "60px" }}>Score</th>
            <th style={{ width: "120px" }}>Subject</th>
            <th style={{ width: "80px" }}>Type</th>
            <th>Fact</th>
            <th style={{ width: "70px" }}>Conf.</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r, i) => {
            const isOpen = expanded === i;
            return (
              <>
                <tr
                  key={`row-${i}`}
                  className={`action-row${isOpen ? " action-row-expanded" : ""}`}
                  onClick={() => setExpanded(isOpen ? null : i)}
                  tabIndex={0}
                >
                  <td>
                    <span className="action-time-inner">
                      <span className={`expand-indicator${isOpen ? " open" : ""}`}>&#9654;</span>
                      {fmt(r.score)}
                    </span>
                  </td>
                  <td style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.subject || "\u2014"}
                  </td>
                  <td>
                    {r.factType ? (
                      <span className="kind-badge kind-llm_call">{r.factType}</span>
                    ) : "\u2014"}
                  </td>
                  <td style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.fact || "\u2014"}
                  </td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {r.confidence != null ? `${Math.round(r.confidence * 100)}%` : "\u2014"}
                  </td>
                </tr>
                {isOpen && (
                  <tr key={`detail-${i}`} className="action-detail-row">
                    <td colSpan={5}>
                      <div className="action-detail">
                        <div className="action-detail-grid">
                          <p>
                            <span>Semantic</span>
                            <code>{fmt(r.semanticScore)}</code>
                          </p>
                          <p>
                            <span>Lexical</span>
                            <code>{fmt(r.lexicalScore)}</code>
                          </p>
                          <p>
                            <span>Combined</span>
                            <code>{fmt(r.score)}</code>
                          </p>
                        </div>
                        {r.evidence?.length ? (
                          <div className="action-detail-block">
                            <h4>Evidence</h4>
                            <pre>{r.evidence.join("\n")}</pre>
                          </div>
                        ) : null}
                        {r.metadata && Object.keys(r.metadata).length > 0 && (
                          <div className="action-detail-block">
                            <h4>Metadata</h4>
                            <pre>{JSON.stringify(r.metadata, null, 2)}</pre>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function fmt(v: unknown): string {
  if (v == null) return "\u2014";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toFixed(4);
}
