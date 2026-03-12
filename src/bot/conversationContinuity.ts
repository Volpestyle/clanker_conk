import { emptyFactProfileSlice, normalizeFactProfileSlice } from "./memorySlice.ts";
import { getMemorySettings } from "../settings/agentStack.ts";
import {
  CONVERSATION_HISTORY_PROMPT_LIMIT,
  CONVERSATION_HISTORY_PROMPT_MAX_AGE_HOURS
} from "./replyPipelineShared.ts";

export type ConversationContinuityPayload = {
  settings: Record<string, unknown>;
  guildId: string;
  channelId?: string | null;
  userId?: string | null;
  queryText?: string;
  recentMessages?: Array<Record<string, unknown>>;
  source?: string;
  trace?: Record<string, unknown>;
};

type ConversationLookupPayload = {
  guildId: string;
  channelId?: string | null;
  queryText: string;
  limit: number;
  maxAgeHours: number;
};

type ContinuityLoaderArgs = {
  settings: Record<string, unknown>;
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  queryText?: string;
  source?: string;
  trace?: Record<string, unknown>;
  recentMessages?: Array<Record<string, unknown>>;
  loadFactProfile?: ((payload: ConversationContinuityPayload) => unknown) | null;
  loadRecentConversationHistory?: ((payload: ConversationLookupPayload) => unknown) | null;
};

function normalizeQueryText(value: unknown, maxChars = 420) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function isMemoryEnabled(settings: Record<string, unknown>) {
  return Boolean(getMemorySettings(settings).enabled);
}

function resolveFactProfile({
  settings,
  guildId,
  channelId,
  userId,
  queryText,
  recentMessages,
  source,
  trace,
  loadFactProfile,
}: {
  settings: Record<string, unknown>;
  guildId: string;
  channelId: string | null;
  userId: string | null;
  queryText: string;
  recentMessages: Array<Record<string, unknown>>;
  source: string;
  trace: Record<string, unknown>;
  loadFactProfile?: ((payload: ConversationContinuityPayload) => unknown) | null;
}) {
  const empty = emptyFactProfileSlice();
  if (!isMemoryEnabled(settings)) return empty;
  if (!guildId || !userId || typeof loadFactProfile !== "function") {
    return empty;
  }

  try {
    return normalizeFactProfileSlice(loadFactProfile({
      settings,
      userId,
      guildId,
      channelId,
      queryText,
      recentMessages,
      trace,
      source
    }));
  } catch (error) {
    console.error("[conversationContinuity] fact profile failed:", error, {
      guildId,
      channelId,
      userId,
      source
    });
    return empty;
  }
}

function filterConversationWindowsAgainstRecentMessages(
  windows: unknown,
  recentMessages: Array<Record<string, unknown>> = []
) {
  const normalizedWindows = Array.isArray(windows) ? windows : [];
  if (!normalizedWindows.length) return [];
  const recentMessageIds = new Set(
    (Array.isArray(recentMessages) ? recentMessages : [])
      .map((row) => String(row?.message_id || "").trim())
      .filter(Boolean)
  );
  if (!recentMessageIds.size) return normalizedWindows;

  return normalizedWindows.filter((window) => {
    const windowRecord =
      window && typeof window === "object" && !Array.isArray(window)
        ? window as { messages?: Array<Record<string, unknown>> }
        : null;
    const windowMessageIds = (Array.isArray(windowRecord?.messages) ? windowRecord.messages : [])
      .map((row) => String(row?.message_id || "").trim())
      .filter(Boolean);
    if (!windowMessageIds.length) return false;
    return windowMessageIds.some((messageId) => !recentMessageIds.has(messageId));
  });
}

export async function loadConversationContinuityContext({
  settings,
  guildId = null,
  channelId = null,
  userId = null,
  queryText = "",
  source = "conversation_continuity",
  trace = {},
  recentMessages = [],
  loadFactProfile = null,
  loadRecentConversationHistory = null
}: ContinuityLoaderArgs) {
  const normalizedGuildId = String(guildId || "").trim();
  const normalizedChannelId = String(channelId || "").trim() || null;
  const normalizedUserId = String(userId || "").trim() || null;
  const normalizedQueryText = normalizeQueryText(queryText);
  const normalizedSource = String(source || "conversation_continuity").trim() || "conversation_continuity";
  const normalizedTrace =
    trace && typeof trace === "object"
      ? trace
      : {};

  const memorySlicePromise = Promise.resolve(resolveFactProfile({
    settings,
    guildId: normalizedGuildId,
    channelId: normalizedChannelId,
    userId: normalizedUserId,
    queryText: normalizedQueryText,
    recentMessages,
    source: normalizedSource,
    trace: normalizedTrace,
    loadFactProfile
  }));

  const recentConversationHistoryPromise =
    normalizedGuildId &&
    normalizedQueryText &&
    typeof loadRecentConversationHistory === "function"
      ? Promise.resolve(loadRecentConversationHistory({
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        queryText: normalizedQueryText,
        limit: CONVERSATION_HISTORY_PROMPT_LIMIT,
        maxAgeHours: CONVERSATION_HISTORY_PROMPT_MAX_AGE_HOURS
      }))
      : Promise.resolve([]);

  const [memorySlice, recentConversationHistoryRaw] = await Promise.all([
    memorySlicePromise,
    recentConversationHistoryPromise
  ]);
  const recentConversationHistory = filterConversationWindowsAgainstRecentMessages(
    recentConversationHistoryRaw,
    recentMessages
  );

  return {
    memorySlice,
    recentConversationHistory
  };
}
