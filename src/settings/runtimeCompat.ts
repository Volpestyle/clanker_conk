import {
  getActivitySettings,
  getBotName,
  getBotNameAliases,
  getDevTaskPermissions,
  getDevTeamRuntimeConfig,
  getDirectiveSettings,
  getDiscoverySettings,
  getFollowupSettings,
  getMemorySettings,
  getPromptingSettings,
  getReplyGenerationSettings,
  getReplyPermissions,
  getResearchRuntimeConfig,
  getBrowserRuntimeConfig,
  getSessionOrchestrationSettings,
  getStartupSettings,
  getTextInitiativeSettings,
  getVisionSettings,
  getVideoContextSettings,
  getVoiceAdmissionSettings,
  getVoiceChannelPolicy,
  getVoiceConversationPolicy,
  getVoiceInitiativeSettings,
  getVoiceRuntimeConfig,
  getVoiceSessionLimits,
  getVoiceSoundboardSettings,
  getVoiceStreamWatchSettings,
  getVoiceTranscriptionSettings,
  getMusicSettings,
  getAutomationsSettings,
  getResolvedFollowupBinding,
  getResolvedMemoryBinding,
  getResolvedOrchestratorBinding,
  getResolvedVisionBinding,
  getResolvedVoiceAdmissionClassifierBinding,
  getResolvedVoiceGenerationBinding
} from "./agentStack.ts";

const RUNTIME_COMPAT_MARKER = Symbol.for("clanker.runtimeCompat");

function defineGetter(target: object, key: string, getter: () => unknown) {
  Object.defineProperty(target, key, {
    enumerable: false,
    configurable: true,
    get: getter
  });
}

function decoratePermissions(settings: Record<string, unknown>) {
  const permissions = settings.permissions as Record<string, unknown>;
  if (!permissions || (permissions as any)[RUNTIME_COMPAT_MARKER]) return;
  const replies = getReplyPermissions(settings);
  defineGetter(permissions, "allowReplies", () => replies.allowReplies);
  defineGetter(permissions, "allowUnsolicitedReplies", () => replies.allowUnsolicitedReplies);
  defineGetter(permissions, "allowReactions", () => replies.allowReactions);
  defineGetter(permissions, "replyChannelIds", () => replies.replyChannelIds);
  defineGetter(permissions, "allowedChannelIds", () => replies.allowedChannelIds);
  defineGetter(permissions, "blockedChannelIds", () => replies.blockedChannelIds);
  defineGetter(permissions, "blockedUserIds", () => replies.blockedUserIds);
  defineGetter(permissions, "maxMessagesPerHour", () => replies.maxMessagesPerHour);
  defineGetter(permissions, "maxReactionsPerHour", () => replies.maxReactionsPerHour);
  Object.defineProperty(permissions, RUNTIME_COMPAT_MARKER, { value: true, enumerable: false });
}

function decorateMemory(settings: Record<string, unknown>) {
  const memory = settings.memory as Record<string, unknown>;
  if (!memory || (memory as any)[RUNTIME_COMPAT_MARKER]) return;
  const value = getMemorySettings(settings);
  defineGetter(memory, "maxRecentMessages", () => value.promptSlice.maxRecentMessages);
  defineGetter(memory, "maxHighlights", () => value.promptSlice.maxHighlights);
  Object.defineProperty(memory, RUNTIME_COMPAT_MARKER, { value: true, enumerable: false });
}

