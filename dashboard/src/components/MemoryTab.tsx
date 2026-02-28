import { useState, useEffect } from "react";
import { api } from "../api";
import MemorySnapshot from "./memoryTab/MemorySnapshot";
import MemorySearch from "./memoryTab/MemorySearch";
import MemorySimulator from "./memoryTab/MemorySimulator";

type SubTab = "snapshot" | "search" | "simulator";

interface Guild {
  id: string;
  name: string;
}

interface Props {
  markdown: string | null | undefined;
  onRefresh: () => void;
  notify: (text: string, type?: string) => void;
}

export default function MemoryTab({ markdown, onRefresh, notify }: Props) {
  const [subTab, setSubTab] = useState<SubTab>("snapshot");
  const [guilds, setGuilds] = useState<Guild[]>([]);

  useEffect(() => {
    api<Guild[]>("/api/guilds")
      .then((data) => setGuilds(data || []))
      .catch(() => {});
  }, []);

  return (
    <section className="panel">
      <div className="filter-pills" style={{ marginBottom: 14 }}>
        <button
          className={`filter-pill${subTab === "snapshot" ? " active" : ""}`}
          onClick={() => setSubTab("snapshot")}
        >
          Snapshot
        </button>
        <button
          className={`filter-pill${subTab === "search" ? " active" : ""}`}
          onClick={() => setSubTab("search")}
        >
          Search
        </button>
        <button
          className={`filter-pill${subTab === "simulator" ? " active" : ""}`}
          onClick={() => setSubTab("simulator")}
        >
          Simulator
        </button>
      </div>
      {subTab === "snapshot" && (
        <MemorySnapshot markdown={markdown} onRefresh={onRefresh} />
      )}
      {subTab === "search" && (
        <MemorySearch guilds={guilds} notify={notify} />
      )}
      {subTab === "simulator" && (
        <MemorySimulator guilds={guilds} notify={notify} />
      )}
    </section>
  );
}
