import { useState, useEffect } from "react";

function parseIdList(val) {
  return [...new Set(val.split(/[\n,]/g).map((x) => x.trim()).filter(Boolean))];
}

function formatIdList(items) {
  return (items || []).join("\n");
}

export default function SettingsForm({ settings, onSave, toast }) {
  const [form, setForm] = useState(null);

  useEffect(() => {
    if (!settings || form) return;
    setForm({
      botName: settings.botName || "clanker conk",
      activityLevel: settings.activity?.level ?? 35,
      minGap: settings.activity?.minSecondsBetweenMessages ?? 20,
      allowReplies: settings.permissions?.allowReplies ?? true,
      allowInitiative: settings.permissions?.allowInitiativeReplies !== false,
      allowReactions: settings.permissions?.allowReactions ?? true,
      memoryEnabled: settings.memory?.enabled ?? true,
      provider: settings.llm?.provider ?? "openai",
      model: settings.llm?.model ?? "gpt-4.1-mini",
      temperature: settings.llm?.temperature ?? 0.9,
      maxTokens: settings.llm?.maxOutputTokens ?? 220,
      maxMessages: settings.permissions?.maxMessagesPerHour ?? settings.permissions?.maxRepliesPerHour ?? 20,
      maxReactions: settings.permissions?.maxReactionsPerHour ?? 24,
      initiativeChannels: formatIdList(settings.permissions?.initiativeChannelIds),
      allowedChannels: formatIdList(settings.permissions?.allowedChannelIds),
      blockedChannels: formatIdList(settings.permissions?.blockedChannelIds),
      blockedUsers: formatIdList(settings.permissions?.blockedUserIds)
    });
  }, [settings]);

  if (!form) return null;

  function set(key) {
    return (e) => setForm((f) => ({ ...f, [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  }

  function submit(e) {
    e.preventDefault();
    onSave({
      botName: form.botName.trim(),
      activity: {
        level: Number(form.activityLevel),
        minSecondsBetweenMessages: Number(form.minGap)
      },
      llm: {
        provider: form.provider,
        model: form.model.trim(),
        temperature: Number(form.temperature),
        maxOutputTokens: Number(form.maxTokens)
      },
      permissions: {
        allowReplies: form.allowReplies,
        allowInitiativeReplies: form.allowInitiative,
        allowReactions: form.allowReactions,
        initiativeChannelIds: parseIdList(form.initiativeChannels),
        allowedChannelIds: parseIdList(form.allowedChannels),
        blockedChannelIds: parseIdList(form.blockedChannels),
        blockedUserIds: parseIdList(form.blockedUsers),
        maxMessagesPerHour: Number(form.maxMessages),
        maxReactionsPerHour: Number(form.maxReactions)
      },
      memory: {
        enabled: form.memoryEnabled
      }
    });
  }

  return (
    <form className="panel settings-form" onSubmit={submit}>
      <h3>Behavior Settings</h3>

      <label htmlFor="bot-name">Bot display name</label>
      <input id="bot-name" type="text" value={form.botName} onChange={set("botName")} />

      <label htmlFor="activity-level">
        Activity level: <strong>{form.activityLevel}</strong>
      </label>
      <input
        id="activity-level"
        type="range"
        min="0"
        max="100"
        step="1"
        value={form.activityLevel}
        onChange={set("activityLevel")}
      />

      <div className="toggles">
        <label>
          <input type="checkbox" checked={form.allowReplies} onChange={set("allowReplies")} />
          Allow replies
        </label>
        <label>
          <input type="checkbox" checked={form.allowInitiative} onChange={set("allowInitiative")} />
          Allow initiative replies
        </label>
        <label>
          <input type="checkbox" checked={form.allowReactions} onChange={set("allowReactions")} />
          Allow reactions
        </label>
        <label>
          <input type="checkbox" checked={form.memoryEnabled} onChange={set("memoryEnabled")} />
          Memory enabled
        </label>
      </div>

      <label htmlFor="provider">LLM provider</label>
      <select id="provider" value={form.provider} onChange={set("provider")}>
        <option value="openai">openai</option>
        <option value="anthropic">anthropic</option>
      </select>

      <label htmlFor="model">Model</label>
      <input
        id="model"
        type="text"
        placeholder="gpt-4.1-mini / claude-3-5-haiku-latest"
        value={form.model}
        onChange={set("model")}
      />

      <div className="split">
        <div>
          <label htmlFor="temperature">Temperature</label>
          <input
            id="temperature"
            type="number"
            min="0"
            max="2"
            step="0.1"
            value={form.temperature}
            onChange={set("temperature")}
          />
        </div>
        <div>
          <label htmlFor="max-tokens">Max output tokens</label>
          <input
            id="max-tokens"
            type="number"
            min="32"
            max="1400"
            step="1"
            value={form.maxTokens}
            onChange={set("maxTokens")}
          />
        </div>
      </div>

      <div className="split">
        <div>
          <label htmlFor="max-messages">Max bot messages/hour</label>
          <input
            id="max-messages"
            type="number"
            min="1"
            max="200"
            value={form.maxMessages}
            onChange={set("maxMessages")}
          />
        </div>
        <div>
          <label htmlFor="max-reactions">Max reactions/hour</label>
          <input
            id="max-reactions"
            type="number"
            min="1"
            max="300"
            value={form.maxReactions}
            onChange={set("maxReactions")}
          />
        </div>
      </div>

      <div className="split">
        <div>
          <label htmlFor="min-gap">Min seconds between bot msgs</label>
          <input
            id="min-gap"
            type="number"
            min="5"
            max="300"
            value={form.minGap}
            onChange={set("minGap")}
          />
        </div>
        <div />
      </div>

      <label htmlFor="initiative-channels">Standalone post channel IDs (only these)</label>
      <textarea
        id="initiative-channels"
        rows="2"
        value={form.initiativeChannels}
        onChange={set("initiativeChannels")}
      />

      <label htmlFor="allowed-channels">Allowed channel IDs (comma/newline)</label>
      <textarea
        id="allowed-channels"
        rows="3"
        value={form.allowedChannels}
        onChange={set("allowedChannels")}
      />

      <label htmlFor="blocked-channels">Blocked channel IDs (comma/newline)</label>
      <textarea
        id="blocked-channels"
        rows="3"
        value={form.blockedChannels}
        onChange={set("blockedChannels")}
      />

      <label htmlFor="blocked-users">Blocked user IDs (comma/newline)</label>
      <textarea
        id="blocked-users"
        rows="3"
        value={form.blockedUsers}
        onChange={set("blockedUsers")}
      />

      <button type="submit" className="cta">Save settings</button>

      {toast.text && (
        <p className={`status-msg ${toast.type}`}>{toast.text}</p>
      )}
    </form>
  );
}
