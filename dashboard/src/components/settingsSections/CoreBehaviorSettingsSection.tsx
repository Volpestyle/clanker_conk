import React, { useMemo } from "react";
import { SettingsSection } from "../SettingsSection";
import { rangeStyle } from "../../utils";

/* ── Behavior overlay presets ── */

interface OverlayPreset {
  value: string;
  label: string;
  fields: Record<string, string>;
}

const TEXT_TONE_PRESETS: OverlayPreset[] = [
  {
    value: "default",
    label: "Default",
    fields: {
      promptTextGuidance: [
        "Write like a person in chat, not like an assistant.",
        "If you don't know something, just say so. Ask questions when you're genuinely curious.",
        "Use server emoji tokens in text only when necessary and when they enhance the message."
      ].join("\n")
    }
  },
  {
    value: "concise",
    label: "Concise",
    fields: {
      promptTextGuidance: [
        "Keep messages short. One or two sentences max unless the question demands detail.",
        "Skip pleasantries and filler. Get to the point.",
        "If you don't know, say so in one line."
      ].join("\n")
    }
  },
  {
    value: "conversational",
    label: "Conversational",
    fields: {
      promptTextGuidance: [
        "Write like a friend chatting. Be warm, curious, and engaging.",
        "Ask follow-up questions. Show genuine interest in what people are saying.",
        "Use casual language, humor, and reactions naturally.",
        "If you don't know something, say so and riff on it."
      ].join("\n")
    }
  },
  {
    value: "expressive",
    label: "Expressive",
    fields: {
      promptTextGuidance: [
        "Be colorful and enthusiastic. Use vivid language and strong reactions.",
        "Show personality in every message. Be opinionated, playful, and surprising.",
        "Use emoji and formatting when they amplify the energy.",
        "Ask bold questions. Push conversations into interesting territory."
      ].join("\n")
    }
  }
];

const VOICE_TONE_PRESETS: OverlayPreset[] = [
  {
    value: "default",
    label: "Default",
    fields: {
      promptVoiceGuidance: [
        "Talk like a person hanging out, not like an assistant.",
        "Be open, direct, and helpful whenever it makes sense.",
        "Ask questions when you're curious or when it keeps the conversation moving.",
        "Give exciting, humorous and silly  reactions to screen shares when it feels right."
      ].join("\n")
    }
  },
  {
    value: "terse",
    label: "Terse",
    fields: {
      promptVoiceGuidance: [
        "Keep responses extremely short. A few words or one sentence.",
        "Don't elaborate unless asked. Answer directly.",
        "Silence is fine. Don't fill dead air."
      ].join("\n")
    }
  },
  {
    value: "warm",
    label: "Warm & Engaged",
    fields: {
      promptVoiceGuidance: [
        "Sound like a close friend on a call. Warm, attentive, and present.",
        "React naturally to what people say. Laugh, agree, push back.",
        "Ask questions that show you're actually listening.",
        "Be comfortable with tangents and casual banter."
      ].join("\n")
    }
  },
  {
    value: "storyteller",
    label: "Storyteller",
    fields: {
      promptVoiceGuidance: [
        "Paint pictures with your words. Be vivid and captivating.",
        "Build on what others say with interesting connections and anecdotes.",
        "Use dramatic pauses and varied energy. Keep people engaged.",
        "When reacting to screen shares, narrate what you see with flair."
      ].join("\n")
    }
  }
];

const HONESTY_PRESETS: OverlayPreset[] = [
  {
    value: "default",
    label: "Default",
    fields: {
      promptCapabilityHonestyLine: "Never claim capabilities you do not have.",
      promptImpossibleActionLine:
        "If asked to do something impossible, say it plainly and suggest a practical text-only alternative."
    }
  },
  {
    value: "gentle",
    label: "Gentle Redirect",
    fields: {
      promptCapabilityHonestyLine:
        "Be honest about what you can and cannot do, but frame limitations positively.",
      promptImpossibleActionLine:
        "If asked to do something impossible, acknowledge the intent warmly and offer the closest thing you can actually do."
    }
  },
  {
    value: "playful",
    label: "Playful Deflection",
    fields: {
      promptCapabilityHonestyLine:
        "Be upfront about your limits, but have fun with it. A little humor goes a long way.",
      promptImpossibleActionLine:
        "If asked to do something impossible, joke about it briefly, then redirect to something you can actually help with."
    }
  },
  {
    value: "strict",
    label: "Strict Boundaries",
    fields: {
      promptCapabilityHonestyLine:
        "State your exact capabilities and limits without hedging or softening.",
      promptImpossibleActionLine:
        "If asked to do something impossible, state clearly that it cannot be done and why. Do not offer workarounds unless directly applicable."
    }
  }
];

