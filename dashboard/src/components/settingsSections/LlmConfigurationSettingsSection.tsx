import React from "react";
import { SettingsSection } from "../SettingsSection";
import { LlmProviderOptions } from "./LlmProviderOptions";

export function LlmConfigurationSettingsSection({
  id,
  form,
  set,
  setProvider,
  selectPresetModel,
  providerModelOptions,
  selectedPresetModel,
  setReplyFollowupProvider,
  selectReplyFollowupPresetModel,
  replyFollowupModelOptions,
  selectedReplyFollowupPresetModel,
  setMemoryLlmProvider,
  selectMemoryLlmPresetModel,
  memoryLlmModelOptions,
  selectedMemoryLlmPresetModel
}) {
  return (
    <SettingsSection id={id} title="LLM Configuration">
      <label htmlFor="provider">LLM provider</label>
      <select id="provider" value={form.provider} onChange={setProvider}>
        <LlmProviderOptions />
      </select>

      <label htmlFor="model-preset">Model ID</label>
      <select id="model-preset" value={selectedPresetModel} onChange={selectPresetModel}>
        {providerModelOptions.map((modelId) => (
          <option key={modelId} value={modelId}>
            {modelId}
          </option>
        ))}
      </select>

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

      <h4>Reply Follow-Up Regeneration LLM</h4>
      <p>Optional override for second-pass reply regeneration (web search / memory lookup follow-ups).</p>
      <div className="toggles">
        <label>
          <input
            type="checkbox"
            checked={form.replyFollowupLlmEnabled}
            onChange={set("replyFollowupLlmEnabled")}
          />
          Use separate follow-up LLM
        </label>
      </div>
      <div className="split">
        <div>
          <label htmlFor="reply-followup-llm-provider">Provider</label>
          <select
            id="reply-followup-llm-provider"
            value={form.replyFollowupLlmProvider}
            onChange={setReplyFollowupProvider}
            disabled={!form.replyFollowupLlmEnabled}
          >
            <LlmProviderOptions />
          </select>
        </div>
        <div>
          <label htmlFor="reply-followup-llm-model-preset">Model ID</label>
          <select
            id="reply-followup-llm-model-preset"
            value={selectedReplyFollowupPresetModel}
            onChange={selectReplyFollowupPresetModel}
            disabled={!form.replyFollowupLlmEnabled}
          >
            {replyFollowupModelOptions.map((modelId) => (
              <option key={modelId} value={modelId}>
                {modelId}
              </option>
            ))}
          </select>
        </div>
      </div>

      <h4>Memory Extraction LLM</h4>
      <p>Used for durable fact extraction (`memory_extract_call`).</p>
      <div className="split">
        <div>
          <label htmlFor="memory-llm-provider">Provider</label>
          <select id="memory-llm-provider" value={form.memoryLlmProvider} onChange={setMemoryLlmProvider}>
            <LlmProviderOptions />
          </select>
        </div>
        <div>
          <label htmlFor="memory-llm-model-preset">Model ID</label>
          <select
            id="memory-llm-model-preset"
            value={selectedMemoryLlmPresetModel}
            onChange={selectMemoryLlmPresetModel}
          >
            {memoryLlmModelOptions.map((modelId) => (
              <option key={modelId} value={modelId}>
                {modelId}
              </option>
            ))}
          </select>
        </div>
      </div>
    </SettingsSection>
  );
}
