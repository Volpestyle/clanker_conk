import { DEFAULT_SETTINGS } from "../settings/settingsSchema.ts";
import { normalizeBoundedStringList } from "../settings/listNormalization.ts";
import { defaultModelForLlmProvider, normalizeLlmProvider } from "../llm/llmHelpers.ts";
import { normalizeProviderOrder } from "../search.ts";
import { clamp, deepMerge, uniqueIdList } from "../utils.ts";
import { normalizeVoiceRuntimeMode } from "../voice/voiceModes.ts";
import {
  VOICE_REPLY_DECIDER_SYSTEM_PROMPT_COMPACT_DEFAULT,
  VOICE_REPLY_DECIDER_SYSTEM_PROMPT_FULL_DEFAULT,
  VOICE_REPLY_DECIDER_SYSTEM_PROMPT_STRICT_DEFAULT,
  VOICE_REPLY_DECIDER_WAKE_VARIANT_HINT_DEFAULT
} from "../promptCore.ts";

export function normalizeSettings(raw) {
  const merged = deepMerge(DEFAULT_SETTINGS, raw ?? {});
  if (!merged.persona || typeof merged.persona !== "object") merged.persona = {};
  if (!merged.activity || typeof merged.activity !== "object") merged.activity = {};
  if (!merged.startup || typeof merged.startup !== "object") merged.startup = {};
  if (!merged.permissions || typeof merged.permissions !== "object") merged.permissions = {};
  if (!merged.initiative || typeof merged.initiative !== "object") merged.initiative = {};
  if (!merged.memory || typeof merged.memory !== "object") merged.memory = {};
  if (!merged.llm || typeof merged.llm !== "object") merged.llm = {};
  if (!merged.replyFollowupLlm || typeof merged.replyFollowupLlm !== "object") merged.replyFollowupLlm = {};
  if (merged.memoryLlm && typeof merged.memoryLlm === "object") {
    merged.memoryLlm.provider = normalizeLlmProvider(
      merged.memoryLlm?.provider,
      DEFAULT_SETTINGS.memoryLlm?.provider || "anthropic"
    );
    merged.memoryLlm.model = String(
      merged.memoryLlm?.model || defaultModelForLlmProvider(merged.memoryLlm.provider)
    ).slice(0, 120);
  }
  if (!merged.webSearch || typeof merged.webSearch !== "object") merged.webSearch = {};
  if (!merged.videoContext || typeof merged.videoContext !== "object") merged.videoContext = {};
  if (!merged.voice || typeof merged.voice !== "object") merged.voice = {};
  if (!merged.prompt || typeof merged.prompt !== "object") merged.prompt = {};

  merged.botName = String(merged.botName || "clanker conk").slice(0, 50);
  merged.persona.flavor = String(merged.persona?.flavor || DEFAULT_SETTINGS.persona.flavor).slice(0, 240);
  merged.persona.hardLimits = normalizeHardLimitList(
    merged.persona?.hardLimits,
    DEFAULT_SETTINGS.persona?.hardLimits ?? []
  );

  const defaultPrompt = DEFAULT_SETTINGS.prompt;
  merged.prompt.capabilityHonestyLine = normalizePromptLine(
    merged.prompt?.capabilityHonestyLine,
    defaultPrompt.capabilityHonestyLine
  );
  merged.prompt.impossibleActionLine = normalizePromptLine(
    merged.prompt?.impossibleActionLine,
    defaultPrompt.impossibleActionLine
  );
  merged.prompt.memoryEnabledLine = normalizePromptLine(
    merged.prompt?.memoryEnabledLine,
    defaultPrompt.memoryEnabledLine
  );
  merged.prompt.memoryDisabledLine = normalizePromptLine(
    merged.prompt?.memoryDisabledLine,
    defaultPrompt.memoryDisabledLine
  );
  merged.prompt.skipLine = normalizePromptLine(
    merged.prompt?.skipLine,
    defaultPrompt.skipLine
  );
  merged.prompt.textGuidance = normalizePromptLineList(
    merged.prompt?.textGuidance,
    defaultPrompt.textGuidance
  );
  merged.prompt.voiceGuidance = normalizePromptLineList(
    merged.prompt?.voiceGuidance,
    defaultPrompt.voiceGuidance
  );
  merged.prompt.voiceOperationalGuidance = normalizePromptLineList(
    merged.prompt?.voiceOperationalGuidance,
    defaultPrompt.voiceOperationalGuidance
  );
  merged.prompt.mediaPromptCraftGuidance = normalizeLongPromptBlock(
    merged.prompt?.mediaPromptCraftGuidance,
    defaultPrompt.mediaPromptCraftGuidance,
    8_000
  );

  const replyLevelInitiative = clamp(
    Number(merged.activity?.replyLevelInitiative ?? DEFAULT_SETTINGS.activity.replyLevelInitiative) || 0,
    0,
    100
  );
  const replyLevelNonInitiative = clamp(
    Number(merged.activity?.replyLevelNonInitiative ?? DEFAULT_SETTINGS.activity.replyLevelNonInitiative) || 0,
    0,
    100
  );
  const reactionLevel = clamp(
    Number(merged.activity?.reactionLevel ?? DEFAULT_SETTINGS.activity.reactionLevel) || 0,
    0,
    100
  );
  const minSecondsBetweenMessages = clamp(
    Number(merged.activity?.minSecondsBetweenMessages) || 5,
    5,
    300
  );
  const replyCoalesceWindowSecondsRaw = Number(merged.activity?.replyCoalesceWindowSeconds);
  const replyCoalesceMaxMessagesRaw = Number(merged.activity?.replyCoalesceMaxMessages);
  const replyCoalesceWindowSeconds = clamp(
    Number.isFinite(replyCoalesceWindowSecondsRaw)
      ? replyCoalesceWindowSecondsRaw
      : Number(DEFAULT_SETTINGS.activity?.replyCoalesceWindowSeconds) || 4,
    0,
    20
  );
  const replyCoalesceMaxMessages = clamp(
    Number.isFinite(replyCoalesceMaxMessagesRaw)
      ? replyCoalesceMaxMessagesRaw
      : Number(DEFAULT_SETTINGS.activity?.replyCoalesceMaxMessages) || 6,
    1,
    20
  );
  merged.activity = {
    replyLevelInitiative,
    replyLevelNonInitiative,
    reactionLevel,
    minSecondsBetweenMessages,
    replyCoalesceWindowSeconds,
    replyCoalesceMaxMessages
  };

  merged.llm.provider = normalizeLlmProvider(merged.llm?.provider, DEFAULT_SETTINGS.llm?.provider || "anthropic");
  merged.llm.model = String(merged.llm?.model || defaultModelForLlmProvider(merged.llm.provider)).slice(0, 120);
  merged.llm.temperature = clamp(Number(merged.llm?.temperature) || 0.9, 0, 2);
  merged.llm.maxOutputTokens = clamp(Number(merged.llm?.maxOutputTokens) || 220, 32, 1400);
  merged.replyFollowupLlm.enabled =
    merged.replyFollowupLlm?.enabled !== undefined
      ? Boolean(merged.replyFollowupLlm?.enabled)
      : Boolean(DEFAULT_SETTINGS.replyFollowupLlm?.enabled);
  const replyFollowupProviderRaw = String(merged.replyFollowupLlm?.provider || "").trim();
  merged.replyFollowupLlm.provider = normalizeLlmProvider(
    replyFollowupProviderRaw,
    merged.llm.provider || "anthropic"
  );
  merged.replyFollowupLlm.model = String(
    merged.replyFollowupLlm?.model ||
      merged.llm.model ||
      defaultModelForLlmProvider(merged.replyFollowupLlm.provider)
  )
    .trim()
    .slice(0, 120);
  if (!merged.replyFollowupLlm.model) {
    merged.replyFollowupLlm.model = defaultModelForLlmProvider(merged.replyFollowupLlm.provider);
  }

  merged.webSearch.enabled = Boolean(merged.webSearch?.enabled);
  const maxSearchesRaw = Number(merged.webSearch?.maxSearchesPerHour);
  const maxResultsRaw = Number(merged.webSearch?.maxResults);
  const maxPagesRaw = Number(merged.webSearch?.maxPagesToRead);
  const maxCharsRaw = Number(merged.webSearch?.maxCharsPerPage);
  const recencyDaysRaw = Number(merged.webSearch?.recencyDaysDefault);
  const maxConcurrentFetchesRaw = Number(merged.webSearch?.maxConcurrentFetches);
  merged.webSearch.maxSearchesPerHour = clamp(
    Number.isFinite(maxSearchesRaw)
      ? maxSearchesRaw
      : Number(DEFAULT_SETTINGS.webSearch?.maxSearchesPerHour) || 20,
    1,
    120
  );
  merged.webSearch.maxResults = clamp(Number.isFinite(maxResultsRaw) ? maxResultsRaw : 5, 1, 10);
  merged.webSearch.maxPagesToRead = clamp(Number.isFinite(maxPagesRaw) ? maxPagesRaw : 3, 0, 5);
  merged.webSearch.maxCharsPerPage = clamp(Number.isFinite(maxCharsRaw) ? maxCharsRaw : 6000, 350, 24000);
  merged.webSearch.safeSearch =
    merged.webSearch?.safeSearch !== undefined ? Boolean(merged.webSearch?.safeSearch) : true;
  merged.webSearch.providerOrder = normalizeProviderOrder(merged.webSearch?.providerOrder);
  merged.webSearch.recencyDaysDefault = clamp(Number.isFinite(recencyDaysRaw) ? recencyDaysRaw : 30, 1, 365);
  merged.webSearch.maxConcurrentFetches = clamp(
    Number.isFinite(maxConcurrentFetchesRaw) ? maxConcurrentFetchesRaw : 5,
    1,
    10
  );

  merged.videoContext.enabled =
    merged.videoContext?.enabled !== undefined
      ? Boolean(merged.videoContext?.enabled)
      : Boolean(DEFAULT_SETTINGS.videoContext?.enabled);
  const videoPerHourRaw = Number(merged.videoContext?.maxLookupsPerHour);
  const videoPerMessageRaw = Number(merged.videoContext?.maxVideosPerMessage);
  const transcriptCharsRaw = Number(merged.videoContext?.maxTranscriptChars);
  const keyframeIntervalRaw = Number(merged.videoContext?.keyframeIntervalSeconds);
  const keyframeCountRaw = Number(merged.videoContext?.maxKeyframesPerVideo);
  const maxAsrSecondsRaw = Number(merged.videoContext?.maxAsrSeconds);
  merged.videoContext.maxLookupsPerHour = clamp(
    Number.isFinite(videoPerHourRaw) ? videoPerHourRaw : Number(DEFAULT_SETTINGS.videoContext?.maxLookupsPerHour) || 12,
    0,
    120
  );
  merged.videoContext.maxVideosPerMessage = clamp(
    Number.isFinite(videoPerMessageRaw)
      ? videoPerMessageRaw
      : Number(DEFAULT_SETTINGS.videoContext?.maxVideosPerMessage) || 2,
    0,
    6
  );
  merged.videoContext.maxTranscriptChars = clamp(
    Number.isFinite(transcriptCharsRaw)
      ? transcriptCharsRaw
      : Number(DEFAULT_SETTINGS.videoContext?.maxTranscriptChars) || 1200,
    200,
    4000
  );
  merged.videoContext.keyframeIntervalSeconds = clamp(
    Number.isFinite(keyframeIntervalRaw)
      ? keyframeIntervalRaw
      : Number(DEFAULT_SETTINGS.videoContext?.keyframeIntervalSeconds) || 8,
    0,
    120
  );
  merged.videoContext.maxKeyframesPerVideo = clamp(
    Number.isFinite(keyframeCountRaw)
      ? keyframeCountRaw
      : Number(DEFAULT_SETTINGS.videoContext?.maxKeyframesPerVideo) || 3,
    0,
    8
  );
  merged.videoContext.allowAsrFallback = Boolean(merged.videoContext?.allowAsrFallback);
  merged.videoContext.maxAsrSeconds = clamp(
    Number.isFinite(maxAsrSecondsRaw) ? maxAsrSecondsRaw : Number(DEFAULT_SETTINGS.videoContext?.maxAsrSeconds) || 120,
    15,
    600
  );

  if (!merged.voice.xai || typeof merged.voice.xai !== "object") {
    merged.voice.xai = {};
  }
  if (!merged.voice.openaiRealtime || typeof merged.voice.openaiRealtime !== "object") {
    merged.voice.openaiRealtime = {};
  }
  if (!merged.voice.geminiRealtime || typeof merged.voice.geminiRealtime !== "object") {
    merged.voice.geminiRealtime = {};
  }
  if (!merged.voice.sttPipeline || typeof merged.voice.sttPipeline !== "object") {
    merged.voice.sttPipeline = {};
  }
  if (!merged.voice.thoughtEngine || typeof merged.voice.thoughtEngine !== "object") {
    merged.voice.thoughtEngine = {};
  }
  if (!merged.voice.generationLlm || typeof merged.voice.generationLlm !== "object") {
    merged.voice.generationLlm = {};
  }
  if (!merged.voice.replyDecisionLlm || typeof merged.voice.replyDecisionLlm !== "object") {
    merged.voice.replyDecisionLlm = {};
  }
  if (!merged.voice.replyDecisionLlm.prompts || typeof merged.voice.replyDecisionLlm.prompts !== "object") {
    merged.voice.replyDecisionLlm.prompts = {};
  }
  if (!merged.voice.streamWatch || typeof merged.voice.streamWatch !== "object") {
    merged.voice.streamWatch = {};
  }
  if (!merged.voice.soundboard || typeof merged.voice.soundboard !== "object") {
    merged.voice.soundboard = {};
  }

  type VoiceXaiDefaults = {
    voice?: string;
    audioFormat?: string;
    sampleRateHz?: number;
    region?: string;
  };
  type VoiceOpenAiRealtimeDefaults = {
    model?: string;
    voice?: string;
    inputAudioFormat?: string;
    outputAudioFormat?: string;
    inputTranscriptionModel?: string;
  };
  type VoiceGeminiRealtimeDefaults = {
    model?: string;
    voice?: string;
    apiBaseUrl?: string;
    inputSampleRateHz?: number;
    outputSampleRateHz?: number;
  };
  type VoiceSttPipelineDefaults = {
    transcriptionModel?: string;
    ttsModel?: string;
    ttsVoice?: string;
    ttsSpeed?: number;
  };
  type VoiceThoughtEngineDefaults = {
    enabled?: boolean;
    provider?: string;
    model?: string;
    temperature?: number;
    eagerness?: number;
    minSilenceSeconds?: number;
    minSecondsBetweenThoughts?: number;
  };
  type VoiceReplyDecisionDefaults = {
    enabled?: boolean;
    provider?: string;
    model?: string;
    maxAttempts?: number;
    reasoningEffort?: string;
    prompts?: VoiceReplyDecisionPromptDefaults;
  };
  type VoiceReplyDecisionPromptDefaults = {
    wakeVariantHint?: string;
    systemPromptCompact?: string;
    systemPromptFull?: string;
    systemPromptStrict?: string;
  };
  type VoiceGenerationDefaults = {
    provider?: string;
    model?: string;
  };
  type VoiceStreamWatchDefaults = {
    enabled?: boolean;
    minCommentaryIntervalSeconds?: number;
    maxFramesPerMinute?: number;
    maxFrameBytes?: number;
  };
  type VoiceSoundboardDefaults = {
    enabled?: boolean;
    allowExternalSounds?: boolean;
  };
  type VoiceDefaults = {
    enabled?: boolean;
    mode?: string;
    realtimeReplyStrategy?: string;
    allowNsfwHumor?: boolean;
    intentConfidenceThreshold?: number;
    maxSessionMinutes?: number;
    inactivityLeaveSeconds?: number;
    maxSessionsPerDay?: number;
    maxConcurrentSessions?: number;
    xai?: VoiceXaiDefaults;
    openaiRealtime?: VoiceOpenAiRealtimeDefaults;
    geminiRealtime?: VoiceGeminiRealtimeDefaults;
    sttPipeline?: VoiceSttPipelineDefaults;
    thoughtEngine?: VoiceThoughtEngineDefaults;
    generationLlm?: VoiceGenerationDefaults;
    replyDecisionLlm?: VoiceReplyDecisionDefaults;
    streamWatch?: VoiceStreamWatchDefaults;
    soundboard?: VoiceSoundboardDefaults;
  };

  const defaultVoice: VoiceDefaults = DEFAULT_SETTINGS.voice;
  const defaultVoiceXai: VoiceXaiDefaults = defaultVoice.xai ?? {};
  const defaultVoiceOpenAiRealtime: VoiceOpenAiRealtimeDefaults = defaultVoice.openaiRealtime ?? {};
  const defaultVoiceGeminiRealtime: VoiceGeminiRealtimeDefaults = defaultVoice.geminiRealtime ?? {};
  const defaultVoiceSttPipeline: VoiceSttPipelineDefaults = defaultVoice.sttPipeline ?? {};
  const defaultVoiceThoughtEngine: VoiceThoughtEngineDefaults = defaultVoice.thoughtEngine ?? {};
  const defaultVoiceGenerationLlm: VoiceGenerationDefaults = defaultVoice.generationLlm ?? {};
  const defaultVoiceReplyDecisionLlm: VoiceReplyDecisionDefaults = defaultVoice.replyDecisionLlm ?? {};
  const defaultVoiceReplyDecisionPrompts: VoiceReplyDecisionPromptDefaults =
    defaultVoiceReplyDecisionLlm.prompts ?? {};
  const defaultVoiceStreamWatch: VoiceStreamWatchDefaults = defaultVoice.streamWatch ?? {};
  const defaultVoiceSoundboard: VoiceSoundboardDefaults = defaultVoice.soundboard ?? {};
  const voiceIntentThresholdRaw = Number(merged.voice?.intentConfidenceThreshold);
  const voiceMaxSessionRaw = Number(merged.voice?.maxSessionMinutes);
  const voiceInactivityRaw = Number(merged.voice?.inactivityLeaveSeconds);
  const voiceDailySessionsRaw = Number(merged.voice?.maxSessionsPerDay);
  const voiceConcurrentSessionsRaw = Number(merged.voice?.maxConcurrentSessions);
  const voiceSampleRateRaw = Number(merged.voice?.xai?.sampleRateHz);
  const geminiRealtimeInputSampleRateRaw = Number(merged.voice?.geminiRealtime?.inputSampleRateHz);
  const geminiRealtimeOutputSampleRateRaw = Number(merged.voice?.geminiRealtime?.outputSampleRateHz);
  const voiceSttTtsSpeedRaw = Number(merged.voice?.sttPipeline?.ttsSpeed);
  const streamWatchCommentaryIntervalRaw = Number(merged.voice?.streamWatch?.minCommentaryIntervalSeconds);
  const streamWatchMaxFramesPerMinuteRaw = Number(merged.voice?.streamWatch?.maxFramesPerMinute);
  const streamWatchMaxFrameBytesRaw = Number(merged.voice?.streamWatch?.maxFrameBytes);

  merged.voice.enabled =
    merged.voice?.enabled !== undefined ? Boolean(merged.voice?.enabled) : Boolean(defaultVoice.enabled);
  merged.voice.mode = normalizeVoiceRuntimeMode(merged.voice?.mode, "voice_agent");
  merged.voice.realtimeReplyStrategy = normalizeRealtimeReplyStrategy(
    merged.voice?.realtimeReplyStrategy,
    defaultVoice.realtimeReplyStrategy
  );
  merged.voice.allowNsfwHumor =
    merged.voice?.allowNsfwHumor !== undefined
      ? Boolean(merged.voice?.allowNsfwHumor)
      : Boolean(defaultVoice.allowNsfwHumor);
  merged.voice.intentConfidenceThreshold = clamp(
    Number.isFinite(voiceIntentThresholdRaw)
      ? voiceIntentThresholdRaw
      : Number(defaultVoice.intentConfidenceThreshold) || 0.75,
    0.4,
    0.99
  );
  merged.voice.maxSessionMinutes = clamp(
    Number.isFinite(voiceMaxSessionRaw) ? voiceMaxSessionRaw : Number(defaultVoice.maxSessionMinutes) || 30,
    1,
    120
  );
  merged.voice.inactivityLeaveSeconds = clamp(
    Number.isFinite(voiceInactivityRaw) ? voiceInactivityRaw : Number(defaultVoice.inactivityLeaveSeconds) || 300,
    20,
    3600
  );
  merged.voice.maxSessionsPerDay = clamp(
    Number.isFinite(voiceDailySessionsRaw) ? voiceDailySessionsRaw : Number(defaultVoice.maxSessionsPerDay) || 12,
    0,
    120
  );
  merged.voice.maxConcurrentSessions = clamp(
    Number.isFinite(voiceConcurrentSessionsRaw)
      ? voiceConcurrentSessionsRaw
      : Number(defaultVoice.maxConcurrentSessions) || 1,
    1,
    3
  );
  merged.voice.allowedVoiceChannelIds = uniqueIdList(merged.voice?.allowedVoiceChannelIds);
  merged.voice.blockedVoiceChannelIds = uniqueIdList(merged.voice?.blockedVoiceChannelIds);
  merged.voice.blockedVoiceUserIds = uniqueIdList(merged.voice?.blockedVoiceUserIds);

  const voiceEagernessRaw = Number(merged.voice?.replyEagerness);
  merged.voice.replyEagerness = clamp(
    Number.isFinite(voiceEagernessRaw) ? voiceEagernessRaw : 0, 0, 100
  );
  merged.voice.thoughtEngine.enabled =
    merged.voice?.thoughtEngine?.enabled !== undefined
      ? Boolean(merged.voice?.thoughtEngine?.enabled)
      : defaultVoiceThoughtEngine?.enabled !== undefined
        ? Boolean(defaultVoiceThoughtEngine.enabled)
        : true;
  const voiceThoughtEagernessRaw = Number(merged.voice?.thoughtEngine?.eagerness);
  const defaultVoiceThoughtEagernessRaw = Number(defaultVoiceThoughtEngine.eagerness);
  merged.voice.thoughtEngine.eagerness = clamp(
    Number.isFinite(voiceThoughtEagernessRaw)
      ? voiceThoughtEagernessRaw
      : Number.isFinite(defaultVoiceThoughtEagernessRaw)
        ? defaultVoiceThoughtEagernessRaw
        : 0,
    0,
    100
  );
  const voiceThoughtProviderRaw = String(merged.voice?.thoughtEngine?.provider || "").trim();
  merged.voice.thoughtEngine.provider = normalizeLlmProvider(
    voiceThoughtProviderRaw,
    defaultVoiceThoughtEngine.provider || "anthropic"
  );
  const defaultVoiceThoughtModel =
    merged.voice.thoughtEngine.provider === normalizeLlmProvider(defaultVoiceThoughtEngine.provider)
      ? String(defaultVoiceThoughtEngine.model || "").trim().slice(0, 120)
      : "";
  merged.voice.thoughtEngine.model = String(
    merged.voice?.thoughtEngine?.model ||
      defaultVoiceThoughtModel ||
      defaultModelForLlmProvider(merged.voice.thoughtEngine.provider)
  )
    .trim()
    .slice(0, 120);
  if (!merged.voice.thoughtEngine.model) {
    merged.voice.thoughtEngine.model = defaultModelForLlmProvider(merged.voice.thoughtEngine.provider);
  }
  const voiceThoughtTemperatureRaw = Number(merged.voice?.thoughtEngine?.temperature);
  const defaultVoiceThoughtTemperatureRaw = Number(defaultVoiceThoughtEngine.temperature);
  merged.voice.thoughtEngine.temperature = clamp(
    Number.isFinite(voiceThoughtTemperatureRaw)
      ? voiceThoughtTemperatureRaw
      : Number.isFinite(defaultVoiceThoughtTemperatureRaw)
        ? defaultVoiceThoughtTemperatureRaw
        : 0.8,
    0,
    2
  );
  const voiceThoughtMinSilenceRaw = Number(merged.voice?.thoughtEngine?.minSilenceSeconds);
  const defaultVoiceThoughtMinSilenceRaw = Number(defaultVoiceThoughtEngine.minSilenceSeconds);
  merged.voice.thoughtEngine.minSilenceSeconds = clamp(
    Number.isFinite(voiceThoughtMinSilenceRaw)
      ? voiceThoughtMinSilenceRaw
      : Number.isFinite(defaultVoiceThoughtMinSilenceRaw)
        ? defaultVoiceThoughtMinSilenceRaw
        : 20,
    8,
    300
  );
  const voiceThoughtMinGapRaw = Number(merged.voice?.thoughtEngine?.minSecondsBetweenThoughts);
  const defaultVoiceThoughtMinGapRaw = Number(defaultVoiceThoughtEngine.minSecondsBetweenThoughts);
  merged.voice.thoughtEngine.minSecondsBetweenThoughts = clamp(
    Number.isFinite(voiceThoughtMinGapRaw)
      ? voiceThoughtMinGapRaw
      : Number.isFinite(defaultVoiceThoughtMinGapRaw)
        ? defaultVoiceThoughtMinGapRaw
        : merged.voice.thoughtEngine.minSilenceSeconds,
    8,
    600
  );
  const voiceGenerationProviderRaw = String(merged.voice?.generationLlm?.provider || "").trim();
  merged.voice.generationLlm.provider = normalizeLlmProvider(
    voiceGenerationProviderRaw,
    defaultVoiceGenerationLlm.provider || "anthropic"
  );
  const defaultVoiceGenerationModel =
    merged.voice.generationLlm.provider === normalizeLlmProvider(defaultVoiceGenerationLlm.provider)
      ? String(defaultVoiceGenerationLlm.model || "").trim().slice(0, 120)
      : "";
  merged.voice.generationLlm.model = String(
    merged.voice?.generationLlm?.model ||
      defaultVoiceGenerationModel ||
      defaultModelForLlmProvider(merged.voice.generationLlm.provider)
  )
    .trim()
    .slice(0, 120);
  if (!merged.voice.generationLlm.model) {
    merged.voice.generationLlm.model = defaultModelForLlmProvider(merged.voice.generationLlm.provider);
  }
  merged.voice.replyDecisionLlm.enabled =
    merged.voice?.replyDecisionLlm?.enabled !== undefined
      ? Boolean(merged.voice?.replyDecisionLlm?.enabled)
      : defaultVoiceReplyDecisionLlm?.enabled !== undefined
        ? Boolean(defaultVoiceReplyDecisionLlm.enabled)
        : true;
  const voiceReplyDecisionProviderRaw = String(merged.voice?.replyDecisionLlm?.provider || "").trim();
  merged.voice.replyDecisionLlm.provider = normalizeLlmProvider(
    voiceReplyDecisionProviderRaw,
    defaultVoiceReplyDecisionLlm.provider || "anthropic"
  );
  const defaultReplyDecisionModel =
    merged.voice.replyDecisionLlm.provider === normalizeLlmProvider(defaultVoiceReplyDecisionLlm.provider)
      ? String(defaultVoiceReplyDecisionLlm.model || "").trim().slice(0, 120)
      : "";
  merged.voice.replyDecisionLlm.model = String(
    merged.voice?.replyDecisionLlm?.model ||
      defaultReplyDecisionModel ||
      defaultModelForLlmProvider(merged.voice.replyDecisionLlm.provider)
  )
    .trim()
    .slice(0, 120);
  if (!merged.voice.replyDecisionLlm.model) {
    merged.voice.replyDecisionLlm.model = defaultModelForLlmProvider(merged.voice.replyDecisionLlm.provider);
  }
  const replyDecisionMaxAttemptsRaw = Number(merged.voice?.replyDecisionLlm?.maxAttempts);
  const defaultReplyDecisionMaxAttemptsRaw = Number(defaultVoiceReplyDecisionLlm.maxAttempts);
  merged.voice.replyDecisionLlm.maxAttempts = clamp(
    Number.isFinite(replyDecisionMaxAttemptsRaw)
      ? replyDecisionMaxAttemptsRaw
      : Number.isFinite(defaultReplyDecisionMaxAttemptsRaw)
        ? defaultReplyDecisionMaxAttemptsRaw
        : 1,
      1,
      3
  );
  merged.voice.replyDecisionLlm.reasoningEffort = normalizeOpenAiReasoningEffort(
    merged.voice?.replyDecisionLlm?.reasoningEffort,
    defaultVoiceReplyDecisionLlm.reasoningEffort || "minimal"
  );
  merged.voice.replyDecisionLlm.prompts.wakeVariantHint = normalizeLongPromptBlock(
    merged.voice?.replyDecisionLlm?.prompts?.wakeVariantHint,
    defaultVoiceReplyDecisionPrompts.wakeVariantHint || VOICE_REPLY_DECIDER_WAKE_VARIANT_HINT_DEFAULT,
    2200
  );
  merged.voice.replyDecisionLlm.prompts.systemPromptCompact = normalizeLongPromptBlock(
    merged.voice?.replyDecisionLlm?.prompts?.systemPromptCompact,
    defaultVoiceReplyDecisionPrompts.systemPromptCompact || VOICE_REPLY_DECIDER_SYSTEM_PROMPT_COMPACT_DEFAULT,
    10_000
  );
  merged.voice.replyDecisionLlm.prompts.systemPromptFull = normalizeLongPromptBlock(
    merged.voice?.replyDecisionLlm?.prompts?.systemPromptFull,
    defaultVoiceReplyDecisionPrompts.systemPromptFull || VOICE_REPLY_DECIDER_SYSTEM_PROMPT_FULL_DEFAULT,
    10_000
  );
  merged.voice.replyDecisionLlm.prompts.systemPromptStrict = normalizeLongPromptBlock(
    merged.voice?.replyDecisionLlm?.prompts?.systemPromptStrict,
    defaultVoiceReplyDecisionPrompts.systemPromptStrict || VOICE_REPLY_DECIDER_SYSTEM_PROMPT_STRICT_DEFAULT,
    4000
  );

  merged.voice.xai.voice = String(merged.voice?.xai?.voice || defaultVoiceXai.voice || "Rex").slice(0, 60);
  merged.voice.xai.audioFormat = String(merged.voice?.xai?.audioFormat || defaultVoiceXai.audioFormat || "audio/pcm")
    .trim()
    .slice(0, 40);
  merged.voice.xai.sampleRateHz = clamp(
    Number.isFinite(voiceSampleRateRaw) ? voiceSampleRateRaw : Number(defaultVoiceXai.sampleRateHz) || 24000,
    8000,
    48000
  );
  merged.voice.xai.region = String(merged.voice?.xai?.region || defaultVoiceXai.region || "us-east-1")
    .trim()
    .slice(0, 40);
  merged.voice.openaiRealtime.model = String(
    merged.voice?.openaiRealtime?.model || defaultVoiceOpenAiRealtime.model || "gpt-realtime"
  )
    .trim()
    .slice(0, 120);
  merged.voice.openaiRealtime.voice = String(
    merged.voice?.openaiRealtime?.voice || defaultVoiceOpenAiRealtime.voice || "alloy"
  )
    .trim()
    .slice(0, 60);
  merged.voice.openaiRealtime.inputAudioFormat = normalizeOpenAiRealtimeAudioFormat(
    merged.voice?.openaiRealtime?.inputAudioFormat || defaultVoiceOpenAiRealtime.inputAudioFormat || "pcm16"
  );
  merged.voice.openaiRealtime.outputAudioFormat = normalizeOpenAiRealtimeAudioFormat(
    merged.voice?.openaiRealtime?.outputAudioFormat || defaultVoiceOpenAiRealtime.outputAudioFormat || "pcm16"
  );
  merged.voice.openaiRealtime.inputTranscriptionModel = String(
    merged.voice?.openaiRealtime?.inputTranscriptionModel ||
      defaultVoiceOpenAiRealtime.inputTranscriptionModel ||
      "gpt-4o-mini-transcribe"
  )
    .trim()
    .slice(0, 120);
  merged.voice.geminiRealtime.model = String(
    merged.voice?.geminiRealtime?.model || defaultVoiceGeminiRealtime.model || "gemini-2.5-flash-native-audio-preview-12-2025"
  )
    .trim()
    .slice(0, 140);
  merged.voice.geminiRealtime.voice = String(
    merged.voice?.geminiRealtime?.voice || defaultVoiceGeminiRealtime.voice || "Aoede"
  )
    .trim()
    .slice(0, 60);
  merged.voice.geminiRealtime.apiBaseUrl = normalizeHttpBaseUrl(
    merged.voice?.geminiRealtime?.apiBaseUrl,
    defaultVoiceGeminiRealtime.apiBaseUrl || "https://generativelanguage.googleapis.com"
  );
  merged.voice.geminiRealtime.inputSampleRateHz = clamp(
    Number.isFinite(geminiRealtimeInputSampleRateRaw)
      ? geminiRealtimeInputSampleRateRaw
      : Number(defaultVoiceGeminiRealtime.inputSampleRateHz) || 16000,
    8000,
    48000
  );
  merged.voice.geminiRealtime.outputSampleRateHz = clamp(
    Number.isFinite(geminiRealtimeOutputSampleRateRaw)
      ? geminiRealtimeOutputSampleRateRaw
      : Number(defaultVoiceGeminiRealtime.outputSampleRateHz) || 24000,
    8000,
    48000
  );
  merged.voice.sttPipeline.transcriptionModel = String(
    merged.voice?.sttPipeline?.transcriptionModel || defaultVoiceSttPipeline.transcriptionModel || "gpt-4o-mini-transcribe"
  )
    .trim()
    .slice(0, 120);
  merged.voice.sttPipeline.ttsModel = String(
    merged.voice?.sttPipeline?.ttsModel || defaultVoiceSttPipeline.ttsModel || "gpt-4o-mini-tts"
  )
    .trim()
    .slice(0, 120);
  merged.voice.sttPipeline.ttsVoice = String(
    merged.voice?.sttPipeline?.ttsVoice || defaultVoiceSttPipeline.ttsVoice || "alloy"
  )
    .trim()
    .slice(0, 60);
  merged.voice.sttPipeline.ttsSpeed = clamp(
    Number.isFinite(voiceSttTtsSpeedRaw)
      ? voiceSttTtsSpeedRaw
      : Number(defaultVoiceSttPipeline.ttsSpeed) || 1,
    0.25,
    2
  );
  merged.voice.streamWatch.enabled =
    merged.voice?.streamWatch?.enabled !== undefined
      ? Boolean(merged.voice?.streamWatch?.enabled)
      : Boolean(defaultVoiceStreamWatch.enabled);
  merged.voice.streamWatch.minCommentaryIntervalSeconds = clamp(
    Number.isFinite(streamWatchCommentaryIntervalRaw)
      ? streamWatchCommentaryIntervalRaw
      : Number(defaultVoiceStreamWatch.minCommentaryIntervalSeconds) || 8,
    3,
    120
  );
  merged.voice.streamWatch.maxFramesPerMinute = clamp(
    Number.isFinite(streamWatchMaxFramesPerMinuteRaw)
      ? streamWatchMaxFramesPerMinuteRaw
      : Number(defaultVoiceStreamWatch.maxFramesPerMinute) || 180,
    6,
    600
  );
  merged.voice.streamWatch.maxFrameBytes = clamp(
    Number.isFinite(streamWatchMaxFrameBytesRaw)
      ? streamWatchMaxFrameBytesRaw
      : Number(defaultVoiceStreamWatch.maxFrameBytes) || 350000,
    50_000,
    4_000_000
  );

  merged.voice.soundboard.enabled =
    merged.voice?.soundboard?.enabled !== undefined
      ? Boolean(merged.voice?.soundboard?.enabled)
      : Boolean(defaultVoiceSoundboard.enabled);
  merged.voice.soundboard.allowExternalSounds =
    merged.voice?.soundboard?.allowExternalSounds !== undefined
      ? Boolean(merged.voice?.soundboard?.allowExternalSounds)
      : Boolean(defaultVoiceSoundboard.allowExternalSounds);
  merged.voice.soundboard.preferredSoundIds = uniqueIdList(merged.voice?.soundboard?.preferredSoundIds).slice(0, 40);

  merged.startup.catchupEnabled =
    merged.startup?.catchupEnabled !== undefined ? Boolean(merged.startup?.catchupEnabled) : true;
  const catchupLookbackHoursRaw = Number(merged.startup?.catchupLookbackHours);
  merged.startup.catchupLookbackHours = clamp(
    Number.isFinite(catchupLookbackHoursRaw) ? catchupLookbackHoursRaw : 6,
    1,
    24
  );
  merged.startup.catchupMaxMessagesPerChannel = clamp(
    Number(merged.startup?.catchupMaxMessagesPerChannel) || 20,
    5,
    80
  );
  merged.startup.maxCatchupRepliesPerChannel = clamp(
    Number(merged.startup?.maxCatchupRepliesPerChannel) || 2,
    1,
    12
  );

  merged.permissions.allowReplies = Boolean(merged.permissions?.allowReplies);
  merged.permissions.allowInitiativeReplies =
    merged.permissions?.allowInitiativeReplies !== undefined
      ? Boolean(merged.permissions?.allowInitiativeReplies)
      : true;
  merged.permissions.allowReactions = Boolean(merged.permissions?.allowReactions);
  merged.permissions.initiativeChannelIds = uniqueIdList(merged.permissions?.initiativeChannelIds);
  merged.permissions.allowedChannelIds = uniqueIdList(merged.permissions?.allowedChannelIds);
  merged.permissions.blockedChannelIds = uniqueIdList(merged.permissions?.blockedChannelIds);
  merged.permissions.blockedUserIds = uniqueIdList(merged.permissions?.blockedUserIds);
  merged.permissions.maxMessagesPerHour = clamp(
    Number(merged.permissions?.maxMessagesPerHour) || 20,
    1,
    200
  );
  merged.permissions.maxReactionsPerHour = clamp(Number(merged.permissions?.maxReactionsPerHour) || 24, 1, 300);

  merged.initiative.enabled =
    merged.initiative?.enabled !== undefined ? Boolean(merged.initiative?.enabled) : false;
  merged.initiative.maxPostsPerDay = clamp(Number(merged.initiative?.maxPostsPerDay) || 0, 0, 100);
  merged.initiative.minMinutesBetweenPosts = clamp(
    Number(merged.initiative?.minMinutesBetweenPosts) || 120,
    5,
    24 * 60
  );
  merged.initiative.pacingMode =
    String(merged.initiative?.pacingMode || "even").toLowerCase() === "spontaneous"
      ? "spontaneous"
      : "even";
  merged.initiative.spontaneity = clamp(Number(merged.initiative?.spontaneity) || 65, 0, 100);
  merged.initiative.postOnStartup = Boolean(merged.initiative?.postOnStartup);
  merged.initiative.allowImagePosts = Boolean(merged.initiative?.allowImagePosts);
  merged.initiative.allowVideoPosts = Boolean(merged.initiative?.allowVideoPosts);
  merged.initiative.allowReplyImages = Boolean(merged.initiative?.allowReplyImages);
  merged.initiative.allowReplyVideos = Boolean(merged.initiative?.allowReplyVideos);
  merged.initiative.allowReplyGifs = Boolean(merged.initiative?.allowReplyGifs);
  merged.initiative.maxImagesPerDay = clamp(Number(merged.initiative?.maxImagesPerDay) || 0, 0, 200);
  merged.initiative.maxVideosPerDay = clamp(Number(merged.initiative?.maxVideosPerDay) || 0, 0, 120);
  merged.initiative.maxGifsPerDay = clamp(Number(merged.initiative?.maxGifsPerDay) || 0, 0, 300);
  merged.initiative.simpleImageModel = String(
    merged.initiative?.simpleImageModel || "gpt-image-1.5"
  ).slice(0, 120);
  merged.initiative.complexImageModel = String(
    merged.initiative?.complexImageModel || "grok-imagine-image"
  ).slice(0, 120);
  merged.initiative.videoModel = String(merged.initiative?.videoModel || "grok-imagine-video").slice(0, 120);
  merged.initiative.allowedImageModels = uniqueStringList(
    merged.initiative?.allowedImageModels ?? DEFAULT_SETTINGS.initiative?.allowedImageModels ?? [],
    12,
    120
  );
  merged.initiative.allowedVideoModels = uniqueStringList(
    merged.initiative?.allowedVideoModels ?? DEFAULT_SETTINGS.initiative?.allowedVideoModels ?? [],
    8,
    120
  );
  if (!merged.initiative.discovery || typeof merged.initiative.discovery !== "object") {
    merged.initiative.discovery = {};
  }
  if (!merged.initiative.discovery.sources || typeof merged.initiative.discovery.sources !== "object") {
    merged.initiative.discovery.sources = {};
  }

  const defaultDiscovery = DEFAULT_SETTINGS.initiative?.discovery ?? {
    enabled: false,
    linkChancePercent: 0,
    maxLinksPerPost: 2,
    maxCandidatesForPrompt: 6,
    freshnessHours: 96,
    dedupeHours: 168,
    randomness: 55,
    sourceFetchLimit: 10,
    preferredTopics: [],
    xNitterBaseUrl: "https://nitter.net",
    sources: {
      reddit: true,
      hackerNews: true,
      youtube: true,
      rss: true,
      x: false
    }
  };
  const defaultSources = defaultDiscovery.sources ?? {
    reddit: true,
    hackerNews: true,
    youtube: true,
    rss: true,
    x: false
  };
  const sourceConfig = merged.initiative.discovery.sources ?? {};
  merged.initiative.discovery = {
    enabled:
      merged.initiative.discovery?.enabled !== undefined
        ? Boolean(merged.initiative.discovery?.enabled)
        : Boolean(defaultDiscovery.enabled),
    linkChancePercent: clamp(
      Number(merged.initiative.discovery?.linkChancePercent) || Number(defaultDiscovery.linkChancePercent) || 0,
      0,
      100
    ),
    maxLinksPerPost: clamp(
      Number(merged.initiative.discovery?.maxLinksPerPost) || Number(defaultDiscovery.maxLinksPerPost) || 2,
      1,
      4
    ),
    maxCandidatesForPrompt: clamp(
      Number(merged.initiative.discovery?.maxCandidatesForPrompt) ||
        Number(defaultDiscovery.maxCandidatesForPrompt) ||
        6,
      1,
      12
    ),
    freshnessHours: clamp(
      Number(merged.initiative.discovery?.freshnessHours) || Number(defaultDiscovery.freshnessHours) || 96,
      1,
      24 * 14
    ),
    dedupeHours: clamp(
      Number(merged.initiative.discovery?.dedupeHours) || Number(defaultDiscovery.dedupeHours) || 168,
      1,
      24 * 45
    ),
    randomness: clamp(
      Number(merged.initiative.discovery?.randomness) || Number(defaultDiscovery.randomness) || 55,
      0,
      100
    ),
    sourceFetchLimit: clamp(
      Number(merged.initiative.discovery?.sourceFetchLimit) || Number(defaultDiscovery.sourceFetchLimit) || 10,
      2,
      30
    ),
    allowNsfw: Boolean(merged.initiative.discovery?.allowNsfw),
    preferredTopics: uniqueStringList(
      merged.initiative.discovery?.preferredTopics,
      Number(defaultDiscovery.preferredTopics?.length ? defaultDiscovery.preferredTopics.length : 12),
      80
    ),
    redditSubreddits: uniqueStringList(
      merged.initiative.discovery?.redditSubreddits,
      20,
      40
    ).map((entry) => entry.replace(/^r\//i, "")),
    youtubeChannelIds: uniqueStringList(merged.initiative.discovery?.youtubeChannelIds, 20, 80),
    rssFeeds: uniqueStringList(merged.initiative.discovery?.rssFeeds, 30, 240).filter(isHttpLikeUrl),
    xHandles: uniqueStringList(merged.initiative.discovery?.xHandles, 20, 40).map((entry) =>
      entry.replace(/^@/, "")
    ),
    xNitterBaseUrl: normalizeHttpBaseUrl(
      merged.initiative.discovery?.xNitterBaseUrl,
      defaultDiscovery.xNitterBaseUrl || "https://nitter.net"
    ),
    sources: {
      reddit:
        sourceConfig.reddit !== undefined
          ? Boolean(sourceConfig.reddit)
          : Boolean(defaultSources.reddit ?? true),
      hackerNews:
        sourceConfig.hackerNews !== undefined
          ? Boolean(sourceConfig.hackerNews)
          : Boolean(defaultSources.hackerNews ?? true),
      youtube:
        sourceConfig.youtube !== undefined
          ? Boolean(sourceConfig.youtube)
          : Boolean(defaultSources.youtube ?? true),
      rss:
        sourceConfig.rss !== undefined
          ? Boolean(sourceConfig.rss)
          : Boolean(defaultSources.rss ?? true),
      x:
        sourceConfig.x !== undefined
          ? Boolean(sourceConfig.x)
          : Boolean(defaultSources.x ?? false)
    }
  };

  merged.memory.enabled = Boolean(merged.memory?.enabled);
  merged.memory.maxRecentMessages = clamp(Number(merged.memory?.maxRecentMessages) || 35, 10, 120);
  merged.memory.embeddingModel = String(merged.memory?.embeddingModel || "text-embedding-3-small").slice(0, 120);

  return merged;
}

function uniqueStringList(input, maxItems = 20, maxLen = 120) {
  return normalizeBoundedStringList(input, { maxItems, maxLen });
}

function isHttpLikeUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return false;

  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeHttpBaseUrl(value, fallback) {
  const target = String(value || fallback || "").trim();

  try {
    const parsed = new URL(target);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return String(fallback || "https://nitter.net");
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return String(fallback || "https://nitter.net");
  }
}

function normalizeRealtimeReplyStrategy(value, fallback = "brain") {
  const normalized = String(value || fallback || "")
    .trim()
    .toLowerCase();
  if (normalized === "native") return "native";
  return "brain";
}

function normalizeOpenAiRealtimeAudioFormat(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "audio/pcm") return "pcm16";
  return "pcm16";
}

function normalizeOpenAiReasoningEffort(value, fallback = "minimal") {
  const normalized = String(value || fallback || "")
    .trim()
    .toLowerCase();
  if (normalized === "minimal") return "minimal";
  if (normalized === "low") return "low";
  if (normalized === "medium") return "medium";
  if (normalized === "high") return "high";
  return "minimal";
}

function normalizeHardLimitList(input, fallback = []) {
  const source = Array.isArray(input) ? input : fallback;
  return normalizeBoundedStringList(source, { maxItems: 24, maxLen: 180 });
}

function normalizePromptLine(value, fallback = "") {
  const resolved = String(value === undefined || value === null ? fallback : value)
    .replace(/\s+/g, " ")
    .trim();
  return resolved.slice(0, 400);
}

function normalizeLongPromptBlock(value, fallback = "", maxLen = 8000) {
  const limit = clamp(Number(maxLen) || 8000, 256, 20_000);
  const candidate = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  if (candidate) return candidate.slice(0, limit);
  const fallbackText = String(fallback ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  return fallbackText.slice(0, limit);
}

function normalizePromptLineList(input, fallback = []) {
  const source = Array.isArray(input) ? input : fallback;
  return normalizeBoundedStringList(source, { maxItems: 40, maxLen: 240 });
}
