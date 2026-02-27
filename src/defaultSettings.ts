export const DEFAULT_SETTINGS = {
  botName: "clanker conk",
  persona: {
    flavor: "playful, chaotic-good, slangy Gen Z/Gen A energy without being toxic",
    hardLimits: [
      "Cannot play non-text games.",
      "Cannot perform real-world actions.",
      "Cannot access private data beyond visible channel history."
    ]
  },
  activity: {
    replyLevel: 35,
    reactionLevel: 20,
    minSecondsBetweenMessages: 20,
    replyCoalesceWindowSeconds: 4,
    replyCoalesceMaxMessages: 6
  },
  llm: {
    provider: "openai",
    model: "gpt-4.1-mini",
    temperature: 0.9,
    maxOutputTokens: 220,
    pricing: {}
  },
  webSearch: {
    enabled: false,
    maxSearchesPerHour: 20,
    maxResults: 5,
    maxPagesToRead: 3,
    maxCharsPerPage: 1400,
    safeSearch: true,
    providerOrder: ["brave", "serpapi"],
    recencyDaysDefault: 30,
    maxConcurrentFetches: 5
  },
  videoContext: {
    enabled: true,
    maxLookupsPerHour: 12,
    maxVideosPerMessage: 2,
    maxTranscriptChars: 1200,
    keyframeIntervalSeconds: 8,
    maxKeyframesPerVideo: 3,
    allowAsrFallback: false,
    maxAsrSeconds: 120
  },
  voice: {
    enabled: false,
    mode: "voice_agent",
    intentConfidenceThreshold: 0.75,
    maxSessionMinutes: 10,
    inactivityLeaveSeconds: 90,
    maxSessionsPerDay: 12,
    maxConcurrentSessions: 1,
    allowedVoiceChannelIds: [],
    blockedVoiceChannelIds: [],
    blockedVoiceUserIds: [],
    replyEagerness: 0,
    replyDecisionLlm: {
      provider: "anthropic",
      model: "claude-haiku-4-5",
      maxAttempts: 1
    },
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
      inputSampleRateHz: 24000,
      outputSampleRateHz: 24000,
      inputTranscriptionModel: "gpt-4o-mini-transcribe",
      allowNsfwHumor: true
    },
    geminiRealtime: {
      model: "gemini-2.5-flash-native-audio-preview-12-2025",
      voice: "Aoede",
      apiBaseUrl: "https://generativelanguage.googleapis.com",
      inputSampleRateHz: 16000,
      outputSampleRateHz: 24000,
      allowNsfwHumor: true
    },
    sttPipeline: {
      transcriptionModel: "gpt-4o-mini-transcribe",
      ttsModel: "gpt-4o-mini-tts",
      ttsVoice: "alloy",
      ttsSpeed: 1
    },
    streamWatch: {
      enabled: true,
      minCommentaryIntervalSeconds: 8,
      maxFramesPerMinute: 180,
      maxFrameBytes: 350000
    },
    soundboard: {
      enabled: true,
      allowExternalSounds: false,
      preferredSoundIds: []
    }
  },
  startup: {
    catchupEnabled: true,
    catchupLookbackHours: 6,
    catchupMaxMessagesPerChannel: 20,
    maxCatchupRepliesPerChannel: 2
  },
  permissions: {
    allowReplies: true,
    allowInitiativeReplies: true,
    allowReactions: true,
    initiativeChannelIds: [],
    allowedChannelIds: [],
    blockedChannelIds: [],
    blockedUserIds: [],
    maxMessagesPerHour: 20,
    maxReactionsPerHour: 24
  },
  initiative: {
    enabled: false,
    maxPostsPerDay: 6,
    minMinutesBetweenPosts: 120,
    pacingMode: "even",
    spontaneity: 65,
    postOnStartup: false,
    allowImagePosts: false,
    allowVideoPosts: false,
    allowReplyImages: false,
    allowReplyVideos: false,
    allowReplyGifs: false,
    maxImagesPerDay: 10,
    maxVideosPerDay: 6,
    maxGifsPerDay: 30,
    simpleImageModel: "gpt-image-1.5",
    complexImageModel: "grok-imagine-image",
    videoModel: "grok-imagine-video",
    allowedImageModels: ["gpt-image-1.5", "grok-imagine-image", "grok-2-image-1212"],
    allowedVideoModels: ["grok-imagine-video", "grok-2-video"],
    maxMediaPromptChars: 900,
    discovery: {
      enabled: true,
      linkChancePercent: 80,
      maxLinksPerPost: 2,
      maxCandidatesForPrompt: 6,
      freshnessHours: 96,
      dedupeHours: 168,
      randomness: 55,
      sourceFetchLimit: 10,
      allowNsfw: false,
      preferredTopics: [],
      redditSubreddits: ["technology", "programming", "games", "memes"],
      youtubeChannelIds: [],
      rssFeeds: [
        "https://www.theverge.com/rss/index.xml",
        "https://feeds.arstechnica.com/arstechnica/index"
      ],
      xHandles: [],
      xNitterBaseUrl: "https://nitter.net",
      sources: {
        reddit: true,
        hackerNews: true,
        youtube: true,
        rss: true,
        x: false
      }
    }
  },
  memoryLlm: {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    temperature: 0,
    maxOutputTokens: 320
  },
  memory: {
    enabled: true,
    maxRecentMessages: 35,
    embeddingModel: "text-embedding-3-small"
  }
};
