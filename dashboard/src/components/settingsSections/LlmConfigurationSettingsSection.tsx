import React from "react";
import { CUSTOM_MODEL_OPTION_VALUE } from "../../settingsFormModel";
import { SettingsSection } from "../SettingsSection";

export function LlmConfigurationSettingsSection({
  id,
  form,
  set,
  setProvider,
  selectPresetModel,
  providerModelOptions,
  isClaudeCodeProvider,
  selectedPresetModel,
  setReplyFollowupProvider,
  selectReplyFollowupPresetModel,
  replyFollowupModelOptions,
  isReplyFollowupClaudeCodeProvider,
  selectedReplyFollowupPresetModel,
  setMemoryLlmProvider,
  selectMemoryLlmPresetModel,
  memoryLlmModelOptions,
  isMemoryLlmClaudeCodeProvider,
  selectedMemoryLlmPresetModel
}) {
  return (
    <SettingsSection id={id} title="LLM Configuration">
      <label htmlFor="provider">LLM provider</label>
      <select id="provider" value={form.provider} onChange={setProvider}>
        <option value="openai">openai</option>
        <option value="anthropic">anthropic</option>
        <option value="xai">xai (grok)</option>
        <option value="claude-code">claude code (local)</option>
      </select>

      <label htmlFor="model-preset">Model Preset (priced models)</label>
      <select id="model-preset" value={selectedPresetModel} onChange={selectPresetModel}>
        {providerModelOptions.map((modelId) => (
          <option key={modelId} value={modelId}>
            {modelId}
          </option>
        ))}
        {!isClaudeCodeProvider && <option value={CUSTOM_MODEL_OPTION_VALUE}>custom model (manual)</option>}
      </select>

      <label htmlFor="model">Model ID</label>
      <input
        id="model"
        type="text"
        placeholder="gpt-4.1-mini / claude-haiku-4-5 / grok-3-mini-latest"
        value={form.model}
        onChange={set("model")}
        disabled={isClaudeCodeProvider}
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
            <option value="openai">openai</option>
            <option value="anthropic">anthropic</option>
            <option value="xai">xai (grok)</option>
            <option value="claude-code">claude code (local)</option>
          </select>
        </div>
        <div>
          <label htmlFor="reply-followup-llm-model-preset">Model Preset</label>
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
            {!isReplyFollowupClaudeCodeProvider && (
              <option value={CUSTOM_MODEL_OPTION_VALUE}>custom model (manual)</option>
            )}
          </select>
        </div>
      </div>
      <label htmlFor="reply-followup-llm-model">Model ID</label>
      <input
        id="reply-followup-llm-model"
        type="text"
        value={form.replyFollowupLlmModel}
        onChange={set("replyFollowupLlmModel")}
        disabled={!form.replyFollowupLlmEnabled || isReplyFollowupClaudeCodeProvider}
      />

      <h4>Memory Extraction LLM</h4>
      <p>Used for durable fact extraction (`memory_extract_call`).</p>
      <div className="split">
        <div>
          <label htmlFor="memory-llm-provider">Provider</label>
          <select id="memory-llm-provider" value={form.memoryLlmProvider} onChange={setMemoryLlmProvider}>
            <option value="openai">openai</option>
            <option value="anthropic">anthropic</option>
            <option value="xai">xai (grok)</option>
            <option value="claude-code">claude code (local)</option>
          </select>
        </div>
        <div>
          <label htmlFor="memory-llm-model-preset">Model Preset</label>
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
            {!isMemoryLlmClaudeCodeProvider && (
              <option value={CUSTOM_MODEL_OPTION_VALUE}>custom model (manual)</option>
            )}
          </select>
        </div>
      </div>
      <label htmlFor="memory-llm-model">Model ID</label>
      <input
        id="memory-llm-model"
        type="text"
        value={form.memoryLlmModel}
        onChange={set("memoryLlmModel")}
        disabled={isMemoryLlmClaudeCodeProvider}
      />
    </SettingsSection>
  );
}
