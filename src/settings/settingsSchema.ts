import {
  VOICE_REPLY_DECIDER_SYSTEM_PROMPT_COMPACT_DEFAULT,
  VOICE_REPLY_DECIDER_SYSTEM_PROMPT_FULL_DEFAULT,
  VOICE_REPLY_DECIDER_SYSTEM_PROMPT_STRICT_DEFAULT,
  VOICE_REPLY_DECIDER_WAKE_VARIANT_HINT_DEFAULT
} from "../promptCore.ts";

export const PROVIDER_MODEL_FALLBACKS = {
  openai: ["claude-haiku-4-5"],
  anthropic: ["claude-haiku-4-5"],
  xai: ["grok-3-mini-latest"],
  "claude-code": ["sonnet"]
};

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
  prompt: {
    capabilityHonestyLine: "Never claim capabilities you do not have.",
    impossibleActionLine: "If asked to do something impossible, say it casually and suggest a text-only alternative.",
    memoryEnabledLine:
      "You have persistent memory across conversations via saved durable facts and logs. Do not claim each conversation starts from zero.",
    memoryDisabledLine:
      "Persistent memory is disabled right now. Do not claim long-term memory across separate conversations.",
    skipLine: "If you should not send a message, output exactly [SKIP].",
    textGuidance: [
      "Write like a person in chat, not like an assistant.",
      "Use occasional slang naturally (not every sentence).",
      "You're chill, but eager to be helpful whenever it makes sense.",
      "Default to short messages but go longer when the conversation calls for it.",
      "Use server emoji tokens in text only when necessary and when they enhance the message."
    ],
    voiceGuidance: [
      "Talk like a person hanging out, not like an assistant.",
      "You're chill, but eager to be helpful whenever it makes sense.",
      "Use occasional slang naturally (not every sentence)."
    ],
    voiceOperationalGuidance: [
      "Keep it chill and simple. No overexplaining.",
      "Clearly state what happened and why, especially when a request is blocked.",
      "If relevant, mention required permissions/settings plainly.",
      "Avoid dramatic wording, blame, apology spirals, and long postmortems."
    ],
    mediaPromptCraftGuidance: [
      "Write media prompts as vivid scene descriptions, not abstract concepts.",
      "Include: subject/action, visual style or medium (photo, illustration, 3D render, pixel art, etc.), lighting/mood, camera angle or framing, and color palette when relevant.",
      "Be specific: 'a golden retriever leaping through autumn leaves, warm backlit sunset, low angle, film grain' beats 'a dog outside'.",
      "For video prompts, describe the motion arc: what starts, what changes, and how it ends.",
      "Never put text, words, or UI elements in media prompts."
    ].join(" ")
  },
  activity: {
    replyLevelInitiative: 35,
    replyLevelNonInitiative: 25,
    reactionLevel: 20,
    minSecondsBetweenMessages: 5,
    replyCoalesceWindowSeconds: 4,
    replyCoalesceMaxMessages: 6
  },
  llm: {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    temperature: 0.9,
    maxOutputTokens: 220,
    pricing: {}
  },
  replyFollowupLlm: {
    enabled: false,
    provider: "anthropic",
    model: "claude-haiku-4-5"
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
    realtimeReplyStrategy: "brain",
    allowNsfwHumor: true,
    intentConfidenceThreshold: 0.75,
    maxSessionMinutes: 10,
    inactivityLeaveSeconds: 90,
    maxSessionsPerDay: 12,
    maxConcurrentSessions: 1,
    allowedVoiceChannelIds: [],
    blockedVoiceChannelIds: [],
    blockedVoiceUserIds: [],
    replyEagerness: 0,
    generationLlm: {
      provider: "anthropic",
      model: "claude-haiku-4-5"
    },
    replyDecisionLlm: {
      enabled: true,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      maxAttempts: 1,
      reasoningEffort: "minimal",
      prompts: {
        wakeVariantHint: VOICE_REPLY_DECIDER_WAKE_VARIANT_HINT_DEFAULT,
        systemPromptCompact: VOICE_REPLY_DECIDER_SYSTEM_PROMPT_COMPACT_DEFAULT,
        systemPromptFull: VOICE_REPLY_DECIDER_SYSTEM_PROMPT_FULL_DEFAULT,
        systemPromptStrict: VOICE_REPLY_DECIDER_SYSTEM_PROMPT_STRICT_DEFAULT
      }
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
