import { useState, useCallback } from "react";
import { api } from "./api";
import { usePolling } from "./hooks/usePolling";
import Header from "./components/Header";
import MetricsBar from "./components/MetricsBar";
import SettingsForm from "./components/SettingsForm";
import ActionStream from "./components/ActionStream";
import MemoryViewer from "./components/MemoryViewer";
import DailyCost from "./components/DailyCost";

export default function App() {
  const [toast, setToast] = useState({ text: "", type: "" });

  const notify = useCallback((text, type = "ok") => {
    setToast({ text, type });
    setTimeout(() => setToast({ text: "", type: "" }), 4000);
  }, []);

  const stats = usePolling(() => api("/api/stats"), 10_000);
  const actions = usePolling(() => api("/api/actions?limit=220"), 10_000);
  const memory = usePolling(() => api("/api/memory"), 30_000);
  const settings = usePolling(() => api("/api/settings"), 0);
  const llmModels = usePolling(() => api("/api/llm/models"), 0);

  const handleSettingsSave = useCallback(async (patch) => {
    try {
      await api("/api/settings", { method: "PUT", body: patch });
      settings.reload();
      stats.reload();
      notify("Settings saved");
    } catch (err) {
      notify(err.message, "error");
    }
  }, [settings.reload, stats.reload, notify]);

  const handleMemoryRefresh = useCallback(async () => {
    try {
      await api("/api/memory/refresh", { method: "POST" });
      memory.reload();
      notify("Memory regenerated");
    } catch (err) {
      notify(err.message, "error");
    }
  }, [memory.reload, notify]);

  return (
    <main className="shell">
      <Header />

      <MetricsBar stats={stats.data} />

      <SettingsForm
        settings={settings.data}
        modelCatalog={llmModels.data}
        onSave={handleSettingsSave}
        toast={toast}
      />

      <section className="grid-secondary">
        <ActionStream actions={actions.data || []} />
        <div className="stack">
          <MemoryViewer
            markdown={memory.data?.markdown}
            onRefresh={handleMemoryRefresh}
          />
          <DailyCost rows={stats.data?.stats?.dailyCost} />
        </div>
      </section>
    </main>
  );
}