const OPERATIONAL_PRESETS: OverlayPreset[] = [
  {
    value: "default",
    label: "Default",
    fields: {
      promptVoiceOperationalGuidance: [
        "Keep it clear and simple. No overexplaining.",
        "Clearly state what happened and why, especially when a request is blocked.",
        "If relevant, mention required permissions/settings plainly.",
        "Avoid dramatic wording, blame, apology spirals, and long postmortems."
      ].join("\n")
    }
  },
  {
    value: "minimal",
    label: "Minimal",
    fields: {
      promptVoiceOperationalGuidance: [
        "One sentence max for operational messages.",
        "State only the outcome. Skip the explanation unless asked.",
        "Never apologize for operational outcomes."
      ].join("\n")
    }
  },
  {
    value: "informative",
    label: "Informative",
    fields: {
      promptVoiceOperationalGuidance: [
        "Explain what happened, why, and what options exist.",
        "Be specific about permissions, settings, or conditions that affected the outcome.",
        "Keep the tone neutral and factual. No drama.",
        "Mention relevant settings by name so operators know what to adjust."
      ].join("\n")
    }
  },
  {
    value: "verbose",
    label: "Verbose & Helpful",
    fields: {
      promptVoiceOperationalGuidance: [
        "Give thorough explanations of what happened and the full context.",
        "Proactively suggest next steps and alternative approaches.",
        "Mention specific settings, permissions, and system state that affected the result.",
        "Walk users through the resolution path step by step if they seem confused."
      ].join("\n")
    }
  }
];

function matchPreset(presets: OverlayPreset[], form: Record<string, unknown>): string {
  for (const preset of presets) {
    const match = Object.entries(preset.fields).every(
      ([key, val]) => String(form[key] || "").trim() === String(val).trim()
    );
    if (match) return preset.value;
  }
  return "__custom__";
}

function OverlaySelect({
  label,
  presets,
  form,
  onApply,
  hint
}: {
  label: string;
  presets: OverlayPreset[];
  form: Record<string, unknown>;
  onApply: (fields: Record<string, string>) => void;
  hint: string;
}) {
  const current = useMemo(() => matchPreset(presets, form), [presets, form]);
  const isCustom = current === "__custom__";

  return (
    <div className="overlay-select">
      <label className="overlay-select-label">{label}</label>
      <select
        className="overlay-select-input"
        value={current}
        onChange={(e) => {
          const preset = presets.find((p) => p.value === e.target.value);
          if (preset) onApply(preset.fields);
        }}
      >
        {isCustom && <option value="__custom__" disabled>Custom</option>}
        {presets.map((p) => (
          <option key={p.value} value={p.value}>{p.label}</option>
        ))}
      </select>
      <p className="overlay-select-hint">
        {isCustom ? "Customized in Prompt Lab." : hint}
      </p>
    </div>
  );
}

