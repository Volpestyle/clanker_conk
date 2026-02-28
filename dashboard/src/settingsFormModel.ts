import { DEFAULT_SETTINGS, PROVIDER_MODEL_FALLBACKS } from "../../src/settings/settingsSchema.ts";
import { normalizeLlmProvider } from "../../src/llm/llmHelpers.ts";

export const CUSTOM_MODEL_OPTION_VALUE = "__custom_model__";

function parseList(val) {
  return [...new Set(String(val || "").split(/[\n,]/g).map((x) => x.trim()).filter(Boolean))];
}

function parseLineList(val) {
  return [...new Set(String(val || "").split(/\n/g).map((x) => x.trim()).filter(Boolean))];
}

function formatList(items) {
  return (items || []).join("\n");
}

export function settingsToForm(settings) {
  const defaults = DEFAULT_SETTINGS;
  const defaultPrompt = defaults.prompt;
  const defaultActivity = defaults.activity;
  const defaultPermissions = defaults.permissions;
  const defaultLlm = defaults.llm;
  const defaultReplyFollowupLlm = defaults.replyFollowupLlm;
  const defaultMemoryLlm = defaults.memoryLlm;
  const defaultWebSearch = defaults.webSearch;
  const defaultVideoContext = defaults.videoContext;
  const defaultVoice = defaults.voice;
  const defaultVoiceXai = defaults.voice.xai;
  const defaultVoiceOpenAiRealtime = defaults.voice.openaiRealtime;
  const defaultVoiceGeminiRealtime = defaults.voice.geminiRealtime;
  const defaultVoiceSttPipeline = defaults.voice.sttPipeline;
  const defaultVoiceGenerationLlm = defaults.voice.generationLlm;
  const defaultVoiceStreamWatch = defaults.voice.streamWatch;
  const defaultVoiceSoundboard = defaults.voice.soundboard;
  const defaultStartup = defaults.startup;
  const defaultInitiative = defaults.initiative;
  const defaultDiscovery = defaults.initiative.discovery;
  const activity = settings?.activity ?? {};
  const selectedVoiceMode = settings?.voice?.mode ?? defaultVoice.mode;
  return {
    botName: settings?.botName ?? defaults.botName,
    personaFlavor: settings?.persona?.flavor ?? defaults.persona.flavor,
    personaHardLimits: formatList(settings?.persona?.hardLimits),
    promptCapabilityHonestyLine: settings?.prompt?.capabilityHonestyLine ?? defaultPrompt.capabilityHonestyLine,
    promptImpossibleActionLine:
      settings?.prompt?.impossibleActionLine ?? defaultPrompt.impossibleActionLine,
    promptMemoryEnabledLine:
      settings?.prompt?.memoryEnabledLine ?? defaultPrompt.memoryEnabledLine,
    promptMemoryDisabledLine:
      settings?.prompt?.memoryDisabledLine ?? defaultPrompt.memoryDisabledLine,
    promptSkipLine: settings?.prompt?.skipLine ?? defaultPrompt.skipLine,
    promptTextGuidance: formatList(settings?.prompt?.textGuidance),
    promptVoiceGuidance: formatList(settings?.prompt?.voiceGuidance),
    promptVoiceOperationalGuidance: formatList(settings?.prompt?.voiceOperationalGuidance),
    promptMediaPromptCraftGuidance: settings?.prompt?.mediaPromptCraftGuidance ?? defaultPrompt.mediaPromptCraftGuidance,
    replyLevelInitiative: activity.replyLevelInitiative ?? defaultActivity.replyLevelInitiative,
    replyLevelNonInitiative: activity.replyLevelNonInitiative ?? defaultActivity.replyLevelNonInitiative,
    reactionLevel: activity.reactionLevel ?? defaultActivity.reactionLevel,
    minGap: activity.minSecondsBetweenMessages ?? defaultActivity.minSecondsBetweenMessages,
    allowReplies: settings?.permissions?.allowReplies ?? defaultPermissions.allowReplies,
    allowInitiative: settings?.permissions?.allowInitiativeReplies !== false,
    allowReactions: settings?.permissions?.allowReactions ?? defaultPermissions.allowReactions,
    memoryEnabled: settings?.memory?.enabled ?? defaults.memory.enabled,
    provider: settings?.llm?.provider ?? defaultLlm.provider,
    model: settings?.llm?.model ?? defaultLlm.model,
    replyFollowupLlmEnabled: settings?.replyFollowupLlm?.enabled ?? defaultReplyFollowupLlm.enabled,
    replyFollowupLlmProvider: settings?.replyFollowupLlm?.provider ?? settings?.llm?.provider ?? defaultReplyFollowupLlm.provider,
    replyFollowupLlmModel: settings?.replyFollowupLlm?.model ?? settings?.llm?.model ?? defaultReplyFollowupLlm.model,
    memoryLlmProvider: settings?.memoryLlm?.provider ?? defaultMemoryLlm.provider,
    memoryLlmModel: settings?.memoryLlm?.model ?? defaultMemoryLlm.model,
    temperature: settings?.llm?.temperature ?? defaultLlm.temperature,
    maxTokens: settings?.llm?.maxOutputTokens ?? defaultLlm.maxOutputTokens,
    webSearchEnabled: settings?.webSearch?.enabled ?? defaultWebSearch.enabled,
    webSearchSafeMode: settings?.webSearch?.safeSearch ?? defaultWebSearch.safeSearch,
    webSearchPerHour: settings?.webSearch?.maxSearchesPerHour ?? defaultWebSearch.maxSearchesPerHour,
    webSearchMaxResults: settings?.webSearch?.maxResults ?? defaultWebSearch.maxResults,
    webSearchMaxPages: settings?.webSearch?.maxPagesToRead ?? defaultWebSearch.maxPagesToRead,
    webSearchMaxChars: settings?.webSearch?.maxCharsPerPage ?? defaultWebSearch.maxCharsPerPage,
    webSearchProviderOrder: (settings?.webSearch?.providerOrder || defaultWebSearch.providerOrder).join(","),
    webSearchRecencyDaysDefault: settings?.webSearch?.recencyDaysDefault ?? defaultWebSearch.recencyDaysDefault,
    webSearchMaxConcurrentFetches: settings?.webSearch?.maxConcurrentFetches ?? defaultWebSearch.maxConcurrentFetches,
    videoContextEnabled: settings?.videoContext?.enabled ?? defaultVideoContext.enabled,
    videoContextPerHour: settings?.videoContext?.maxLookupsPerHour ?? defaultVideoContext.maxLookupsPerHour,
    videoContextMaxVideos: settings?.videoContext?.maxVideosPerMessage ?? defaultVideoContext.maxVideosPerMessage,
    videoContextMaxChars: settings?.videoContext?.maxTranscriptChars ?? defaultVideoContext.maxTranscriptChars,
    videoContextKeyframeInterval: settings?.videoContext?.keyframeIntervalSeconds ?? defaultVideoContext.keyframeIntervalSeconds,
    videoContextMaxKeyframes: settings?.videoContext?.maxKeyframesPerVideo ?? defaultVideoContext.maxKeyframesPerVideo,
    videoContextAsrFallback: settings?.videoContext?.allowAsrFallback ?? defaultVideoContext.allowAsrFallback,
    videoContextMaxAsrSeconds: settings?.videoContext?.maxAsrSeconds ?? defaultVideoContext.maxAsrSeconds,
    voiceEnabled: settings?.voice?.enabled ?? defaultVoice.enabled,
    voiceMode: selectedVoiceMode,
    voiceRealtimeReplyStrategy: settings?.voice?.realtimeReplyStrategy ?? defaultVoice.realtimeReplyStrategy,
    voiceAllowNsfwHumor: settings?.voice?.allowNsfwHumor ?? defaultVoice.allowNsfwHumor,
    voiceIntentConfidenceThreshold: settings?.voice?.intentConfidenceThreshold ?? defaultVoice.intentConfidenceThreshold,
    voiceMaxSessionMinutes: settings?.voice?.maxSessionMinutes ?? defaultVoice.maxSessionMinutes,
    voiceInactivityLeaveSeconds: settings?.voice?.inactivityLeaveSeconds ?? defaultVoice.inactivityLeaveSeconds,
    voiceMaxSessionsPerDay: settings?.voice?.maxSessionsPerDay ?? defaultVoice.maxSessionsPerDay,
    voiceReplyEagerness: settings?.voice?.replyEagerness ?? defaultVoice.replyEagerness,
    voiceReplyDecisionLlmEnabled:
      settings?.voice?.replyDecisionLlm?.enabled ?? defaultVoice.replyDecisionLlm.enabled ?? true,
    voiceReplyDecisionLlmProvider:
      settings?.voice?.replyDecisionLlm?.provider ?? defaultVoice.replyDecisionLlm.provider,
    voiceReplyDecisionLlmModel:
      settings?.voice?.replyDecisionLlm?.model ?? defaultVoice.replyDecisionLlm.model,
    voiceGenerationLlmProvider:
      settings?.voice?.generationLlm?.provider ?? defaultVoiceGenerationLlm.provider,
    voiceGenerationLlmModel:
      settings?.voice?.generationLlm?.model ?? defaultVoiceGenerationLlm.model,
    voiceAllowedChannelIds: formatList(settings?.voice?.allowedVoiceChannelIds),
    voiceBlockedChannelIds: formatList(settings?.voice?.blockedVoiceChannelIds),
    voiceBlockedUserIds: formatList(settings?.voice?.blockedVoiceUserIds),
    voiceXaiVoice: settings?.voice?.xai?.voice ?? defaultVoiceXai.voice,
    voiceXaiAudioFormat: settings?.voice?.xai?.audioFormat ?? defaultVoiceXai.audioFormat,
    voiceXaiSampleRateHz: settings?.voice?.xai?.sampleRateHz ?? defaultVoiceXai.sampleRateHz,
    voiceXaiRegion: settings?.voice?.xai?.region ?? defaultVoiceXai.region,
    voiceOpenAiRealtimeModel: settings?.voice?.openaiRealtime?.model ?? defaultVoiceOpenAiRealtime.model,
    voiceOpenAiRealtimeVoice: settings?.voice?.openaiRealtime?.voice ?? defaultVoiceOpenAiRealtime.voice,
    voiceOpenAiRealtimeInputAudioFormat: settings?.voice?.openaiRealtime?.inputAudioFormat ?? defaultVoiceOpenAiRealtime.inputAudioFormat,
    voiceOpenAiRealtimeOutputAudioFormat: settings?.voice?.openaiRealtime?.outputAudioFormat ?? defaultVoiceOpenAiRealtime.outputAudioFormat,
    voiceOpenAiRealtimeInputTranscriptionModel:
      settings?.voice?.openaiRealtime?.inputTranscriptionModel ?? defaultVoiceOpenAiRealtime.inputTranscriptionModel,
    voiceGeminiRealtimeModel:
      settings?.voice?.geminiRealtime?.model ?? defaultVoiceGeminiRealtime.model,
    voiceGeminiRealtimeVoice: settings?.voice?.geminiRealtime?.voice ?? defaultVoiceGeminiRealtime.voice,
    voiceGeminiRealtimeApiBaseUrl:
      settings?.voice?.geminiRealtime?.apiBaseUrl ?? defaultVoiceGeminiRealtime.apiBaseUrl,
    voiceGeminiRealtimeInputSampleRateHz: settings?.voice?.geminiRealtime?.inputSampleRateHz ?? defaultVoiceGeminiRealtime.inputSampleRateHz,
    voiceGeminiRealtimeOutputSampleRateHz: settings?.voice?.geminiRealtime?.outputSampleRateHz ?? defaultVoiceGeminiRealtime.outputSampleRateHz,
    voiceSttTranscriptionModel: settings?.voice?.sttPipeline?.transcriptionModel ?? defaultVoiceSttPipeline.transcriptionModel,
    voiceSttTtsModel: settings?.voice?.sttPipeline?.ttsModel ?? defaultVoiceSttPipeline.ttsModel,
    voiceSttTtsVoice: settings?.voice?.sttPipeline?.ttsVoice ?? defaultVoiceSttPipeline.ttsVoice,
    voiceSttTtsSpeed: settings?.voice?.sttPipeline?.ttsSpeed ?? defaultVoiceSttPipeline.ttsSpeed,
    voiceStreamWatchEnabled: settings?.voice?.streamWatch?.enabled ?? defaultVoiceStreamWatch.enabled,
    voiceStreamWatchMinCommentaryIntervalSeconds:
      settings?.voice?.streamWatch?.minCommentaryIntervalSeconds ?? defaultVoiceStreamWatch.minCommentaryIntervalSeconds,
    voiceStreamWatchMaxFramesPerMinute: settings?.voice?.streamWatch?.maxFramesPerMinute ?? defaultVoiceStreamWatch.maxFramesPerMinute,
    voiceStreamWatchMaxFrameBytes: settings?.voice?.streamWatch?.maxFrameBytes ?? defaultVoiceStreamWatch.maxFrameBytes,
    voiceSoundboardEnabled: settings?.voice?.soundboard?.enabled ?? defaultVoiceSoundboard.enabled,
    voiceSoundboardAllowExternalSounds: settings?.voice?.soundboard?.allowExternalSounds ?? defaultVoiceSoundboard.allowExternalSounds,
    voiceSoundboardPreferredSoundIds: formatList(settings?.voice?.soundboard?.preferredSoundIds),
    maxMessages: settings?.permissions?.maxMessagesPerHour ?? defaultPermissions.maxMessagesPerHour,
    maxReactions: settings?.permissions?.maxReactionsPerHour ?? defaultPermissions.maxReactionsPerHour,
    catchupEnabled: settings?.startup?.catchupEnabled !== false,
    catchupLookbackHours: settings?.startup?.catchupLookbackHours ?? defaultStartup.catchupLookbackHours,
    catchupMaxMessages: settings?.startup?.catchupMaxMessagesPerChannel ?? defaultStartup.catchupMaxMessagesPerChannel,
    catchupMaxReplies: settings?.startup?.maxCatchupRepliesPerChannel ?? defaultStartup.maxCatchupRepliesPerChannel,
    autonomousInitiativeEnabled: settings?.initiative?.enabled ?? defaultInitiative.enabled,
    initiativePostsPerDay: settings?.initiative?.maxPostsPerDay ?? defaultInitiative.maxPostsPerDay,
    initiativeMinMinutes: settings?.initiative?.minMinutesBetweenPosts ?? defaultInitiative.minMinutesBetweenPosts,
    initiativePacingMode: settings?.initiative?.pacingMode === "spontaneous" ? "spontaneous" : "even",
    initiativeSpontaneity: settings?.initiative?.spontaneity ?? defaultInitiative.spontaneity,
    initiativeStartupPost: settings?.initiative?.postOnStartup ?? defaultInitiative.postOnStartup,
    initiativeImageEnabled: settings?.initiative?.allowImagePosts ?? defaultInitiative.allowImagePosts,
    initiativeVideoEnabled: settings?.initiative?.allowVideoPosts ?? defaultInitiative.allowVideoPosts,
    replyImageEnabled: settings?.initiative?.allowReplyImages ?? defaultInitiative.allowReplyImages,
    replyVideoEnabled: settings?.initiative?.allowReplyVideos ?? defaultInitiative.allowReplyVideos,
    replyGifEnabled: settings?.initiative?.allowReplyGifs ?? defaultInitiative.allowReplyGifs,
    maxImagesPerDay: settings?.initiative?.maxImagesPerDay ?? defaultInitiative.maxImagesPerDay,
    maxVideosPerDay: settings?.initiative?.maxVideosPerDay ?? defaultInitiative.maxVideosPerDay,
    maxGifsPerDay: settings?.initiative?.maxGifsPerDay ?? defaultInitiative.maxGifsPerDay,
    initiativeSimpleImageModel: settings?.initiative?.simpleImageModel ?? defaultInitiative.simpleImageModel,
    initiativeComplexImageModel: settings?.initiative?.complexImageModel ?? defaultInitiative.complexImageModel,
    initiativeVideoModel: settings?.initiative?.videoModel ?? defaultInitiative.videoModel,
    initiativeAllowedImageModels: formatList(settings?.initiative?.allowedImageModels ?? []),
    initiativeAllowedVideoModels: formatList(settings?.initiative?.allowedVideoModels ?? []),
    initiativeDiscoveryEnabled: settings?.initiative?.discovery?.enabled ?? defaultDiscovery.enabled,
    initiativeDiscoveryLinkChance: settings?.initiative?.discovery?.linkChancePercent ?? defaultDiscovery.linkChancePercent,
    initiativeDiscoveryMaxLinks: settings?.initiative?.discovery?.maxLinksPerPost ?? defaultDiscovery.maxLinksPerPost,
    initiativeDiscoveryMaxCandidates: settings?.initiative?.discovery?.maxCandidatesForPrompt ?? defaultDiscovery.maxCandidatesForPrompt,
    initiativeDiscoveryFreshnessHours: settings?.initiative?.discovery?.freshnessHours ?? defaultDiscovery.freshnessHours,
    initiativeDiscoveryDedupeHours: settings?.initiative?.discovery?.dedupeHours ?? defaultDiscovery.dedupeHours,
    initiativeDiscoveryRandomness: settings?.initiative?.discovery?.randomness ?? defaultDiscovery.randomness,
    initiativeDiscoveryFetchLimit: settings?.initiative?.discovery?.sourceFetchLimit ?? defaultDiscovery.sourceFetchLimit,
    initiativeDiscoveryAllowNsfw: settings?.initiative?.discovery?.allowNsfw ?? defaultDiscovery.allowNsfw,
    initiativeDiscoverySourceReddit: settings?.initiative?.discovery?.sources?.reddit ?? defaultDiscovery.sources.reddit,
    initiativeDiscoverySourceHackerNews: settings?.initiative?.discovery?.sources?.hackerNews ?? defaultDiscovery.sources.hackerNews,
    initiativeDiscoverySourceYoutube: settings?.initiative?.discovery?.sources?.youtube ?? defaultDiscovery.sources.youtube,
    initiativeDiscoverySourceRss: settings?.initiative?.discovery?.sources?.rss ?? defaultDiscovery.sources.rss,
    initiativeDiscoverySourceX: settings?.initiative?.discovery?.sources?.x ?? defaultDiscovery.sources.x,
    initiativeDiscoveryPreferredTopics: formatList(settings?.initiative?.discovery?.preferredTopics),
    initiativeDiscoveryRedditSubs: formatList(settings?.initiative?.discovery?.redditSubreddits),
    initiativeDiscoveryYoutubeChannels: formatList(settings?.initiative?.discovery?.youtubeChannelIds),
    initiativeDiscoveryRssFeeds: formatList(settings?.initiative?.discovery?.rssFeeds),
    initiativeDiscoveryXHandles: formatList(settings?.initiative?.discovery?.xHandles),
    initiativeDiscoveryXNitterBase:
      settings?.initiative?.discovery?.xNitterBaseUrl ?? defaultDiscovery.xNitterBaseUrl,
    initiativeChannels: formatList(settings?.permissions?.initiativeChannelIds),
    allowedChannels: formatList(settings?.permissions?.allowedChannelIds),
    blockedChannels: formatList(settings?.permissions?.blockedChannelIds),
    blockedUsers: formatList(settings?.permissions?.blockedUserIds)
  };
}

