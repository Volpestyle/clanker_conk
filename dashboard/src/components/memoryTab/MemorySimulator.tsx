import { useState, type FormEvent } from "react";
import { api } from "../../api";
import MemoryResultsTable, { type FactResult } from "./MemoryResultsTable";
import MemoryMessagesTable, { type RelevantMessage } from "./MemoryMessagesTable";
import { ChannelIdField, GuildSelectField } from "./MemoryFormFields";

interface Guild {
  id: string;
  name: string;
}

interface Props {
  guilds: Guild[];
  notify: (text: string, type?: string) => void;
}

interface SimulationResult {
  userFacts: FactResult[];
  relevantFacts: FactResult[];
  relevantMessages: RelevantMessage[];
}

export default function MemorySimulator({ guilds, notify }: Props) {
  const [guildId, setGuildId] = useState("");
  const [userId, setUserId] = useState("");
  const [queryText, setQueryText] = useState("");
  const [channelId, setChannelId] = useState("");
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSimulate = async (e: FormEvent) => {
    e.preventDefault();
    if (!guildId || !userId.trim() || !queryText.trim()) return;
    setLoading(true);
    try {
      const body: Record<string, string> = { guildId, queryText: queryText.trim(), userId: userId.trim() };
      if (channelId.trim()) body.channelId = channelId.trim();
      const data = await api<SimulationResult>("/api/memory/simulate-slice", {
        method: "POST",
        body
      });
      setResult(data);
    } catch (error: unknown) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setLoading(false);
    }
  };

  const totalCount = result
    ? (result.userFacts?.length || 0) + (result.relevantFacts?.length || 0) + (result.relevantMessages?.length || 0)
    : 0;

  return (
    <div>
      <form className="memory-form" onSubmit={handleSimulate}>
        <div className="memory-form-row">
          <GuildSelectField guilds={guilds} guildId={guildId} onGuildChange={setGuildId} />
          <label>
            Query Text
            <input
              type="text"
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              placeholder="Simulate a message..."
            />
          </label>
        </div>
        <div className="memory-form-row">
          <label>
            User ID
            <input
              type="text"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="User ID"
            />
          </label>
          <ChannelIdField channelId={channelId} onChannelIdChange={setChannelId} />
          <div className="memory-form-action">
            <button type="submit" className="cta" disabled={loading || !guildId || !userId.trim() || !queryText.trim()}>
              {loading ? "Simulating..." : "Simulate"}
            </button>
          </div>
        </div>
      </form>
      {result && (
        <div style={{ marginTop: 14 }}>
          <p className="memory-result-count">{totalCount} total item{totalCount !== 1 ? "s" : ""} returned</p>

          <div className="memory-result-group">
            <h4 className="memory-result-group-title">
              User Facts
              <span className="memory-result-group-count">{result.userFacts?.length || 0}</span>
            </h4>
            <MemoryResultsTable results={result.userFacts || []} />
          </div>

          <div className="memory-result-group">
            <h4 className="memory-result-group-title">
              Relevant Facts
              <span className="memory-result-group-count">{result.relevantFacts?.length || 0}</span>
            </h4>
            <MemoryResultsTable results={result.relevantFacts || []} />
          </div>

          <div className="memory-result-group">
            <h4 className="memory-result-group-title">
              Relevant Messages
              <span className="memory-result-group-count">{result.relevantMessages?.length || 0}</span>
            </h4>
            <MemoryMessagesTable messages={result.relevantMessages || []} />
          </div>
        </div>
      )}
    </div>
  );
}
