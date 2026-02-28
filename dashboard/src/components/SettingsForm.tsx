import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  GEMINI_REALTIME_MODEL_OPTIONS,
  OPENAI_REALTIME_MODEL_OPTIONS,
  OPENAI_TRANSCRIPTION_MODEL_OPTIONS,
  STT_TRANSCRIPTION_MODEL_OPTIONS,
  STT_TTS_MODEL_OPTIONS,
  formToSettingsPatch,
  resolveModelOptions,
  resolveModelOptionsFromText,
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
  const defaultForm = useMemo(() => settingsToForm({}), []);
  const effectiveForm = form ?? defaultForm;

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

  function resolvePresetSelection(providerField, modelField) {
    return resolvePresetModelSelection({
      modelCatalog,
      provider: effectiveForm[providerField],
      model: effectiveForm[modelField]
    });
  }

  const {
    options: providerModelOptions,
    selectedPresetModel
  } = resolvePresetSelection("provider", "model");
  const {
    options: replyFollowupModelOptions,
    selectedPresetModel: selectedReplyFollowupPresetModel
  } = resolvePresetSelection("replyFollowupLlmProvider", "replyFollowupLlmModel");
  const {
    options: memoryLlmModelOptions,
    selectedPresetModel: selectedMemoryLlmPresetModel
  } = resolvePresetSelection("memoryLlmProvider", "memoryLlmModel");
  const {
    options: voiceReplyDecisionModelOptions,
    selectedPresetModel: selectedVoiceReplyDecisionPresetModel
  } = resolvePresetSelection("voiceReplyDecisionLlmProvider", "voiceReplyDecisionLlmModel");
  const {
    options: voiceGenerationModelOptions,
    selectedPresetModel: selectedVoiceGenerationPresetModel
  } = resolvePresetSelection("voiceGenerationLlmProvider", "voiceGenerationLlmModel");
  const openAiRealtimeModelOptions = resolveModelOptions(
    OPENAI_REALTIME_MODEL_OPTIONS,
    effectiveForm.voiceOpenAiRealtimeModel
  );
  const openAiTranscriptionModelOptions = resolveModelOptions(
    OPENAI_TRANSCRIPTION_MODEL_OPTIONS,
    effectiveForm.voiceOpenAiRealtimeInputTranscriptionModel
  );
  const geminiRealtimeModelOptions = resolveModelOptions(
    GEMINI_REALTIME_MODEL_OPTIONS,
    effectiveForm.voiceGeminiRealtimeModel
  );
  const sttTranscriptionModelOptions = resolveModelOptions(
    STT_TRANSCRIPTION_MODEL_OPTIONS,
    effectiveForm.voiceSttTranscriptionModel
  );
  const sttTtsModelOptions = resolveModelOptions(
    STT_TTS_MODEL_OPTIONS,
    effectiveForm.voiceSttTtsModel
  );
  const initiativeImageModelOptions = resolveModelOptionsFromText(
    effectiveForm.initiativeAllowedImageModels,
    effectiveForm.initiativeSimpleImageModel,
    effectiveForm.initiativeComplexImageModel
  );
  const initiativeVideoModelOptions = resolveModelOptionsFromText(
    effectiveForm.initiativeAllowedVideoModels,
    effectiveForm.initiativeVideoModel
  );
  const isVoiceAgentMode = effectiveForm.voiceMode === "voice_agent";
  const isOpenAiRealtimeMode = effectiveForm.voiceMode === "openai_realtime";
  const isGeminiRealtimeMode = effectiveForm.voiceMode === "gemini_realtime";
  const isSttPipelineMode = effectiveForm.voiceMode === "stt_pipeline";
  const showVoiceAdvanced = effectiveForm.voiceEnabled;
  const showInitiativeAdvanced = effectiveForm.autonomousInitiativeEnabled;
  const showInitiativeImageControls = effectiveForm.initiativeImageEnabled || effectiveForm.replyImageEnabled;
  const showInitiativeVideoControls = effectiveForm.initiativeVideoEnabled || effectiveForm.replyVideoEnabled;

  useEffect(() => {
    setForm((current) => {
      if (!current) return current;
      let changed = false;
      const next = { ...current };
      const syncModel = (field, value) => {
        if (!value) return;
        if (String(next[field] || "").trim() === value) return;
        next[field] = value;
        changed = true;
      };
      syncModel("model", selectedPresetModel);
      syncModel("replyFollowupLlmModel", selectedReplyFollowupPresetModel);
      syncModel("memoryLlmModel", selectedMemoryLlmPresetModel);
      syncModel("voiceGenerationLlmModel", selectedVoiceGenerationPresetModel);
      syncModel("voiceReplyDecisionLlmModel", selectedVoiceReplyDecisionPresetModel);
      return changed ? next : current;
    });
  }, [
    selectedPresetModel,
    selectedReplyFollowupPresetModel,
    selectedMemoryLlmPresetModel,
    selectedVoiceGenerationPresetModel,
    selectedVoiceReplyDecisionPresetModel
  ]);

  if (!form) return null;

  function set(key) {
    return (e) => setForm((f) => ({ ...f, [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  }

  function setProviderWithPresetFallback(providerField, modelField, provider) {
    setForm((current) => {
      const next = { ...current, [providerField]: provider };
      const options = resolveProviderModelOptions(modelCatalog, provider);
      const currentModel = String(current?.[modelField] || "").trim();
      if (options.includes(currentModel)) return next;
      next[modelField] = options[0] || currentModel;
      return next;
    });
  }

  function createProviderSetter(providerField, modelField) {
    return (e) => {
      setProviderWithPresetFallback(providerField, modelField, String(e.target.value || "").trim());
    };
  }

  const setProvider = createProviderSetter("provider", "model");
  const setMemoryLlmProvider = createProviderSetter("memoryLlmProvider", "memoryLlmModel");
  const setReplyFollowupProvider = createProviderSetter("replyFollowupLlmProvider", "replyFollowupLlmModel");
  const setVoiceReplyDecisionProvider = createProviderSetter("voiceReplyDecisionLlmProvider", "voiceReplyDecisionLlmModel");
  const setVoiceGenerationProvider = createProviderSetter("voiceGenerationLlmProvider", "voiceGenerationLlmModel");

  function selectModelFieldPreset(modelField, selected) {
    setForm((current) => ({ ...current, [modelField]: selected }));
  }

  function createPresetSelector(modelField) {
    return (e) => {
      selectModelFieldPreset(modelField, String(e.target.value || ""));
    };
  }

  const selectPresetModel = createPresetSelector("model");
  const selectReplyFollowupPresetModel = createPresetSelector("replyFollowupLlmModel");
  const selectMemoryLlmPresetModel = createPresetSelector("memoryLlmModel");
  const selectVoiceReplyDecisionPresetModel = createPresetSelector("voiceReplyDecisionLlmModel");
  const selectVoiceGenerationPresetModel = createPresetSelector("voiceGenerationLlmModel");

  function resetVoiceReplyDecisionPrompts() {
    setForm((current) => ({
      ...current,
      voiceReplyDecisionWakeVariantHint: defaultForm.voiceReplyDecisionWakeVariantHint,
      voiceReplyDecisionSystemPromptCompact: defaultForm.voiceReplyDecisionSystemPromptCompact,
      voiceReplyDecisionSystemPromptFull: defaultForm.voiceReplyDecisionSystemPromptFull,
      voiceReplyDecisionSystemPromptStrict: defaultForm.voiceReplyDecisionSystemPromptStrict
    }));
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
            selectedPresetModel={selectedPresetModel}
            setReplyFollowupProvider={setReplyFollowupProvider}
            selectReplyFollowupPresetModel={selectReplyFollowupPresetModel}
            replyFollowupModelOptions={replyFollowupModelOptions}
            selectedReplyFollowupPresetModel={selectedReplyFollowupPresetModel}
            setMemoryLlmProvider={setMemoryLlmProvider}
            selectMemoryLlmPresetModel={selectMemoryLlmPresetModel}
            memoryLlmModelOptions={memoryLlmModelOptions}
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
            selectedVoiceReplyDecisionPresetModel={selectedVoiceReplyDecisionPresetModel}
            setVoiceGenerationProvider={setVoiceGenerationProvider}
            selectVoiceGenerationPresetModel={selectVoiceGenerationPresetModel}
            voiceGenerationModelOptions={voiceGenerationModelOptions}
            selectedVoiceGenerationPresetModel={selectedVoiceGenerationPresetModel}
            openAiRealtimeModelOptions={openAiRealtimeModelOptions}
            openAiTranscriptionModelOptions={openAiTranscriptionModelOptions}
            geminiRealtimeModelOptions={geminiRealtimeModelOptions}
            sttTranscriptionModelOptions={sttTranscriptionModelOptions}
            sttTtsModelOptions={sttTtsModelOptions}
            onResetVoiceReplyDecisionPrompts={resetVoiceReplyDecisionPrompts}
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
            initiativeImageModelOptions={initiativeImageModelOptions}
            initiativeVideoModelOptions={initiativeVideoModelOptions}
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