function decorateVoice(settings: Record<string, unknown>) {
  const voice = settings.voice as Record<string, unknown>;
  if (!voice || (voice as any)[RUNTIME_COMPAT_MARKER]) return;
  const voiceRuntime = getVoiceRuntimeConfig(settings);
  const conversation = getVoiceConversationPolicy(settings);
  const admission = getVoiceAdmissionSettings(settings);
  const transcription = getVoiceTranscriptionSettings(settings);
  const channelPolicy = getVoiceChannelPolicy(settings);
  const sessionLimits = getVoiceSessionLimits(settings);
  const thoughtEngine = getVoiceInitiativeSettings(settings);
  const streamWatch = getVoiceStreamWatchSettings(settings);
  const soundboard = getVoiceSoundboardSettings(settings);
  const openaiRealtime = voiceRuntime.openaiRealtime;
  const legacyVoiceStack = voiceRuntime.legacyVoiceStack;
  const generationBinding = getResolvedVoiceGenerationBinding(settings);
  const classifierBinding = getResolvedVoiceAdmissionClassifierBinding(settings);

  defineGetter(voice, "voiceProvider", () => legacyVoiceStack.selectedProvider);
  defineGetter(voice, "brainProvider", () => generationBinding.provider || "openai");
  defineGetter(voice, "transcriberProvider", () => "openai");
  defineGetter(voice, "asrLanguageMode", () => transcription.languageMode);
  defineGetter(voice, "asrLanguageHint", () => transcription.languageHint);
  defineGetter(voice, "allowNsfwHumor", () => conversation.allowNsfwHumor);
  defineGetter(voice, "intentConfidenceThreshold", () => admission.intentConfidenceThreshold);
  defineGetter(voice, "maxSessionMinutes", () => sessionLimits.maxSessionMinutes);
  defineGetter(voice, "inactivityLeaveSeconds", () => sessionLimits.inactivityLeaveSeconds);
  defineGetter(voice, "maxSessionsPerDay", () => sessionLimits.maxSessionsPerDay);
  defineGetter(voice, "maxConcurrentSessions", () => sessionLimits.maxConcurrentSessions);
  defineGetter(voice, "allowedVoiceChannelIds", () => channelPolicy.allowedChannelIds);
  defineGetter(voice, "blockedVoiceChannelIds", () => channelPolicy.blockedChannelIds);
  defineGetter(voice, "blockedVoiceUserIds", () => channelPolicy.blockedUserIds);
  defineGetter(voice, "replyEagerness", () => conversation.replyEagerness);
  defineGetter(voice, "commandOnlyMode", () => conversation.commandOnlyMode);
  defineGetter(voice, "replyPath", () => conversation.replyPath);
  defineGetter(voice, "ttsMode", () => conversation.ttsMode);
  defineGetter(voice, "asrEnabled", () => transcription.enabled);
  defineGetter(voice, "textOnlyMode", () => conversation.textOnlyMode);
  defineGetter(voice, "operationalMessages", () => conversation.operationalMessages);
  defineGetter(voice, "openaiRealtime", () => openaiRealtime);
  defineGetter(voice, "xai", () => legacyVoiceStack.xai);
  defineGetter(voice, "elevenLabsRealtime", () => legacyVoiceStack.elevenLabsRealtime);
  defineGetter(voice, "geminiRealtime", () => legacyVoiceStack.geminiRealtime);
  defineGetter(voice, "sttPipeline", () => legacyVoiceStack.sttPipeline);
  defineGetter(voice, "generationLlm", () => ({
    useTextModel: legacyVoiceStack.generation?.mode !== "dedicated_model",
    provider: generationBinding.provider,
    model: generationBinding.model
  }));
  defineGetter(voice, "thoughtEngine", () => ({
    enabled: thoughtEngine.enabled,
    provider:
      thoughtEngine.execution?.mode === "dedicated_model"
        ? thoughtEngine.execution?.model?.provider
        : getResolvedOrchestratorBinding(settings).provider,
    model:
      thoughtEngine.execution?.mode === "dedicated_model"
        ? thoughtEngine.execution?.model?.model
        : getResolvedOrchestratorBinding(settings).model,
    temperature: thoughtEngine.execution?.temperature,
    eagerness: thoughtEngine.eagerness,
    minSilenceSeconds: thoughtEngine.minSilenceSeconds,
    minSecondsBetweenThoughts: thoughtEngine.minSecondsBetweenThoughts
  }));
  defineGetter(voice, "replyDecisionLlm", () => ({
    provider: classifierBinding?.provider || getResolvedOrchestratorBinding(settings).provider,
    model: classifierBinding?.model || getResolvedOrchestratorBinding(settings).model,
    reasoningEffort: "minimal",
    realtimeAdmissionMode: admission.mode,
    musicWakeLatchSeconds: admission.musicWakeLatchSeconds
  }));
  defineGetter(voice, "musicDucking", () => getMusicSettings(settings).ducking);
  defineGetter(voice, "streamWatch", () => streamWatch);
  defineGetter(voice, "soundboard", () => soundboard);
  Object.defineProperty(voice, RUNTIME_COMPAT_MARKER, { value: true, enumerable: false });
}

