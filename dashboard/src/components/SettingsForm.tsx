import React, { useState, useEffect } from "react";
import {
  CUSTOM_MODEL_OPTION_VALUE,
  formToSettingsPatch,
  resolvePresetModelSelection,
  resolveProviderModelOptions,
  settingsToForm
} from "../settingsFormModel";
import { CoreBehaviorSettingsSection } from "./settingsSections/CoreBehaviorSettingsSection";
import { PromptGuidanceSettingsSection } from "./settingsSections/PromptGuidanceSettingsSection";
import { LlmConfigurationSettingsSection } from "./settingsSections/LlmConfigurationSettingsSection";
import { WebSearchSettingsSection } from "./settingsSections/WebSearchSettingsSection";
import { VideoContextSettingsSection } from "./settingsSections/VideoContextSettingsSection";
import { VoiceModeSettingsSection } from "./settingsSections/VoiceModeSettingsSection";
import { RateLimitsSettingsSection } from "./settingsSections/RateLimitsSettingsSection";
import { StartupCatchupSettingsSection } from "./settingsSections/StartupCatchupSettingsSection";
import { InitiativeMediaSettingsSection } from "./settingsSections/InitiativeMediaSettingsSection";
import { ChannelsPermissionsSettingsSection } from "./settingsSections/ChannelsPermissionsSettingsSection";

