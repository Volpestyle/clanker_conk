import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  CUSTOM_MODEL_OPTION_VALUE,
  formToSettingsPatch,
  resolvePresetModelSelection,
  resolveProviderModelOptions,
  settingsToForm
} from "../settingsFormModel";
import { useActiveSection } from "../hooks/useActiveSection";
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

const SECTIONS = [
  { id: "sec-core", label: "Core Behavior" },
  { id: "sec-prompts", label: "Prompts" },
  { id: "sec-llm", label: "LLM Config" },
  { id: "sec-search", label: "Web Search" },
  { id: "sec-video", label: "Video Context" },
  { id: "sec-voice", label: "Voice Mode" },
  { id: "sec-rate", label: "Rate Limits" },
  { id: "sec-startup", label: "Startup" },
  { id: "sec-initiative", label: "Initiative" },
  { id: "sec-channels", label: "Channels" },
] as const;

const SECTION_IDS = SECTIONS.map((s) => s.id);

export default function SettingsForm({ settings, modelCatalog, onSave, toast }) {
  const [form, setForm] = useState(() => (settings ? settingsToForm(settings) : null));
  const savedFormRef = useRef<string>("");

  useEffect(() => {
    if (!settings) return;
    const next = settingsToForm(settings);
    setForm((current) => ({ ...(current || {}), ...next }));
    savedFormRef.current = JSON.stringify(next);
  }, [settings]);

  const activeSection = useActiveSection(SECTION_IDS);
  const isDirty = useMemo(() => {
    if (!form || !savedFormRef.current) return false;
    return JSON.stringify(form) !== savedFormRef.current;
  }, [form]);

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
    setProviderWithPresetFallback("provider", "model", String(e.target.value || "").trim());
  }

  function setMemoryLlmProvider(e) {
    setProviderWithPresetFallback("memoryLlmProvider", "memoryLlmModel", String(e.target.value || "").trim());
  }

  function setReplyFollowupProvider(e) {
    setProviderWithPresetFallback("replyFollowupLlmProvider", "replyFollowupLlmModel", String(e.target.value || "").trim());
  }

  function setVoiceReplyDecisionProvider(e) {
    setProviderWithPresetFallback("voiceReplyDecisionLlmProvider", "voiceReplyDecisionLlmModel", String(e.target.value || "").trim());
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

  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <form className="panel settings-form" onSubmit={submit}>
      <h3 className="settings-title">Settings</h3>
      <div className="settings-layout">
        <nav className="settings-sidebar">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`settings-nav-item${activeSection === s.id ? " active" : ""}`}
              onClick={() => scrollTo(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          <CoreBehaviorSettingsSection id="sec-core" form={form} set={set} />
          <PromptGuidanceSettingsSection id="sec-prompts" form={form} set={set} />

          <LlmConfigurationSettingsSection
            id="sec-llm"
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

          <WebSearchSettingsSection id="sec-search" form={form} set={set} />
          <VideoContextSettingsSection id="sec-video" form={form} set={set} />

          <VoiceModeSettingsSection
            id="sec-voice"
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

          <RateLimitsSettingsSection id="sec-rate" form={form} set={set} />
          <StartupCatchupSettingsSection id="sec-startup" form={form} set={set} />

          <InitiativeMediaSettingsSection
            id="sec-initiative"
            form={form}
            set={set}
            showInitiativeAdvanced={showInitiativeAdvanced}
            showInitiativeImageControls={showInitiativeImageControls}
            showInitiativeVideoControls={showInitiativeVideoControls}
          />

          <ChannelsPermissionsSettingsSection id="sec-channels" form={form} set={set} />
        </div>
      </div>

      <div className="save-bar">
        <button type="submit" className="cta">
          Save settings
          {isDirty && <span className="unsaved-dot" />}
        </button>
        {toast.text && (
          <p className={`status-msg ${toast.type}`}>{toast.text}</p>
        )}
      </div>
    </form>
  );
}
