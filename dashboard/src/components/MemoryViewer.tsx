export default function MemoryViewer({ markdown, onRefresh }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Memory</h3>
        <button type="button" className="sm" onClick={onRefresh}>
          Refresh memory.md
        </button>
      </div>
      <pre className="memory-box">{markdown || "No memory data"}</pre>
    </section>
  );
}
