import React, { useState } from "react";
import { getToken, setToken } from "../api";

export default function Header({ isReady }: { isReady?: boolean }) {
  const [value, setValue] = useState(getToken());
  const [saved, setSaved] = useState(false);
  const [showToken, setShowToken] = useState(false);

  function save() {
    setToken(value.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <header className="hero panel">
      <div className="hero-top-row">
        <div>
          <p className="eyebrow">Discord Persona Ops</p>
          <h1>
            <span className={`header-status-dot${isReady ? " online" : ""}`} />
            clanker conk control room
          </h1>
          <p className="sub">Tune behavior, monitor spend, and track every message &amp; reaction.</p>
        </div>
        <button
          type="button"
          className="gear-btn"
          onClick={() => setShowToken((v) => !v)}
          aria-label="Token settings"
          title="Dashboard token"
        >
          &#x2699;
        </button>
      </div>
      {showToken && (
        <div className="token-dropdown">
          <label htmlFor="dashboard-token">Dashboard token</label>
          <div className="token-row">
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
        </div>
      )}
    </header>
  );
}
