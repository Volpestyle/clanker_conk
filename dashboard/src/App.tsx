import { useState, useCallback } from "react";
import { api } from "./api";
import { usePolling } from "./hooks/usePolling";
import Header from "./components/Header";
import MetricsBar from "./components/MetricsBar";
import SettingsForm from "./components/SettingsForm";
import ActionStream from "./components/ActionStream";
import MemoryViewer from "./components/MemoryViewer";
import DailyCost from "./components/DailyCost";
import PerformancePanel from "./components/PerformancePanel";
import StaleIndicator from "./components/StaleIndicator";

type MainTab = "activity" | "settings";

export default function App() {
  const [toast, setToast] = useState({ text: "", type: "" });
  const [tab, setTab] = useState<MainTab>("activity");

  const notify = useCallback((text, type = "ok") => {
    setToast({ text, type });
    setTimeout(() => setToast({ text: "", type: "" }), 4000);
  }, []);

  const stats = usePolling(() => api("/api/stats"), 10_000);
  const actions = usePolling(() => api("/api/actions?limit=220"), 10_000);
  const memory = usePolling(() => api("/api/memory"), 30_000);
  const settings = usePolling(() => api("/api/settings"), 0);
  const llmModels = usePolling(() => api("/api/llm/models"), 0);
  const reloadStats = stats.reload;
  const reloadMemory = memory.reload;
  const reloadSettings = settings.reload;

  const handleSettingsSave = useCallback(async (patch) => {
    try {
      await api("/api/settings", { method: "PUT", body: patch });
      reloadSettings();
      reloadStats();
      notify("Settings saved");
    } catch (err) {
      notify(err.message, "error");
    }
  }, [reloadSettings, reloadStats, notify]);

  const handleMemoryRefresh = useCallback(async () => {
    try {
      await api("/api/memory/refresh", { method: "POST" });
      reloadMemory();
      notify("Memory regenerated");
    } catch (err) {
      notify(err.message, "error");
    }
  }, [reloadMemory, notify]);

  const isReady = stats.data?.runtime?.isReady ?? false;

  return (
    <main className="shell">
      <Header isReady={isReady} />

      <MetricsBar stats={stats.data} />
      <StaleIndicator lastSuccess={stats.lastSuccess} />

      <nav className="main-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "activity"}
          className={`main-tab${tab === "activity" ? " active" : ""}`}
          onClick={() => setTab("activity")}
        >
          <span className="main-tab-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          </span>
          Activity
        </button>
        <button
          role="tab"
          aria-selected={tab === "settings"}
          className={`main-tab${tab === "settings" ? " active" : ""}`}
          onClick={() => setTab("settings")}
        >
          <span className="main-tab-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </span>
          Settings
        </button>
      </nav>

      {tab === "activity" && (
        <section className="grid-secondary">
          <ActionStream actions={actions.data || []} />
          <div className="stack">
            <MemoryViewer
              markdown={memory.data?.markdown}
              onRefresh={handleMemoryRefresh}
            />
            <PerformancePanel performance={stats.data?.stats?.performance} />
            <DailyCost rows={stats.data?.stats?.dailyCost} />
          </div>
        </section>
      )}

      {tab === "settings" && (
        <SettingsForm
          settings={settings.data}
          modelCatalog={llmModels.data}
          onSave={handleSettingsSave}
          toast={toast}
        />
      )}
    </main>
  );
}