export function CoreBehaviorSettingsSection({ id, form, set, onSanitizeBotNameAliases, onApplyOverlay }) {
  return (
    <SettingsSection id={id} title="Behavior">
      <label htmlFor="bot-name">Bot display name</label>
      <input id="bot-name" type="text" value={form.botName} onChange={set("botName")} />

      <label htmlFor="bot-name-aliases">Bot aliases/nicknames (comma separated)</label>
      <textarea
        id="bot-name-aliases"
        rows={4}
        value={form.botNameAliases}
        onChange={set("botNameAliases")}
        onBlur={onSanitizeBotNameAliases}
      />

      <label htmlFor="persona-flavor">Persona flavor</label>
      <textarea
        id="persona-flavor"
        rows={3}
        value={form.personaFlavor}
        onChange={set("personaFlavor")}
      />

      <label htmlFor="persona-hard-limits">Persona hard limits (one per line)</label>
      <textarea
        id="persona-hard-limits"
        rows={4}
        value={form.personaHardLimits}
        onChange={set("personaHardLimits")}
      />

      <h4>Tone & Style</h4>
      <div className="overlay-grid">
        <OverlaySelect
          label="Text tone"
          presets={TEXT_TONE_PRESETS}
          form={form}
          onApply={onApplyOverlay}
          hint="How the bot writes in text channels."
        />
        <OverlaySelect
          label="Voice tone"
          presets={VOICE_TONE_PRESETS}
          form={form}
          onApply={onApplyOverlay}
          hint="How the bot talks in voice."
        />
        <OverlaySelect
          label="Honesty style"
          presets={HONESTY_PRESETS}
          form={form}
          onApply={onApplyOverlay}
          hint="How the bot handles requests it can't fulfill."
        />
        <OverlaySelect
          label="Operational verbosity"
          presets={OPERATIONAL_PRESETS}
          form={form}
          onApply={onApplyOverlay}
          hint="How verbose operational/system messages are in voice."
        />
      </div>

      <label htmlFor="text-ambient-reply-eagerness">
        Text ambient reply eagerness: <strong>{form.textAmbientReplyEagerness}%</strong>
      </label>
      <input
        id="text-ambient-reply-eagerness"
        type="range"
        min="0"
        max="100"
        step="1"
        value={form.textAmbientReplyEagerness}
        onChange={set("textAmbientReplyEagerness")}
        style={rangeStyle(form.textAmbientReplyEagerness)}
      />
      <p>
        How willing the bot is to surface an ambient text reply when nobody has directly pulled it in yet. Higher values widen colder ambient participation.
      </p>

      <label htmlFor="response-window-eagerness">
        Response window eagerness: <strong>{form.responseWindowEagerness}%</strong>
      </label>
      <input
        id="response-window-eagerness"
        type="range"
        min="0"
        max="100"
        step="1"
        value={form.responseWindowEagerness}
        onChange={set("responseWindowEagerness")}
        style={rangeStyle(form.responseWindowEagerness)}
      />
      <p>
        How sticky `ACTIVE` follow-up conversations are after the bot was recently engaged. Higher values keep it in the thread longer before it fades back to ambient.
      </p>

      <label htmlFor="text-initiative-eagerness">
        Ambient text thought eagerness: <strong>{form.textInitiativeEagerness}%</strong>
      </label>
      <input
        id="text-initiative-eagerness"
        type="range"
        min="0"
        max="100"
        step="1"
        value={form.textInitiativeEagerness}
        onChange={set("textInitiativeEagerness")}
        style={rangeStyle(form.textInitiativeEagerness)}
      />
      <p>
        This gates how often the bot even considers surfacing an ambient text thought on its own. The model still decides whether to post, where to post, or to skip.
      </p>

      <label htmlFor="reactivity">
        Reactivity: <strong>{form.reactivity}%</strong>
      </label>
      <input
        id="reactivity"
        type="range"
        min="0"
        max="100"
        step="1"
        value={form.reactivity}
        onChange={set("reactivity")}
        style={rangeStyle(form.reactivity)}
      />
      <p>
        Shared tendency for emoji reactions, soundboard bits, and other light acknowledgements that should not be governed by the main reply knobs.
      </p>

      <div className="toggles">
        <label>
          <input type="checkbox" checked={form.allowReplies} onChange={set("allowReplies")} />
          Allow replies
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.allowUnsolicitedReplies}
            onChange={set("allowUnsolicitedReplies")}
          />
          Allow unsolicited replies
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.textInitiativeEnabled}
            onChange={set("textInitiativeEnabled")}
          />
          Enable ambient text thoughts
        </label>
        <label>
          <input type="checkbox" checked={form.allowReactions} onChange={set("allowReactions")} />
          Allow reactions
        </label>
        <label>
          <input type="checkbox" checked={form.memoryEnabled} onChange={set("memoryEnabled")} />
          Durable memory enabled
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.automationsEnabled}
            onChange={set("automationsEnabled")}
          />
          Automations enabled
        </label>
      </div>

      {form.textInitiativeEnabled && (
        <div className="split">
          <div>
            <label htmlFor="text-initiative-min-minutes">Min minutes between ambient text considerations</label>
            <input
              id="text-initiative-min-minutes"
              type="number"
              min="1"
              max="1440"
              value={form.textInitiativeMinMinutesBetweenPosts}
              onChange={set("textInitiativeMinMinutesBetweenPosts")}
            />
          </div>
          <div>
            <label htmlFor="text-initiative-max-per-day">Max ambient text posts/day</label>
            <input
              id="text-initiative-max-per-day"
              type="number"
              min="0"
              max="100"
              value={form.textInitiativeMaxPostsPerDay}
              onChange={set("textInitiativeMaxPostsPerDay")}
            />
          </div>
        </div>
      )}

      {form.textInitiativeEnabled && (
        <>
          <div className="split">
            <div>
              <label htmlFor="text-initiative-lookback">Recent messages to inspect per ambient-text channel</label>
              <input
                id="text-initiative-lookback"
                type="number"
                min="4"
                max="80"
                value={form.textInitiativeLookbackMessages}
                onChange={set("textInitiativeLookbackMessages")}
              />
            </div>
            <div>
              <label htmlFor="text-initiative-max-tool-steps">Max ambient text tool-loop steps</label>
              <input
                id="text-initiative-max-tool-steps"
                type="number"
                min="0"
                max="8"
                value={form.textInitiativeMaxToolSteps}
                onChange={set("textInitiativeMaxToolSteps")}
              />
            </div>
          </div>

          <div className="split">
            <div>
              <label htmlFor="text-initiative-max-tool-calls">Max ambient text tool calls</label>
              <input
                id="text-initiative-max-tool-calls"
                type="number"
                min="0"
                max="12"
                value={form.textInitiativeMaxToolCalls}
                onChange={set("textInitiativeMaxToolCalls")}
              />
            </div>
            <div className="toggles" style={{ alignItems: "end" }}>
              <label>
                <input
                  type="checkbox"
                  checked={form.textInitiativeAllowActiveCuriosity}
                  onChange={set("textInitiativeAllowActiveCuriosity")}
                />
                Allow active curiosity tools (`web_search`, `web_scrape`, `browser_browse`)
              </label>
            </div>
          </div>
        </>
      )}
    </SettingsSection>
  );
}
