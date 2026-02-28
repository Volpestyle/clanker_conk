export interface RelevantMessage {
  timestamp?: string;
  author?: string;
  content?: string;
  [key: string]: unknown;
}

export default function MemoryMessagesTable({ messages }: { messages: RelevantMessage[] }) {
  if (!messages?.length) {
    return <p style={{ color: "var(--ink-3)", fontSize: "0.84rem", padding: "12px 0" }}>No messages</p>;
  }

  return (
    <div className="table-wrap">
      <table className="action-table">
        <thead>
          <tr>
            <th style={{ width: "140px" }}>Time</th>
            <th style={{ width: "120px" }}>Author</th>
            <th>Content</th>
          </tr>
        </thead>
        <tbody>
          {messages.map((m, i) => (
            <tr key={i}>
              <td style={{ whiteSpace: "nowrap", fontSize: "0.78rem", fontVariantNumeric: "tabular-nums" }}>
                {m.timestamp ? new Date(m.timestamp).toLocaleString() : "\u2014"}
              </td>
              <td style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {m.author || "\u2014"}
              </td>
              <td>{m.content || "\u2014"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
