export function createAutomationControlRuntime(bot) {
  return {
    store: bot.store,
    client: bot.client,
    isChannelAllowed: (settings, channelId) => bot.isChannelAllowed(settings, channelId),
    maybeRunAutomationCycle: () => bot.maybeRunAutomationCycle()
  };
}

export function createVoiceReplyRuntime(bot) {
  return {
    llm: bot.llm,
    store: bot.store,
    memory: bot.memory,
    client: bot.client,
    loadRelevantMemoryFacts: (payload) => bot.loadRelevantMemoryFacts(payload),
    buildMediaMemoryFacts: (payload) => bot.buildMediaMemoryFacts(payload),
    loadPromptMemorySlice: (payload) => bot.loadPromptMemorySlice(payload)
  };
}

export function createReplyFollowupRuntime(bot) {
  return {
    llm: bot.llm,
    search: bot.search,
    memory: bot.memory
  };
}

export function createMentionResolutionRuntime(bot) {
  return {
    store: bot.store
  };
}

export function createReplyAdmissionRuntime(bot) {
  return {
    botUserId: String(bot.client.user?.id || "").trim(),
    isDirectlyAddressed: (settings, message) => bot.isDirectlyAddressed(settings, message)
  };
}

export function createStartupCatchupRuntime(bot) {
  return {
    botUserId: String(bot.client.user?.id || "").trim(),
    store: bot.store,
    getStartupScanChannels: (settings) => bot.getStartupScanChannels(settings),
    hydrateRecentMessages: (channel, limit) => bot.hydrateRecentMessages(channel, limit),
    isChannelAllowed: (settings, channelId) => bot.isChannelAllowed(settings, channelId),
    isUserBlocked: (settings, userId) => bot.isUserBlocked(settings, userId),
    getReplyAddressSignal: (settings, message, recentMessages) =>
      bot.getReplyAddressSignal(settings, message, recentMessages),
    hasStartupFollowupAfterMessage: (payload) => bot.hasStartupFollowupAfterMessage(payload),
    enqueueReplyJob: (payload) => bot.enqueueReplyJob(payload)
  };
}
