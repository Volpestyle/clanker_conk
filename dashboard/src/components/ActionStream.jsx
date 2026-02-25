import { useState, useMemo } from "react";

const FILTERS = [
  "all",
  "sent_reply",
  "sent_message",
  "initiative_post",
  "reacted",
  "llm_call",
  "image_call",
  "search_call",
  "search_error"
];

export default function ActionStream({ actions }) {
  const [filter, setFilter] = useState("all");

  const rows = useMemo(
    () => (filter === "all" ? actions : actions.filter((a) => a.kind === filter)),
    [actions, filter]
  );

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
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Kind</th>
              <th>Channel</th>
              <th>Content</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((action, i) => (
              <tr key={action.id || i}>
                <td>{new Date(action.created_at).toLocaleString()}</td>
                <td>
                  <span className={`kind-badge kind-${action.kind}`}>
                    {action.kind}
                  </span>
                </td>
                <td>{action.channel_id || "-"}</td>
                <td>{String(action.content || "").slice(0, 180)}</td>
                <td>${Number(action.usd_cost || 0).toFixed(6)}</td>
              </tr>
            ))}
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
