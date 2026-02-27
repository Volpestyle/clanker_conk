import { Fragment, useCallback, useMemo, useRef, useState } from "react";

const STORAGE_KEY = "actionStreamColWidths";
const COLUMNS = ["time", "kind", "channel", "content", "cost"] as const;
const DEFAULT_WIDTHS: Record<string, number> = {
  time: 210,
  kind: 196,
  channel: 210,
  content: 400,
  cost: 122,
};
const MIN_COL_WIDTH = 60;

function loadColWidths(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Validate all columns present and numeric
      const result: Record<string, number> = {};
      for (const col of COLUMNS) {
        const v = parsed[col];
        result[col] = typeof v === "number" && v >= MIN_COL_WIDTH ? v : DEFAULT_WIDTHS[col];
      }
      return result;
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_WIDTHS };
}

function saveColWidths(widths: Record<string, number>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch { /* ignore */ }
}

const FILTERS = [
  "all",
  "sent_reply",
  "sent_message",
  "reply_skipped",
  "initiative_post",
  "reacted",
  "llm_call",
  "image_call",
  "gif_call",
  "gif_error",
  "search_call",
  "search_error",
  "video_context_call",
  "video_context_error",
  "asr_call",
  "asr_error",
  "voice_session_start",
  "voice_session_end",
  "voice_intent_detected",
  "voice_turn_in",
  "voice_turn_out",
  "voice_soundboard_play",
  "voice_runtime",
  "voice_error",
  "bot_runtime",
  "bot_error"
];

export default function ActionStream({ actions }) {
  const [filter, setFilter] = useState("all");
  const [expandedRowKey, setExpandedRowKey] = useState("");
  const [colWidths, setColWidths] = useState(loadColWidths);
  const dragRef = useRef<{ col: string; startX: number; startW: number } | null>(null);

  const onResizeStart = useCallback((col: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidths[col];
    dragRef.current = { col, startX, startW };

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = ev.clientX - dragRef.current.startX;
      const newW = Math.max(MIN_COL_WIDTH, dragRef.current.startW + delta);
      setColWidths((prev) => {
        const next = { ...prev, [dragRef.current!.col]: newW };
        return next;
      });
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setColWidths((prev) => {
        saveColWidths(prev);
        return prev;
      });
      dragRef.current = null;
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [colWidths]);

  const rows = useMemo(
    () => (filter === "all" ? actions : actions.filter((a) => a.kind === filter)),
    [actions, filter]
  );

  const usedWebSearchFollowup = (action) => Boolean(action?.metadata?.llm?.usedWebSearchFollowup);
  const getRowKey = (action, index) => String(action?.id ?? `${action?.created_at || "unknown"}-${index}`);

  const toggleRow = (rowKey) => {
    setExpandedRowKey((current) => (current === rowKey ? "" : rowKey));
  };

  const toPrettyJson = (value) => {
    if (value === null || value === undefined || value === "") return "(none)";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  };

  const formatMetaValue = (value) => {
    if (value === null || value === undefined || value === "") return "-";
    return String(value);
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Action Stream</h3>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          {FILTERS.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
      </div>

      <div className="table-wrap">
        <table className="action-table">
          <colgroup>
            {COLUMNS.map((col) => (
              <col key={col} style={{ width: colWidths[col] }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {COLUMNS.map((col) => (
                <th key={col} className={`col-${col}`}>
                  <div className="th-resizable">
                    <span>{col === "content" ? "Content" : col.charAt(0).toUpperCase() + col.slice(1)}</span>
                    <div
                      className="col-resize-handle"
                      onMouseDown={(e) => onResizeStart(col, e)}
                      role="separator"
                      aria-orientation="vertical"
                    />
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((action, i) => {
              const rowKey = getRowKey(action, i);
              const isExpanded = expandedRowKey === rowKey;

              return (
                <Fragment key={rowKey}>
                  <tr
                    className={`action-row${isExpanded ? " action-row-expanded" : ""}`}
                    onClick={() => toggleRow(rowKey)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        toggleRow(rowKey);
                      }
                    }}
                    tabIndex={0}
                    aria-expanded={isExpanded}
                  >
                    <td className="action-time-cell col-time">
                      <span className="action-time-inner">
                        <span className={`expand-indicator${isExpanded ? " open" : ""}`} aria-hidden="true">
                          ▸
                        </span>
                        {new Date(action.created_at).toLocaleString()}
                      </span>
                    </td>
                    <td className="col-kind">
                      <span className={`kind-badge kind-${action.kind}`}>
                        {action.kind}
                      </span>
                      {usedWebSearchFollowup(action) && (
                        <span className="kind-badge kind-web-followup">web-followup</span>
                      )}
                    </td>
                    <td className="col-channel">{action.channel_id || "-"}</td>
                    <td className="col-content">{String(action.content || "").slice(0, 180) || "-"}</td>
                    <td className="col-cost">${Number(action.usd_cost || 0).toFixed(6)}</td>
                  </tr>
                  {isExpanded && (
                    <tr className="action-detail-row">
                      <td colSpan="5">
                        <div className="action-detail">
                          <div className="action-detail-grid">
                            <p><span>Event ID</span><code>{formatMetaValue(action.id)}</code></p>
                            <p><span>Guild</span><code>{formatMetaValue(action.guild_id)}</code></p>
                            <p><span>Channel</span><code>{formatMetaValue(action.channel_id)}</code></p>
                            <p><span>User</span><code>{formatMetaValue(action.user_id)}</code></p>
                            <p><span>Message</span><code>{formatMetaValue(action.message_id)}</code></p>
                            <p><span>Cost</span><code>${Number(action.usd_cost || 0).toFixed(6)}</code></p>
                          </div>

                          <div className="action-detail-block">
                            <h4>Content</h4>
                            <pre>{String(action.content || "(empty)")}</pre>
                          </div>

                          <div className="action-detail-block">
                            <h4>Metadata</h4>
                            <pre>{toPrettyJson(action.metadata)}</pre>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan="5" style={{ textAlign: "center", color: "var(--ink-3)" }}>
                  No actions yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
