import React, { useState } from "react";
import { interpolatePromptTemplate } from "../promptTemplate";

function ScenarioSection({ title, prompt }) {
  if (!prompt) return null;
  return (
    <div className="full-prompt-scenario">
      <div className="full-prompt-scenario-title">{title}</div>
      <pre className="full-prompt-scenario-content">{prompt}</pre>
    </div>
  );
}

export function FullPromptPreview({ form }) {
  const [expanded, setExpanded] = useState(false);
  const botName = form.botName || "clanker conk";

  const voiceLookupBusy = interpolatePromptTemplate(form.promptVoiceLookupBusySystemPrompt, { botName });
  const voiceReplyWakeVariant = interpolatePromptTemplate(form.voiceReplyDecisionWakeVariantHint, { botName });
  const voiceReplyDecision = interpolatePromptTemplate(form.voiceReplyDecisionSystemPromptCompact, { botName });
  const textGuidance = interpolatePromptTemplate(form.promptTextGuidance, { botName });
  const voiceGuidance = interpolatePromptTemplate(form.promptVoiceGuidance, { botName });
  const voiceOperationalGuidance = interpolatePromptTemplate(form.promptVoiceOperationalGuidance, { botName });
  const capabilityHonesty = interpolatePromptTemplate(form.promptCapabilityHonestyLine, { botName });
  const impossibleAction = interpolatePromptTemplate(form.promptImpossibleActionLine, { botName });
  const memoryEnabled = interpolatePromptTemplate(form.promptMemoryEnabledLine, { botName });
  const memoryDisabled = interpolatePromptTemplate(form.promptMemoryDisabledLine, { botName });
  const skipLine = interpolatePromptTemplate(form.promptSkipLine, { botName });
  const mediaGuidance = interpolatePromptTemplate(form.promptMediaPromptCraftGuidance, { botName });

  const hasAnyPrompts =
    voiceLookupBusy ||
    voiceReplyWakeVariant ||
    voiceReplyDecision ||
    textGuidance ||
    voiceGuidance ||
    voiceOperationalGuidance ||
    capabilityHonesty ||
    impossibleAction ||
    memoryEnabled ||
    memoryDisabled ||
    skipLine ||
    mediaGuidance;

  if (!hasAnyPrompts) return null;

  return (
    <div className="full-prompt-preview-wrap">
      <button
        type="button"
        className="full-prompt-preview-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? "▼" : "▶"} Full Prompt Preview
      </button>
      {expanded && (
        <div className="full-prompt-preview-content">
          <ScenarioSection title="Voice Lookup Busy" prompt={voiceLookupBusy} />
          <ScenarioSection title="Voice Reply Wake Variant" prompt={voiceReplyWakeVariant} />
          <ScenarioSection title="Voice Reply Decision" prompt={voiceReplyDecision} />
          <ScenarioSection title="Text Guidance" prompt={textGuidance} />
          <ScenarioSection title="Voice Guidance" prompt={voiceGuidance} />
          <ScenarioSection title="Voice Operational Guidance" prompt={voiceOperationalGuidance} />
          <ScenarioSection title="Capability Honesty" prompt={capabilityHonesty} />
          <ScenarioSection title="Impossible Action" prompt={impossibleAction} />
          <ScenarioSection title="Memory Enabled" prompt={memoryEnabled} />
          <ScenarioSection title="Memory Disabled" prompt={memoryDisabled} />
          <ScenarioSection title="Skip Directive" prompt={skipLine} />
          <ScenarioSection title="Media Guidance" prompt={mediaGuidance} />
        </div>
      )}
    </div>
  );
}
