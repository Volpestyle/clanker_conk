export default function DailyCost({ rows }) {
  return (
    <section className="panel">
      <h3 style={{ margin: "0 0 12px" }}>Daily Cost (14d)</h3>
      {!rows || rows.length === 0 ? (
        <p className="cost-empty">No usage yet</p>
      ) : (
        <ul className="cost-list">
          {rows.map((row) => (
            <li key={row.day}>
              <span className="day">{row.day}</span>
              <span className="usd">${Number(row.usd || 0).toFixed(6)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
