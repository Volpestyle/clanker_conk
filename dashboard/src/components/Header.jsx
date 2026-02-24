import { useState } from "react";
import { getToken, setToken } from "../api";

export default function Header() {
  const [value, setValue] = useState(getToken());
  const [saved, setSaved] = useState(false);

  function save() {
    setToken(value.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <header className="hero panel">
      <p className="eyebrow">Discord Persona Ops</p>
      <h1>clanker conk control room</h1>
      <p className="sub">Tune behavior, monitor spend, and track every message &amp; reaction.</p>
      <div className="token-row">
        <label htmlFor="dashboard-token">Dashboard token</label>
        <input
          id="dashboard-token"
          type="password"
          placeholder="optional"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ width: "220px" }}
        />
        <button type="button" onClick={save}>
          {saved ? "Saved" : "Save token"}
        </button>
      </div>
    </header>
  );
}
