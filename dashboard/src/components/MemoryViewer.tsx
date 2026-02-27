import React, { useMemo } from "react";
import Skeleton from "./Skeleton";
import { renderMarkdown } from "../renderMarkdown";

export default function MemoryViewer({ markdown, onRefresh }) {
  const rendered = useMemo(
    () => (markdown ? renderMarkdown(markdown) : ""),
    [markdown]
  );

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Memory</h3>
        <button type="button" className="sm" onClick={onRefresh}>
          Refresh memory.md
        </button>
      </div>
      {markdown === undefined || markdown === null ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Skeleton height="0.9em" width="80%" />
          <Skeleton height="0.9em" width="60%" />
          <Skeleton height="0.9em" width="90%" />
          <Skeleton height="0.9em" width="45%" />
        </div>
      ) : rendered ? (
        <div
          className="memory-box md-rendered"
          dangerouslySetInnerHTML={{ __html: rendered }}
        />
      ) : (
        <pre className="memory-box">No memory data</pre>
      )}
    </section>
  );
}
