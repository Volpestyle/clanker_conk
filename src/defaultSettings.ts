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
    minSecondsBetweenMessages: 20
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
    maxSearchesPerHour: 12,
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
    joinOnTextNL: true,
    requireDirectMentionForJoin: true,
    intentConfidenceThreshold: 0.75,
    maxSessionMinutes: 10,
    inactivityLeaveSeconds: 90,
    maxSessionsPerDay: 12,
    maxConcurrentSessions: 1,
    allowedVoiceChannelIds: [],
    blockedVoiceChannelIds: [],
    blockedVoiceUserIds: [],
    xai: {
      voice: "Rex",
      audioFormat: "audio/pcm",
      sampleRateHz: 24000,
      region: "us-east-1"
    },
    soundboard: {
      enabled: true,
      allowExternalSounds: false,
      preferredSoundIds: [],
      mappings: {}
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
  memory: {
    enabled: true,
    maxRecentMessages: 35,
    embeddingModel: "text-embedding-3-small"
  }
};