export default function SettingsForm({ settings, modelCatalog, onSave, toast }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(() => (settings ? settingsToForm(settings) : null));

  useEffect(() => {
    if (!settings) return;
    setForm((current) => ({
      ...(current || {}),
      ...settingsToForm(settings)
    }));
  }, [settings]);

  if (!form) return null;

  const {
    options: providerModelOptions,
    isClaudeCodeProvider,
    selectedPresetModel
  } = resolvePresetModelSelection({
    modelCatalog,
    provider: form.provider,
    model: form.model
  });
  const {
    options: replyFollowupModelOptions,
    isClaudeCodeProvider: isReplyFollowupClaudeCodeProvider,
    selectedPresetModel: selectedReplyFollowupPresetModel
  } = resolvePresetModelSelection({
    modelCatalog,
    provider: form.replyFollowupLlmProvider,
    model: form.replyFollowupLlmModel
  });
  const {
    options: memoryLlmModelOptions,
    isClaudeCodeProvider: isMemoryLlmClaudeCodeProvider,
    selectedPresetModel: selectedMemoryLlmPresetModel
  } = resolvePresetModelSelection({
    modelCatalog,
    provider: form.memoryLlmProvider,
    model: form.memoryLlmModel
  });
  const {
    options: voiceReplyDecisionModelOptions,
    isClaudeCodeProvider: isVoiceReplyDecisionClaudeCodeProvider,
    selectedPresetModel: selectedVoiceReplyDecisionPresetModel
  } = resolvePresetModelSelection({
    modelCatalog,
    provider: form.voiceReplyDecisionLlmProvider,
    model: form.voiceReplyDecisionLlmModel
  });
  const isVoiceAgentMode = form.voiceMode === "voice_agent";
  const isOpenAiRealtimeMode = form.voiceMode === "openai_realtime";
  const isGeminiRealtimeMode = form.voiceMode === "gemini_realtime";
  const isSttPipelineMode = form.voiceMode === "stt_pipeline";
  const showVoiceAdvanced = form.voiceEnabled;
  const showInitiativeAdvanced = form.autonomousInitiativeEnabled;
  const showInitiativeImageControls = form.initiativeImageEnabled || form.replyImageEnabled;
  const showInitiativeVideoControls = form.initiativeVideoEnabled || form.replyVideoEnabled;

  function set(key) {
    return (e) => setForm((f) => ({ ...f, [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  }

  function setProviderWithPresetFallback(providerField, modelField, provider) {
    setForm((current) => {
      const next = { ...current, [providerField]: provider };
      if (provider !== "claude-code") return next;
      const options = resolveProviderModelOptions(modelCatalog, provider);
      const currentModel = String(current?.[modelField] || "").trim();
      if (options.includes(currentModel)) return next;
      next[modelField] = options[0] || "sonnet";
      return next;
    });
  }

  function setProvider(e) {
    const provider = String(e.target.value || "").trim();
    setProviderWithPresetFallback("provider", "model", provider);
  }

  function setMemoryLlmProvider(e) {
    const provider = String(e.target.value || "").trim();
    setProviderWithPresetFallback("memoryLlmProvider", "memoryLlmModel", provider);
  }

  function setReplyFollowupProvider(e) {
    const provider = String(e.target.value || "").trim();
    setProviderWithPresetFallback("replyFollowupLlmProvider", "replyFollowupLlmModel", provider);
  }

  function setVoiceReplyDecisionProvider(e) {
    const provider = String(e.target.value || "").trim();
    setProviderWithPresetFallback("voiceReplyDecisionLlmProvider", "voiceReplyDecisionLlmModel", provider);
  }

  function selectModelFieldPreset(modelField, selected) {
    if (selected === CUSTOM_MODEL_OPTION_VALUE) return;
    setForm((current) => ({ ...current, [modelField]: selected }));
  }

  function selectPresetModel(e) {
    selectModelFieldPreset("model", String(e.target.value || ""));
  }

  function selectReplyFollowupPresetModel(e) {
    selectModelFieldPreset("replyFollowupLlmModel", String(e.target.value || ""));
  }

  function selectMemoryLlmPresetModel(e) {
    selectModelFieldPreset("memoryLlmModel", String(e.target.value || ""));
  }

  function selectVoiceReplyDecisionPresetModel(e) {
    selectModelFieldPreset("voiceReplyDecisionLlmModel", String(e.target.value || ""));
  }

  function submit(e) {
    e.preventDefault();
    onSave(formToSettingsPatch(form));
  }

  return (
    <form className={`panel settings-form${open ? " settings-open" : ""}`} onSubmit={submit}>
      <button type="button" className="settings-panel-toggle" onClick={() => setOpen((o) => !o)}>
        <span className="section-arrow">&#x25B8;</span>
        <h3>Settings</h3>
      </button>

      {open && (
        <>
          <CoreBehaviorSettingsSection form={form} set={set} />
          <PromptGuidanceSettingsSection form={form} set={set} />

          <LlmConfigurationSettingsSection
            form={form}
            set={set}
            setProvider={setProvider}
            selectPresetModel={selectPresetModel}
            providerModelOptions={providerModelOptions}
            isClaudeCodeProvider={isClaudeCodeProvider}
            selectedPresetModel={selectedPresetModel}
            setReplyFollowupProvider={setReplyFollowupProvider}
            selectReplyFollowupPresetModel={selectReplyFollowupPresetModel}
            replyFollowupModelOptions={replyFollowupModelOptions}
            isReplyFollowupClaudeCodeProvider={isReplyFollowupClaudeCodeProvider}
            selectedReplyFollowupPresetModel={selectedReplyFollowupPresetModel}
            setMemoryLlmProvider={setMemoryLlmProvider}
            selectMemoryLlmPresetModel={selectMemoryLlmPresetModel}
            memoryLlmModelOptions={memoryLlmModelOptions}
            isMemoryLlmClaudeCodeProvider={isMemoryLlmClaudeCodeProvider}
            selectedMemoryLlmPresetModel={selectedMemoryLlmPresetModel}
          />

          <WebSearchSettingsSection form={form} set={set} />
          <VideoContextSettingsSection form={form} set={set} />

          <VoiceModeSettingsSection
            form={form}
            set={set}
            showVoiceAdvanced={showVoiceAdvanced}
            isVoiceAgentMode={isVoiceAgentMode}
            isOpenAiRealtimeMode={isOpenAiRealtimeMode}
            isGeminiRealtimeMode={isGeminiRealtimeMode}
            isSttPipelineMode={isSttPipelineMode}
            setVoiceReplyDecisionProvider={setVoiceReplyDecisionProvider}
            selectVoiceReplyDecisionPresetModel={selectVoiceReplyDecisionPresetModel}
            voiceReplyDecisionModelOptions={voiceReplyDecisionModelOptions}
            isVoiceReplyDecisionClaudeCodeProvider={isVoiceReplyDecisionClaudeCodeProvider}
            selectedVoiceReplyDecisionPresetModel={selectedVoiceReplyDecisionPresetModel}
          />

          <RateLimitsSettingsSection form={form} set={set} />
          <StartupCatchupSettingsSection form={form} set={set} />

          <InitiativeMediaSettingsSection
            form={form}
            set={set}
            showInitiativeAdvanced={showInitiativeAdvanced}
            showInitiativeImageControls={showInitiativeImageControls}
            showInitiativeVideoControls={showInitiativeVideoControls}
          />

          <ChannelsPermissionsSettingsSection form={form} set={set} />

          <div className="save-bar">
            <button type="submit" className="cta">Save settings</button>
            {toast.text && (
              <p className={`status-msg ${toast.type}`}>{toast.text}</p>
            )}
          </div>
        </>
      )}
    </form>
  );
}
