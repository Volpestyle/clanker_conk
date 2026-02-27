import { SettingsSection } from "../SettingsSection";

export function CoreBehaviorSettingsSection({ form, set }) {
  return (
    <SettingsSection title="Core Behavior">
      <label htmlFor="bot-name">Bot display name</label>
      <input id="bot-name" type="text" value={form.botName} onChange={set("botName")} />

      <label htmlFor="persona-flavor">Persona flavor</label>
      <textarea
        id="persona-flavor"
        rows="3"
        value={form.personaFlavor}
        onChange={set("personaFlavor")}
      />

      <label htmlFor="persona-hard-limits">Persona hard limits (one per line)</label>
      <textarea
        id="persona-hard-limits"
        rows="4"
        value={form.personaHardLimits}
        onChange={set("personaHardLimits")}
      />

      <label htmlFor="reply-level-initiative">
        Unsolicited reply eagerness (initiative channels): <strong>{form.replyLevelInitiative}%</strong>
      </label>
      <input
        id="reply-level-initiative"
        type="range"
        min="0"
        max="100"
        step="1"
        value={form.replyLevelInitiative}
        onChange={set("replyLevelInitiative")}
      />

      <label htmlFor="reply-level-non-initiative">
        Unsolicited reply eagerness (non-initiative channels): <strong>{form.replyLevelNonInitiative}%</strong>
      </label>
      <input
        id="reply-level-non-initiative"
        type="range"
        min="0"
        max="100"
        step="1"
        value={form.replyLevelNonInitiative}
        onChange={set("replyLevelNonInitiative")}
      />

      <label htmlFor="reaction-level">
        Reaction eagerness: <strong>{form.reactionLevel}%</strong>
      </label>
      <input
        id="reaction-level"
        type="range"
        min="0"
        max="100"
        step="1"
        value={form.reactionLevel}
        onChange={set("reactionLevel")}
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
    </SettingsSection>
  );
}
