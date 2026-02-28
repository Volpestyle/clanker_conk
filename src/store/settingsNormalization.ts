import { DEFAULT_SETTINGS } from "../settings/settingsSchema.ts";
import { normalizeProviderOrder } from "../search.ts";
import { clamp, deepMerge, uniqueIdList } from "../utils.ts";

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
    merged.memoryLlm.provider = normalizeLlmProvider(merged.memoryLlm?.provider);
    merged.memoryLlm.model = String(merged.memoryLlm?.model || "claude-haiku-4-5").slice(0, 120);
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

  const defaultPrompt = DEFAULT_SETTINGS.prompt || {
    capabilityHonestyLine: "Never claim capabilities you do not have.",
    impossibleActionLine: "If asked to do something impossible, say it casually.",
    memoryEnabledLine: "You have persistent memory across conversations.",
    memoryDisabledLine: "Persistent memory is disabled right now.",
    skipLine: "If you should not send a message, output exactly [SKIP].",
    textGuidance: [],
    voiceGuidance: [],
    voiceOperationalGuidance: [],
    mediaPromptCraftGuidance: ""
  };
  merged.prompt.capabilityHonestyLine = normalizePromptLine(
    merged.prompt?.capabilityHonestyLine,
    defaultPrompt.capabilityHonestyLine || "Never claim capabilities you do not have."
  );
  merged.prompt.impossibleActionLine = normalizePromptLine(
    merged.prompt?.impossibleActionLine,
    defaultPrompt.impossibleActionLine || "If asked to do something impossible, say it casually."
  );
  merged.prompt.memoryEnabledLine = normalizePromptLine(
    merged.prompt?.memoryEnabledLine,
    defaultPrompt.memoryEnabledLine || "You have persistent memory across conversations."
  );
  merged.prompt.memoryDisabledLine = normalizePromptLine(
    merged.prompt?.memoryDisabledLine,
    defaultPrompt.memoryDisabledLine || "Persistent memory is disabled right now."
  );
  merged.prompt.skipLine = normalizePromptLine(
    merged.prompt?.skipLine,
    defaultPrompt.skipLine || "If you should not send a message, output exactly [SKIP]."
  );
  merged.prompt.textGuidance = normalizePromptLineList(
    merged.prompt?.textGuidance,
    Array.isArray(defaultPrompt.textGuidance) ? defaultPrompt.textGuidance : []
  );
  merged.prompt.voiceGuidance = normalizePromptLineList(
    merged.prompt?.voiceGuidance,
    Array.isArray(defaultPrompt.voiceGuidance) ? defaultPrompt.voiceGuidance : []
  );
  merged.prompt.voiceOperationalGuidance = normalizePromptLineList(
    merged.prompt?.voiceOperationalGuidance,
    Array.isArray(defaultPrompt.voiceOperationalGuidance) ? defaultPrompt.voiceOperationalGuidance : []
  );
  merged.prompt.mediaPromptCraftGuidance = normalizePromptLine(
    merged.prompt?.mediaPromptCraftGuidance,
    defaultPrompt.mediaPromptCraftGuidance || ""
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

  merged.llm.provider = normalizeLlmProvider(merged.llm?.provider);
  merged.llm.model = String(merged.llm?.model || "gpt-4.1-mini").slice(0, 120);
  merged.llm.temperature = clamp(Number(merged.llm?.temperature) || 0.9, 0, 2);
  merged.llm.maxOutputTokens = clamp(Number(merged.llm?.maxOutputTokens) || 220, 32, 1400);
  merged.replyFollowupLlm.enabled =
    merged.replyFollowupLlm?.enabled !== undefined
      ? Boolean(merged.replyFollowupLlm?.enabled)
      : Boolean(DEFAULT_SETTINGS.replyFollowupLlm?.enabled);
  merged.replyFollowupLlm.provider = normalizeLlmProvider(
    String(merged.replyFollowupLlm?.provider || "").trim() ||
      merged.llm.provider ||
      "openai"
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
  merged.webSearch.maxCharsPerPage = clamp(Number.isFinite(maxCharsRaw) ? maxCharsRaw : 1400, 350, 4000);
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
  if (!merged.voice.replyDecisionLlm || typeof merged.voice.replyDecisionLlm !== "object") {
    merged.voice.replyDecisionLlm = {};
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
  type VoiceReplyDecisionDefaults = {
    provider?: string;
    model?: string;
    maxAttempts?: number;
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
    replyDecisionLlm?: VoiceReplyDecisionDefaults;
    streamWatch?: VoiceStreamWatchDefaults;
    soundboard?: VoiceSoundboardDefaults;
  };

  const defaultVoice: VoiceDefaults = DEFAULT_SETTINGS.voice || {
    enabled: false,
    mode: "stt_pipeline",
    allowNsfwHumor: false,
    intentConfidenceThreshold: 0.75,
    maxSessionMinutes: 10,
    inactivityLeaveSeconds: 90,
    maxSessionsPerDay: 12,
    maxConcurrentSessions: 1,
    xai: {
      voice: "Rex",
      audioFormat: "audio/pcm",
      sampleRateHz: 24000,
      region: "us-east-1"
    },
    openaiRealtime: {
      model: "gpt-realtime",
      voice: "alloy",
      inputAudioFormat: "pcm16",
      outputAudioFormat: "pcm16",
      inputTranscriptionModel: "gpt-4o-mini-transcribe"
    },
    geminiRealtime: {
      model: "gemini-2.5-flash-native-audio-preview-12-2025",
      voice: "Aoede",
      apiBaseUrl: "https://generativelanguage.googleapis.com",
      inputSampleRateHz: 16000,
      outputSampleRateHz: 24000
    },
    sttPipeline: {
      transcriptionModel: "gpt-4o-mini-transcribe",
      ttsModel: "gpt-4o-mini-tts",
      ttsVoice: "alloy",
      ttsSpeed: 1
    },
    replyDecisionLlm: {
      provider: "anthropic",
      model: "claude-haiku-4-5",
      maxAttempts: 1
    },
    streamWatch: {
      enabled: false,
      minCommentaryIntervalSeconds: 8,
      maxFramesPerMinute: 180,
      maxFrameBytes: 350000
    },
    soundboard: {
      enabled: false,
      allowExternalSounds: false
    }
  };
  const defaultVoiceXai: VoiceXaiDefaults = defaultVoice.xai || {};
  const defaultVoiceOpenAiRealtime: VoiceOpenAiRealtimeDefaults = defaultVoice.openaiRealtime || {};
  const defaultVoiceGeminiRealtime: VoiceGeminiRealtimeDefaults = defaultVoice.geminiRealtime || {};
  const defaultVoiceSttPipeline: VoiceSttPipelineDefaults = defaultVoice.sttPipeline || {};
  const defaultVoiceReplyDecisionLlm: VoiceReplyDecisionDefaults = defaultVoice.replyDecisionLlm || {};
  const defaultVoiceStreamWatch: VoiceStreamWatchDefaults = defaultVoice.streamWatch || {};
  const defaultVoiceSoundboard: VoiceSoundboardDefaults = defaultVoice.soundboard || {};
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
  merged.voice.mode = normalizeVoiceMode(merged.voice?.mode, defaultVoice.mode);
  merged.voice.allowNsfwHumor =
    merged.voice?.allowNsfwHumor !== undefined
      ? Boolean(merged.voice?.allowNsfwHumor)
      : Boolean(defaultVoice.allowNsfwHumor);
  delete merged.voice.joinOnTextNL;
  delete merged.voice.requireDirectMentionForJoin;
  merged.voice.intentConfidenceThreshold = clamp(
    Number.isFinite(voiceIntentThresholdRaw)
      ? voiceIntentThresholdRaw
      : Number(defaultVoice.intentConfidenceThreshold) || 0.75,
    0.4,
    0.99
  );
  merged.voice.maxSessionMinutes = clamp(
    Number.isFinite(voiceMaxSessionRaw) ? voiceMaxSessionRaw : Number(defaultVoice.maxSessionMinutes) || 10,
    1,
    120
  );
  merged.voice.inactivityLeaveSeconds = clamp(
    Number.isFinite(voiceInactivityRaw) ? voiceInactivityRaw : Number(defaultVoice.inactivityLeaveSeconds) || 90,
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
  delete merged.voice.eagerCooldownSeconds;
  if (merged.voice.mode === "stt_pipeline") {
    merged.voice.replyDecisionLlm.provider = merged.llm.provider;
    merged.voice.replyDecisionLlm.model = merged.llm.model;
  } else {
    merged.voice.replyDecisionLlm.provider = normalizeLlmProvider(
      merged.voice?.replyDecisionLlm?.provider || defaultVoiceReplyDecisionLlm.provider || "anthropic"
    );
    const replyDecisionModelFallback = String(
      defaultVoiceReplyDecisionLlm.model || defaultModelForLlmProvider(merged.voice.replyDecisionLlm.provider)
    )
      .trim()
      .slice(0, 120);
    merged.voice.replyDecisionLlm.model = String(
      merged.voice?.replyDecisionLlm?.model ||
        replyDecisionModelFallback ||
        defaultModelForLlmProvider(merged.voice.replyDecisionLlm.provider)
    )
      .trim()
      .slice(0, 120);
    if (!merged.voice.replyDecisionLlm.model) {
      merged.voice.replyDecisionLlm.model = defaultModelForLlmProvider(merged.voice.replyDecisionLlm.provider);
    }
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
  delete merged.voice.openaiRealtime.inputSampleRateHz;
  delete merged.voice.openaiRealtime.outputSampleRateHz;
  merged.voice.openaiRealtime.inputTranscriptionModel = String(
    merged.voice?.openaiRealtime?.inputTranscriptionModel ||
      defaultVoiceOpenAiRealtime.inputTranscriptionModel ||
      "gpt-4o-mini-transcribe"
  )
    .trim()
    .slice(0, 120);
  delete merged.voice.openaiRealtime.allowNsfwHumor;
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
  delete merged.voice.geminiRealtime.allowNsfwHumor;
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
  delete merged.voice.soundboard.mappings;

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
  if (Array.isArray(input)) {
    return [...new Set(input.map((item) => String(item || "").trim()).filter(Boolean))]
      .slice(0, Math.max(1, maxItems))
      .map((item) => item.slice(0, maxLen));
  }

  if (typeof input !== "string") return [];

  return [...new Set(input.split(/[\n,]/g).map((item) => item.trim()).filter(Boolean))]
    .slice(0, Math.max(1, maxItems))
    .map((item) => item.slice(0, maxLen));
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

function normalizeLlmProvider(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "anthropic") return "anthropic";
  if (normalized === "xai") return "xai";
  if (normalized === "claude-code") return "claude-code";
  return "openai";
}

function defaultModelForLlmProvider(provider) {
  if (provider === "anthropic") return "claude-haiku-4-5";
  if (provider === "xai") return "grok-3-mini-latest";
  if (provider === "claude-code") return "sonnet";
  return "gpt-4.1-mini";
}

function normalizeVoiceMode(value, fallback = "voice_agent") {
  const normalized = String(value || fallback || "")
    .trim()
    .toLowerCase();
  if (normalized === "gemini_realtime") return "gemini_realtime";
  if (normalized === "openai_realtime") return "openai_realtime";
  if (normalized === "stt_pipeline") return "stt_pipeline";
  return "voice_agent";
}

function normalizeOpenAiRealtimeAudioFormat(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "g711_ulaw") return "g711_ulaw";
  if (normalized === "g711_alaw") return "g711_alaw";
  return "pcm16";
}

function normalizeHardLimitList(input, fallback = []) {
  const source = Array.isArray(input) ? input : fallback;
  return [...new Set(source.map((item) => String(item || "").trim()).filter(Boolean))]
    .slice(0, 24)
    .map((item) => item.slice(0, 180));
}

function normalizePromptLine(value, fallback = "") {
  const resolved = String(value === undefined || value === null ? fallback : value)
    .replace(/\s+/g, " ")
    .trim();
  return resolved.slice(0, 400);
}

function normalizePromptLineList(input, fallback = []) {
  const source = Array.isArray(input) ? input : fallback;
  return [...new Set(source.map((item) => String(item || "").trim()).filter(Boolean))]
    .slice(0, 40)
    .map((item) => item.slice(0, 240));
}
