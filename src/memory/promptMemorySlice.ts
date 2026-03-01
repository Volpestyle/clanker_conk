function emptyRows() {
  return [];
}

export function emptyPromptMemorySlice() {
  return {
    userFacts: emptyRows(),
    relevantFacts: emptyRows(),
    relevantMessages: emptyRows()
  };
}

export function normalizePromptMemorySlice(slice) {
  return {
    userFacts: Array.isArray(slice?.userFacts) ? slice.userFacts : emptyRows(),
    relevantFacts: Array.isArray(slice?.relevantFacts) ? slice.relevantFacts : emptyRows(),
    relevantMessages: Array.isArray(slice?.relevantMessages) ? slice.relevantMessages : emptyRows()
  };
}

export async function loadPromptMemorySliceFromMemory({
  settings,
  memory,
  userId = null,
  guildId,
  channelId = null,
  queryText = "",
  trace = {},
  source = "prompt_memory_slice",
  onError = null
}) {
  const empty = emptyPromptMemorySlice();
  if (!settings?.memory?.enabled || typeof memory?.buildPromptMemorySlice !== "function") {
    return empty;
  }

  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) return empty;
  const normalizedUserId = String(userId || "").trim() || null;
  const normalizedChannelId = String(channelId || "").trim() || null;
  const normalizedQuery = String(queryText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 420);
  const normalizedSource = String(source || "prompt_memory_slice").trim() || "prompt_memory_slice";

  try {
    const slice = await memory.buildPromptMemorySlice({
      userId: normalizedUserId,
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      queryText: normalizedQuery,
      settings,
      trace: {
        ...trace,
        source: normalizedSource
      }
    });

    return normalizePromptMemorySlice(slice);
  } catch (error) {
    if (typeof onError === "function") {
      onError({
        error,
        context: {
          guildId: normalizedGuildId,
          channelId: normalizedChannelId,
          userId: normalizedUserId,
          source: normalizedSource
        }
      });
    }
    return empty;
  }
}
