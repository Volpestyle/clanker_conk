export const CUSTOM_MODEL_OPTION_VALUE = "__custom_model__";

const PROVIDER_MODEL_FALLBACKS = {
  openai: ["gpt-4.1-mini"],
  anthropic: ["claude-haiku-4-5"],
  xai: ["grok-3-mini-latest"],
  "claude-code": ["sonnet"]
};

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
  const activity = settings?.activity || {};
  return {
    botName: settings?.botName || "clanker conk",
    personaFlavor:
      settings?.persona?.flavor || "playful, chaotic-good, slangy Gen Z/Gen A energy without being toxic",
    personaHardLimits: formatList(settings?.persona?.hardLimits),
    replyLevel: activity.replyLevel ?? 35,
    reactionLevel: activity.reactionLevel ?? 20,
    minGap: activity.minSecondsBetweenMessages ?? 20,
    allowReplies: settings?.permissions?.allowReplies ?? true,
    allowInitiative: settings?.permissions?.allowInitiativeReplies !== false,
    allowReactions: settings?.permissions?.allowReactions ?? true,
    memoryEnabled: settings?.memory?.enabled ?? true,
    provider: settings?.llm?.provider ?? "openai",
    model: settings?.llm?.model ?? "gpt-4.1-mini",
    temperature: settings?.llm?.temperature ?? 0.9,
    maxTokens: settings?.llm?.maxOutputTokens ?? 220,
    webSearchEnabled: settings?.webSearch?.enabled ?? false,
    webSearchSafeMode: settings?.webSearch?.safeSearch ?? true,
    webSearchPerHour: settings?.webSearch?.maxSearchesPerHour ?? 12,
    webSearchMaxResults: settings?.webSearch?.maxResults ?? 5,
    webSearchMaxPages: settings?.webSearch?.maxPagesToRead ?? 3,
    webSearchMaxChars: settings?.webSearch?.maxCharsPerPage ?? 1400,
    webSearchProviderOrder: (settings?.webSearch?.providerOrder || ["brave", "serpapi"]).join(","),
    webSearchRecencyDaysDefault: settings?.webSearch?.recencyDaysDefault ?? 30,
    webSearchMaxConcurrentFetches: settings?.webSearch?.maxConcurrentFetches ?? 5,
    videoContextEnabled: settings?.videoContext?.enabled ?? true,
    videoContextPerHour: settings?.videoContext?.maxLookupsPerHour ?? 12,
    videoContextMaxVideos: settings?.videoContext?.maxVideosPerMessage ?? 2,
    videoContextMaxChars: settings?.videoContext?.maxTranscriptChars ?? 1200,
    videoContextKeyframeInterval: settings?.videoContext?.keyframeIntervalSeconds ?? 8,
    videoContextMaxKeyframes: settings?.videoContext?.maxKeyframesPerVideo ?? 3,
    videoContextAsrFallback: settings?.videoContext?.allowAsrFallback ?? false,
    videoContextMaxAsrSeconds: settings?.videoContext?.maxAsrSeconds ?? 120,
    voiceEnabled: settings?.voice?.enabled ?? false,
    voiceMode: settings?.voice?.mode ?? "voice_agent",
    voiceJoinOnTextNL: settings?.voice?.joinOnTextNL ?? true,
    voiceIntentConfidenceThreshold: settings?.voice?.intentConfidenceThreshold ?? 0.75,
    voiceMaxSessionMinutes: settings?.voice?.maxSessionMinutes ?? 10,
    voiceInactivityLeaveSeconds: settings?.voice?.inactivityLeaveSeconds ?? 90,
    voiceMaxSessionsPerDay: settings?.voice?.maxSessionsPerDay ?? 12,
    voiceReplyEagerness: settings?.voice?.replyEagerness ?? 0,
    voiceEagerCooldownSeconds: settings?.voice?.eagerCooldownSeconds ?? 45,
    voiceReplyDecisionLlmProvider: settings?.voice?.replyDecisionLlm?.provider ?? "anthropic",
    voiceReplyDecisionLlmModel: settings?.voice?.replyDecisionLlm?.model ?? "claude-haiku-4-5",
    voiceAllowedChannelIds: formatList(settings?.voice?.allowedVoiceChannelIds),
    voiceBlockedChannelIds: formatList(settings?.voice?.blockedVoiceChannelIds),
    voiceBlockedUserIds: formatList(settings?.voice?.blockedVoiceUserIds),
    voiceXaiVoice: settings?.voice?.xai?.voice ?? "Rex",
    voiceXaiAudioFormat: settings?.voice?.xai?.audioFormat ?? "audio/pcm",
    voiceXaiSampleRateHz: settings?.voice?.xai?.sampleRateHz ?? 24000,
    voiceXaiRegion: settings?.voice?.xai?.region ?? "us-east-1",
    voiceOpenAiRealtimeModel: settings?.voice?.openaiRealtime?.model ?? "gpt-realtime",
    voiceOpenAiRealtimeVoice: settings?.voice?.openaiRealtime?.voice ?? "alloy",
    voiceOpenAiRealtimeInputAudioFormat: settings?.voice?.openaiRealtime?.inputAudioFormat ?? "pcm16",
    voiceOpenAiRealtimeOutputAudioFormat: settings?.voice?.openaiRealtime?.outputAudioFormat ?? "pcm16",
    voiceOpenAiRealtimeInputSampleRateHz: settings?.voice?.openaiRealtime?.inputSampleRateHz ?? 24000,
    voiceOpenAiRealtimeOutputSampleRateHz: settings?.voice?.openaiRealtime?.outputSampleRateHz ?? 24000,
    voiceOpenAiRealtimeInputTranscriptionModel:
      settings?.voice?.openaiRealtime?.inputTranscriptionModel ?? "gpt-4o-mini-transcribe",
    voiceOpenAiRealtimeAllowNsfwHumor: settings?.voice?.openaiRealtime?.allowNsfwHumor ?? true,
    voiceGeminiRealtimeModel:
      settings?.voice?.geminiRealtime?.model ?? "gemini-2.5-flash-native-audio-preview-12-2025",
    voiceGeminiRealtimeVoice: settings?.voice?.geminiRealtime?.voice ?? "Aoede",
    voiceGeminiRealtimeApiBaseUrl:
      settings?.voice?.geminiRealtime?.apiBaseUrl ?? "https://generativelanguage.googleapis.com",
    voiceGeminiRealtimeInputSampleRateHz: settings?.voice?.geminiRealtime?.inputSampleRateHz ?? 16000,
    voiceGeminiRealtimeOutputSampleRateHz: settings?.voice?.geminiRealtime?.outputSampleRateHz ?? 24000,
    voiceGeminiRealtimeAllowNsfwHumor: settings?.voice?.geminiRealtime?.allowNsfwHumor ?? true,
    voiceSttTranscriptionModel: settings?.voice?.sttPipeline?.transcriptionModel ?? "gpt-4o-mini-transcribe",
    voiceSttTtsModel: settings?.voice?.sttPipeline?.ttsModel ?? "gpt-4o-mini-tts",
    voiceSttTtsVoice: settings?.voice?.sttPipeline?.ttsVoice ?? "alloy",
    voiceSttTtsSpeed: settings?.voice?.sttPipeline?.ttsSpeed ?? 1,
    voiceStreamWatchEnabled: settings?.voice?.streamWatch?.enabled ?? true,
    voiceStreamWatchMinCommentaryIntervalSeconds:
      settings?.voice?.streamWatch?.minCommentaryIntervalSeconds ?? 8,
    voiceStreamWatchMaxFramesPerMinute: settings?.voice?.streamWatch?.maxFramesPerMinute ?? 180,
    voiceStreamWatchMaxFrameBytes: settings?.voice?.streamWatch?.maxFrameBytes ?? 350000,
    voiceSoundboardEnabled: settings?.voice?.soundboard?.enabled ?? true,
    voiceSoundboardAllowExternalSounds: settings?.voice?.soundboard?.allowExternalSounds ?? false,
    voiceSoundboardPreferredSoundIds: formatList(settings?.voice?.soundboard?.preferredSoundIds),
    maxMessages: settings?.permissions?.maxMessagesPerHour ?? 20,
    maxReactions: settings?.permissions?.maxReactionsPerHour ?? 24,
    catchupEnabled: settings?.startup?.catchupEnabled !== false,
    catchupLookbackHours: settings?.startup?.catchupLookbackHours ?? 6,
    catchupMaxMessages: settings?.startup?.catchupMaxMessagesPerChannel ?? 20,
    catchupMaxReplies: settings?.startup?.maxCatchupRepliesPerChannel ?? 2,
    autonomousInitiativeEnabled: settings?.initiative?.enabled ?? false,
    initiativePostsPerDay: settings?.initiative?.maxPostsPerDay ?? 6,
    initiativeMinMinutes: settings?.initiative?.minMinutesBetweenPosts ?? 120,
    initiativePacingMode: settings?.initiative?.pacingMode === "spontaneous" ? "spontaneous" : "even",
    initiativeSpontaneity: settings?.initiative?.spontaneity ?? 65,
    initiativeStartupPost: settings?.initiative?.postOnStartup ?? false,
    initiativeImageEnabled: settings?.initiative?.allowImagePosts ?? false,
    initiativeVideoEnabled: settings?.initiative?.allowVideoPosts ?? false,
    replyImageEnabled: settings?.initiative?.allowReplyImages ?? false,
    replyVideoEnabled: settings?.initiative?.allowReplyVideos ?? false,
    replyGifEnabled: settings?.initiative?.allowReplyGifs ?? false,
    maxImagesPerDay: settings?.initiative?.maxImagesPerDay ?? 10,
    maxVideosPerDay: settings?.initiative?.maxVideosPerDay ?? 6,
    maxGifsPerDay: settings?.initiative?.maxGifsPerDay ?? 30,
    initiativeSimpleImageModel: settings?.initiative?.simpleImageModel ?? "gpt-image-1.5",
    initiativeComplexImageModel: settings?.initiative?.complexImageModel ?? "grok-imagine-image",
    initiativeVideoModel: settings?.initiative?.videoModel ?? "grok-imagine-video",
    initiativeAllowedImageModels: formatList(settings?.initiative?.allowedImageModels ?? []),
    initiativeAllowedVideoModels: formatList(settings?.initiative?.allowedVideoModels ?? []),
    initiativeDiscoveryEnabled: settings?.initiative?.discovery?.enabled ?? true,
    initiativeDiscoveryLinkChance: settings?.initiative?.discovery?.linkChancePercent ?? 80,
    initiativeDiscoveryMaxLinks: settings?.initiative?.discovery?.maxLinksPerPost ?? 2,
    initiativeDiscoveryMaxCandidates: settings?.initiative?.discovery?.maxCandidatesForPrompt ?? 6,
    initiativeDiscoveryFreshnessHours: settings?.initiative?.discovery?.freshnessHours ?? 96,
    initiativeDiscoveryDedupeHours: settings?.initiative?.discovery?.dedupeHours ?? 168,
    initiativeDiscoveryRandomness: settings?.initiative?.discovery?.randomness ?? 55,
    initiativeDiscoveryFetchLimit: settings?.initiative?.discovery?.sourceFetchLimit ?? 10,
    initiativeDiscoveryAllowNsfw: settings?.initiative?.discovery?.allowNsfw ?? false,
    initiativeDiscoverySourceReddit: settings?.initiative?.discovery?.sources?.reddit ?? true,
    initiativeDiscoverySourceHackerNews: settings?.initiative?.discovery?.sources?.hackerNews ?? true,
    initiativeDiscoverySourceYoutube: settings?.initiative?.discovery?.sources?.youtube ?? true,
    initiativeDiscoverySourceRss: settings?.initiative?.discovery?.sources?.rss ?? true,
    initiativeDiscoverySourceX: settings?.initiative?.discovery?.sources?.x ?? false,
    initiativeDiscoveryPreferredTopics: formatList(settings?.initiative?.discovery?.preferredTopics),
    initiativeDiscoveryRedditSubs: formatList(settings?.initiative?.discovery?.redditSubreddits),
    initiativeDiscoveryYoutubeChannels: formatList(settings?.initiative?.discovery?.youtubeChannelIds),
    initiativeDiscoveryRssFeeds: formatList(settings?.initiative?.discovery?.rssFeeds),
    initiativeDiscoveryXHandles: formatList(settings?.initiative?.discovery?.xHandles),
    initiativeDiscoveryXNitterBase:
      settings?.initiative?.discovery?.xNitterBaseUrl ?? "https://nitter.net",
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
    activity: {
      replyLevel: Number(form.replyLevel),
      reactionLevel: Number(form.reactionLevel),
      minSecondsBetweenMessages: Number(form.minGap)
    },
    llm: {
      provider: form.provider,
      model: form.model.trim(),
      temperature: Number(form.temperature),
      maxOutputTokens: Number(form.maxTokens)
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
      joinOnTextNL: form.voiceJoinOnTextNL,
      intentConfidenceThreshold: Number(form.voiceIntentConfidenceThreshold),
      maxSessionMinutes: Number(form.voiceMaxSessionMinutes),
      inactivityLeaveSeconds: Number(form.voiceInactivityLeaveSeconds),
      maxSessionsPerDay: Number(form.voiceMaxSessionsPerDay),
      replyEagerness: Number(form.voiceReplyEagerness),
      eagerCooldownSeconds: Number(form.voiceEagerCooldownSeconds),
      replyDecisionLlm: {
        provider: String(form.voiceReplyDecisionLlmProvider || "").trim(),
        model: String(form.voiceReplyDecisionLlmModel || "").trim()
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
        inputSampleRateHz: Number(form.voiceOpenAiRealtimeInputSampleRateHz),
        outputSampleRateHz: Number(form.voiceOpenAiRealtimeOutputSampleRateHz),
        inputTranscriptionModel: String(form.voiceOpenAiRealtimeInputTranscriptionModel || "").trim(),
        allowNsfwHumor: form.voiceOpenAiRealtimeAllowNsfwHumor
      },
      geminiRealtime: {
        model: String(form.voiceGeminiRealtimeModel || "").trim(),
        voice: String(form.voiceGeminiRealtimeVoice || "").trim(),
        apiBaseUrl: String(form.voiceGeminiRealtimeApiBaseUrl || "").trim(),
        inputSampleRateHz: Number(form.voiceGeminiRealtimeInputSampleRateHz),
        outputSampleRateHz: Number(form.voiceGeminiRealtimeOutputSampleRateHz),
        allowNsfwHumor: form.voiceGeminiRealtimeAllowNsfwHumor
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
  const key = normalizeProviderKey(provider);
  const fromCatalog = Array.isArray(modelCatalog?.[key]) ? modelCatalog[key] : [];
  const fallback = PROVIDER_MODEL_FALLBACKS[key] || [];
  return [...new Set([...fromCatalog, ...fallback].map((item) => String(item || "").trim()).filter(Boolean))];
}

function normalizeProviderKey(provider) {
  const normalized = String(provider || "")
    .trim()
    .toLowerCase();
  if (normalized === "anthropic") return "anthropic";
  if (normalized === "xai") return "xai";
  if (normalized === "claude-code") return "claude-code";
  return "openai";
}
