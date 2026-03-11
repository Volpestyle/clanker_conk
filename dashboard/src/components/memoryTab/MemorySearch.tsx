import { useState, type FormEvent } from "react";
import { api } from "../../api";
import MemoryResultsTable, { type FactResult } from "./MemoryResultsTable";
import { ChannelIdField } from "./MemoryFormFields";
import { useDashboardGuildScope } from "../../guildScope";

interface Props {
  notify: (text: string, type?: string) => void;
}

interface MemorySearchResponse {
  results?: FactResult[];
}

export default function MemorySearch({ notify }: Props) {
  const { selectedGuildId } = useDashboardGuildScope();
  const [query, setQuery] = useState("");
  const [channelId, setChannelId] = useState("");
  const [limit, setLimit] = useState(10);
  const [results, setResults] = useState<FactResult[] | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSearch = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedGuildId || !query.trim()) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ q: query.trim(), guildId: selectedGuildId, limit: String(limit) });
      if (channelId.trim()) params.set("channelId", channelId.trim());
      const data = await api<MemorySearchResponse>(`/api/memory/search?${params}`);
      setResults(data.results || []);
    } catch (error: unknown) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <form className="memory-form" onSubmit={handleSearch}>
        <div className="memory-form-row">
          <label>
            Query
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search durable facts..."
            />
          </label>
        </div>
        <div className="memory-form-row">
          <ChannelIdField channelId={channelId} onChannelIdChange={setChannelId} />
          <label>
            Limit
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {[5, 10, 20, 50].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          <div className="memory-form-action">
            <button type="submit" className="cta" disabled={loading || !selectedGuildId || !query.trim()}>
              {loading ? "Searching..." : "Search"}
            </button>
          </div>
        </div>
      </form>
      {results !== null && (
        <div style={{ marginTop: 14 }}>
          <p className="memory-result-count">{results.length} result{results.length !== 1 ? "s" : ""}</p>
          <MemoryResultsTable results={results} />
        </div>
      )}
    </div>
  );
}
