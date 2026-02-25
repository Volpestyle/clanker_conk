export const DEFAULT_SETTINGS = {
  botName: "clanker conk",
  persona: {
    flavor: "playful, chaotic-good, slangy Gen Z/Gen A energy without being toxic",
    shortReplyBias: true,
    hardLimits: [
      "Cannot join voice channels.",
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
    safeSearch: true
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
    allowReplyImages: false,
    maxImagesPerDay: 10,
    imagePostChancePercent: 25,
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
    maxHighlights: 16
  }
};
