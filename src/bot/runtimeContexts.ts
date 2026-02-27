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
