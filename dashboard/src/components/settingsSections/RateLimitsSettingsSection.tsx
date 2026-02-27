import { SettingsSection } from "../SettingsSection";

export function RateLimitsSettingsSection({ form, set }) {
  return (
    <SettingsSection title="Rate Limits">
      <div className="split-3">
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
      </div>
    </SettingsSection>
  );
}