export function decorateRuntimeSettings<T extends Record<string, unknown>>(settings: T): T {
  if (!settings || (settings as any)[RUNTIME_COMPAT_MARKER]) {
    return settings;
  }

  decoratePermissions(settings);
  decorateMemory(settings);
  decorateVoice(settings);

  const prompting = getPromptingSettings(settings);
  const activity = getActivitySettings(settings);
  const followup = getFollowupSettings(settings);
  const followupBinding = getResolvedFollowupBinding(settings);
  const orchestrator = getResolvedOrchestratorBinding(settings);
  const memoryBinding = getResolvedMemoryBinding(settings);
  const research = getResearchRuntimeConfig(settings);
  const browser = getBrowserRuntimeConfig(settings);
  const devTeam = getDevTeamRuntimeConfig(settings);
  const devPermissions = getDevTaskPermissions(settings);
  const vision = getVisionSettings(settings);
  const visionBinding = getResolvedVisionBinding(settings);

  defineGetter(settings, "botName", () => getBotName(settings));
  defineGetter(settings, "botNameAliases", () => getBotNameAliases(settings));
  defineGetter(settings, "prompt", () => ({
    capabilityHonestyLine: prompting.global.capabilityHonestyLine,
    impossibleActionLine: prompting.global.impossibleActionLine,
    memoryEnabledLine: prompting.global.memoryEnabledLine,
    memoryDisabledLine: prompting.global.memoryDisabledLine,
    skipLine: prompting.global.skipLine,
    textGuidance: prompting.text.guidance,
    voiceGuidance: prompting.voice.guidance,
    voiceOperationalGuidance: prompting.voice.operationalGuidance,
    voiceLookupBusySystemPrompt: prompting.voice.lookupBusySystemPrompt,
    mediaPromptCraftGuidance: prompting.media.promptCraftGuidance
  }));
  defineGetter(settings, "activity", () => activity);
  defineGetter(settings, "textThoughtLoop", () => getTextInitiativeSettings(settings));
  defineGetter(settings, "llm", () => ({
    provider: orchestrator.provider,
    model: orchestrator.model,
    temperature: orchestrator.temperature,
    maxOutputTokens: orchestrator.maxOutputTokens,
    reasoningEffort: orchestrator.reasoningEffort,
    pricing: getReplyGenerationSettings(settings).pricing
  }));
  defineGetter(settings, "replyFollowupLlm", () => ({
    enabled: followup.enabled,
    provider: followupBinding.provider,
    model: followupBinding.model,
    maxToolSteps: followup.toolBudget.maxToolSteps,
    maxTotalToolCalls: followup.toolBudget.maxTotalToolCalls,
    maxWebSearchCalls: followup.toolBudget.maxWebSearchCalls,
    maxMemoryLookupCalls: followup.toolBudget.maxMemoryLookupCalls,
    maxImageLookupCalls: followup.toolBudget.maxImageLookupCalls,
    toolTimeoutMs: followup.toolBudget.toolTimeoutMs
  }));
  defineGetter(settings, "memoryLlm", () => ({
    provider: memoryBinding.provider,
    model: memoryBinding.model,
    temperature: memoryBinding.temperature,
    maxOutputTokens: memoryBinding.maxOutputTokens
  }));
  defineGetter(settings, "webSearch", () => ({
    enabled: research.enabled,
    safeSearch: research.localExternalSearch.safeSearch,
    maxSearchesPerHour: research.maxSearchesPerHour,
    maxResults: research.localExternalSearch.maxResults,
    maxPagesToRead: research.localExternalSearch.maxPagesToRead,
    maxCharsPerPage: research.localExternalSearch.maxCharsPerPage,
    providerOrder: research.localExternalSearch.providerOrder,
    recencyDaysDefault: research.localExternalSearch.recencyDaysDefault,
    maxConcurrentFetches: research.localExternalSearch.maxConcurrentFetches
  }));
  defineGetter(settings, "browser", () => ({
    enabled: browser.enabled,
    maxBrowseCallsPerHour: browser.localBrowserAgent.maxBrowseCallsPerHour,
    llm: {
      provider:
        browser.localBrowserAgent.execution?.mode === "dedicated_model"
          ? browser.localBrowserAgent.execution?.model?.provider
          : orchestrator.provider,
      model:
        browser.localBrowserAgent.execution?.mode === "dedicated_model"
          ? browser.localBrowserAgent.execution?.model?.model
          : orchestrator.model
    },
    maxStepsPerTask: browser.localBrowserAgent.maxStepsPerTask,
    stepTimeoutMs: browser.localBrowserAgent.stepTimeoutMs,
    sessionTimeoutMs: browser.localBrowserAgent.sessionTimeoutMs
  }));
  defineGetter(settings, "codeAgent", () => {
    const codexEnabled = Boolean(devTeam.codex?.enabled);
    const claudeEnabled = Boolean(devTeam.claudeCode?.enabled);
    const provider = codexEnabled && claudeEnabled ? "auto" : codexEnabled ? "codex" : "claude-code";
    return {
      enabled: devPermissions.allowedUserIds.length > 0 && (codexEnabled || claudeEnabled),
      provider,
      model: devTeam.claudeCode?.model,
      codexModel: devTeam.codex?.model,
      maxTurns: Math.max(Number(devTeam.codex?.maxTurns || 0), Number(devTeam.claudeCode?.maxTurns || 0)),
      timeoutMs: Math.max(Number(devTeam.codex?.timeoutMs || 0), Number(devTeam.claudeCode?.timeoutMs || 0)),
      maxBufferBytes: Math.max(
        Number(devTeam.codex?.maxBufferBytes || 0),
        Number(devTeam.claudeCode?.maxBufferBytes || 0)
      ),
      defaultCwd: String(devTeam.codex?.defaultCwd || devTeam.claudeCode?.defaultCwd || ""),
      maxTasksPerHour: Math.max(
        Number(devTeam.codex?.maxTasksPerHour || 0),
        Number(devTeam.claudeCode?.maxTasksPerHour || 0)
      ),
      maxParallelTasks: Math.max(
        Number(devTeam.codex?.maxParallelTasks || 0),
        Number(devTeam.claudeCode?.maxParallelTasks || 0)
      ),
      allowedUserIds: devPermissions.allowedUserIds
    };
  });
  defineGetter(settings, "vision", () => ({
    captionEnabled: vision.enabled,
    provider: visionBinding.provider,
    model: visionBinding.model,
    maxAutoIncludeImages: vision.maxAutoIncludeImages,
    maxCaptionsPerHour: vision.maxCaptionsPerHour
  }));
  defineGetter(settings, "videoContext", () => getVideoContextSettings(settings));
  defineGetter(settings, "startup", () => getStartupSettings(settings));
  defineGetter(settings, "discovery", () => getDiscoverySettings(settings));
  defineGetter(settings, "adaptiveDirectives", () => getDirectiveSettings(settings));
  defineGetter(settings, "subAgentOrchestration", () => getSessionOrchestrationSettings(settings));

  Object.defineProperty(settings, RUNTIME_COMPAT_MARKER, {
    value: true,
    enumerable: false
  });
  return settings;
}