export function formToSettingsPatch(form) {
  return {
    botName: form.botName.trim(),
    persona: {
      flavor: form.personaFlavor.trim(),
      hardLimits: parseLineList(form.personaHardLimits)
    },
    prompt: {
      capabilityHonestyLine: String(form.promptCapabilityHonestyLine || "").trim(),
      impossibleActionLine: String(form.promptImpossibleActionLine || "").trim(),
      memoryEnabledLine: String(form.promptMemoryEnabledLine || "").trim(),
      memoryDisabledLine: String(form.promptMemoryDisabledLine || "").trim(),
      skipLine: String(form.promptSkipLine || "").trim(),
      textGuidance: parseLineList(form.promptTextGuidance),
      voiceGuidance: parseLineList(form.promptVoiceGuidance),
      voiceOperationalGuidance: parseLineList(form.promptVoiceOperationalGuidance),
      mediaPromptCraftGuidance: String(form.promptMediaPromptCraftGuidance || "").trim()
    },
    activity: {
      replyLevelInitiative: Number(form.replyLevelInitiative),
      replyLevelNonInitiative: Number(form.replyLevelNonInitiative),
      reactionLevel: Number(form.reactionLevel),
      minSecondsBetweenMessages: Number(form.minGap)
    },
    llm: {
      provider: form.provider,
      model: form.model.trim(),
      temperature: Number(form.temperature),
      maxOutputTokens: Number(form.maxTokens)
    },
    replyFollowupLlm: {
      enabled: Boolean(form.replyFollowupLlmEnabled),
      provider: String(form.replyFollowupLlmProvider || "").trim(),
      model: String(form.replyFollowupLlmModel || "").trim()
    },
    memoryLlm: {
      provider: String(form.memoryLlmProvider || "").trim(),
      model: String(form.memoryLlmModel || "").trim()
    },
    webSearch: {
      enabled: form.webSearchEnabled,
      maxSearchesPerHour: Number(form.webSearchPerHour),
      maxResults: Number(form.webSearchMaxResults),
      maxPagesToRead: Number(form.webSearchMaxPages),
      maxCharsPerPage: Number(form.webSearchMaxChars),
      safeSearch: form.webSearchSafeMode,
      providerOrder: parseList(form.webSearchProviderOrder),
      recencyDaysDefault: Number(form.webSearchRecencyDaysDefault),
      maxConcurrentFetches: Number(form.webSearchMaxConcurrentFetches)
    },
    videoContext: {
      enabled: form.videoContextEnabled,
      maxLookupsPerHour: Number(form.videoContextPerHour),
      maxVideosPerMessage: Number(form.videoContextMaxVideos),
      maxTranscriptChars: Number(form.videoContextMaxChars),
      keyframeIntervalSeconds: Number(form.videoContextKeyframeInterval),
      maxKeyframesPerVideo: Number(form.videoContextMaxKeyframes),
      allowAsrFallback: form.videoContextAsrFallback,
      maxAsrSeconds: Number(form.videoContextMaxAsrSeconds)
    },
    voice: {
      enabled: form.voiceEnabled,
      mode: form.voiceMode,
      realtimeReplyStrategy: String(form.voiceRealtimeReplyStrategy || "").trim(),
      allowNsfwHumor: form.voiceAllowNsfwHumor,
      intentConfidenceThreshold: Number(form.voiceIntentConfidenceThreshold),
      maxSessionMinutes: Number(form.voiceMaxSessionMinutes),
      inactivityLeaveSeconds: Number(form.voiceInactivityLeaveSeconds),
      maxSessionsPerDay: Number(form.voiceMaxSessionsPerDay),
      replyEagerness: Number(form.voiceReplyEagerness),
      replyDecisionLlm: {
        enabled: Boolean(form.voiceReplyDecisionLlmEnabled),
        provider: String(form.voiceReplyDecisionLlmProvider || "").trim(),
        model: String(form.voiceReplyDecisionLlmModel || "").trim()
      },
      generationLlm: {
        provider: String(form.voiceGenerationLlmProvider || "").trim(),
        model: String(form.voiceGenerationLlmModel || "").trim()
      },
      allowedVoiceChannelIds: parseList(form.voiceAllowedChannelIds),
      blockedVoiceChannelIds: parseList(form.voiceBlockedChannelIds),
      blockedVoiceUserIds: parseList(form.voiceBlockedUserIds),
      xai: {
        voice: String(form.voiceXaiVoice || "").trim(),
        audioFormat: String(form.voiceXaiAudioFormat || "").trim(),
        sampleRateHz: Number(form.voiceXaiSampleRateHz),
        region: String(form.voiceXaiRegion || "").trim()
      },
      openaiRealtime: {
        model: String(form.voiceOpenAiRealtimeModel || "").trim(),
        voice: String(form.voiceOpenAiRealtimeVoice || "").trim(),
        inputAudioFormat: String(form.voiceOpenAiRealtimeInputAudioFormat || "").trim(),
        outputAudioFormat: String(form.voiceOpenAiRealtimeOutputAudioFormat || "").trim(),
        inputTranscriptionModel: String(form.voiceOpenAiRealtimeInputTranscriptionModel || "").trim()
      },
      geminiRealtime: {
        model: String(form.voiceGeminiRealtimeModel || "").trim(),
        voice: String(form.voiceGeminiRealtimeVoice || "").trim(),
        apiBaseUrl: String(form.voiceGeminiRealtimeApiBaseUrl || "").trim(),
        inputSampleRateHz: Number(form.voiceGeminiRealtimeInputSampleRateHz),
        outputSampleRateHz: Number(form.voiceGeminiRealtimeOutputSampleRateHz)
      },
      sttPipeline: {
        transcriptionModel: String(form.voiceSttTranscriptionModel || "").trim(),
        ttsModel: String(form.voiceSttTtsModel || "").trim(),
        ttsVoice: String(form.voiceSttTtsVoice || "").trim(),
        ttsSpeed: Number(form.voiceSttTtsSpeed)
      },
      streamWatch: {
        enabled: form.voiceStreamWatchEnabled,
        minCommentaryIntervalSeconds: Number(form.voiceStreamWatchMinCommentaryIntervalSeconds),
        maxFramesPerMinute: Number(form.voiceStreamWatchMaxFramesPerMinute),
        maxFrameBytes: Number(form.voiceStreamWatchMaxFrameBytes)
      },
      soundboard: {
        enabled: form.voiceSoundboardEnabled,
        allowExternalSounds: form.voiceSoundboardAllowExternalSounds,
        preferredSoundIds: parseList(form.voiceSoundboardPreferredSoundIds)
      }
    },
    startup: {
      catchupEnabled: form.catchupEnabled,
      catchupLookbackHours: Number(form.catchupLookbackHours),
      catchupMaxMessagesPerChannel: Number(form.catchupMaxMessages),
      maxCatchupRepliesPerChannel: Number(form.catchupMaxReplies)
    },
    permissions: {
      allowReplies: form.allowReplies,
      allowInitiativeReplies: form.allowInitiative,
      allowReactions: form.allowReactions,
      initiativeChannelIds: parseList(form.initiativeChannels),
      allowedChannelIds: parseList(form.allowedChannels),
      blockedChannelIds: parseList(form.blockedChannels),
      blockedUserIds: parseList(form.blockedUsers),
      maxMessagesPerHour: Number(form.maxMessages),
      maxReactionsPerHour: Number(form.maxReactions)
    },
    initiative: {
      enabled: form.autonomousInitiativeEnabled,
      maxPostsPerDay: Number(form.initiativePostsPerDay),
      minMinutesBetweenPosts: Number(form.initiativeMinMinutes),
      pacingMode: form.initiativePacingMode,
      spontaneity: Number(form.initiativeSpontaneity),
      postOnStartup: form.initiativeStartupPost,
      allowImagePosts: form.initiativeImageEnabled,
      allowVideoPosts: form.initiativeVideoEnabled,
      allowReplyImages: form.replyImageEnabled,
      allowReplyVideos: form.replyVideoEnabled,
      allowReplyGifs: form.replyGifEnabled,
      maxImagesPerDay: Number(form.maxImagesPerDay),
      maxVideosPerDay: Number(form.maxVideosPerDay),
      maxGifsPerDay: Number(form.maxGifsPerDay),
      simpleImageModel: form.initiativeSimpleImageModel.trim(),
      complexImageModel: form.initiativeComplexImageModel.trim(),
      videoModel: form.initiativeVideoModel.trim(),
      allowedImageModels: parseList(form.initiativeAllowedImageModels),
      allowedVideoModels: parseList(form.initiativeAllowedVideoModels),
      discovery: {
        enabled: form.initiativeDiscoveryEnabled,
        linkChancePercent: Number(form.initiativeDiscoveryLinkChance),
        maxLinksPerPost: Number(form.initiativeDiscoveryMaxLinks),
        maxCandidatesForPrompt: Number(form.initiativeDiscoveryMaxCandidates),
        freshnessHours: Number(form.initiativeDiscoveryFreshnessHours),
        dedupeHours: Number(form.initiativeDiscoveryDedupeHours),
        randomness: Number(form.initiativeDiscoveryRandomness),
        sourceFetchLimit: Number(form.initiativeDiscoveryFetchLimit),
        allowNsfw: form.initiativeDiscoveryAllowNsfw,
        preferredTopics: parseList(form.initiativeDiscoveryPreferredTopics),
        redditSubreddits: parseList(form.initiativeDiscoveryRedditSubs),
        youtubeChannelIds: parseList(form.initiativeDiscoveryYoutubeChannels),
        rssFeeds: parseList(form.initiativeDiscoveryRssFeeds),
        xHandles: parseList(form.initiativeDiscoveryXHandles),
        xNitterBaseUrl: form.initiativeDiscoveryXNitterBase.trim(),
        sources: {
          reddit: form.initiativeDiscoverySourceReddit,
          hackerNews: form.initiativeDiscoverySourceHackerNews,
          youtube: form.initiativeDiscoverySourceYoutube,
          rss: form.initiativeDiscoverySourceRss,
          x: form.initiativeDiscoverySourceX
        }
      }
    },
    memory: {
      enabled: form.memoryEnabled
    }
  };
}

export function resolveProviderModelOptions(modelCatalog, provider) {
  const key = normalizeLlmProvider(provider);
  const fromCatalog = Array.isArray(modelCatalog?.[key]) ? modelCatalog[key] : [];
  const fallback = PROVIDER_MODEL_FALLBACKS[key] || [];
  return [...new Set([...fromCatalog, ...fallback].map((item) => String(item || "").trim()).filter(Boolean))];
}

export function resolvePresetModelSelection({ modelCatalog, provider, model }) {
  const options = resolveProviderModelOptions(modelCatalog, provider);
  const isClaudeCodeProvider = normalizeLlmProvider(provider) === "claude-code";
  const normalizedModel = String(model || "").trim();
  const selectedPresetModel = options.includes(normalizedModel)
    ? normalizedModel
    : isClaudeCodeProvider
      ? (options[0] || "")
      : CUSTOM_MODEL_OPTION_VALUE;

  return {
    options,
    isClaudeCodeProvider,
    selectedPresetModel
  };
}
