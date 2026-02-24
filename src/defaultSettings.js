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
    postOnStartup: false,
    allowImagePosts: false,
    imagePostChancePercent: 25,
    imageModel: "gpt-image-1"
  },
  memory: {
    enabled: true,
    maxRecentMessages: 35,
    maxHighlights: 16
  }
};
