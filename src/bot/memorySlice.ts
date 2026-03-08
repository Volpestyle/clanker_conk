import { collectMemoryFactHints } from "./botHelpers.ts";
import { clamp } from "../utils.ts";
import type { BotContext } from "./botContext.ts";

export type MemoryTrace = Record<string, unknown> & {
  source?: string;
};

type MemorySettings = {
  memory?: {
    enabled?: boolean;
  };
} & Record<string, unknown>;

export type FactProfileSlice = {
  userFacts: Array<Record<string, unknown>>;
  relevantFacts: Array<Record<string, unknown>>;
  relevantMessages: Array<Record<string, unknown>>;
};

type LoadFactProfileOptions = {
  settings: MemorySettings;
  userId?: string | null;
  guildId?: string | null;
  channelId?: string | null;
  queryText?: string;
  trace?: MemoryTrace;
  source?: string;
};

export function emptyFactProfileSlice(): FactProfileSlice {
  return {
    userFacts: [],
    relevantFacts: [],
    relevantMessages: []
  };
}

export function normalizeFactProfileSlice(slice: unknown): FactProfileSlice {
  const value = slice && typeof slice === "object" && !Array.isArray(slice)
    ? slice as Record<string, unknown>
    : {};
  return {
    userFacts: Array.isArray(value.userFacts) ? value.userFacts as Array<Record<string, unknown>> : [],
    relevantFacts: Array.isArray(value.relevantFacts) ? value.relevantFacts as Array<Record<string, unknown>> : [],
    relevantMessages: Array.isArray(value.relevantMessages) ? value.relevantMessages as Array<Record<string, unknown>> : []
  };
}

type BuildMediaMemoryFactsOptions = {
  userFacts?: Array<Record<string, unknown> | string>;
  relevantFacts?: Array<Record<string, unknown> | string>;
  maxItems?: number;
};

type ScopedFallbackFactsOptions = {
  guildId?: string | null;
  channelId?: string | null;
  limit?: number;
};

type LoadRelevantMemoryFactsOptions = {
  settings: MemorySettings;
  guildId: string;
  channelId?: string | null;
  queryText?: string;
  trace?: MemoryTrace;
  limit?: number;
  fallbackWhenNoMatch?: boolean;
};

export function loadFactProfile(
  ctx: BotContext,
  {
    settings,
    userId = null,
    guildId,
    channelId = null,
    queryText = "",
    trace: _trace = {},
    source = "fact_profile"
  }: LoadFactProfileOptions
) {
  const empty = emptyFactProfileSlice();
  if (!settings?.memory?.enabled || typeof ctx.memory?.loadFactProfile !== "function") {
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
  const normalizedSource = String(source || "fact_profile").trim() || "fact_profile";

  try {
    const factProfile = normalizeFactProfileSlice(ctx.memory.loadFactProfile({
      userId: normalizedUserId,
      guildId: normalizedGuildId
    }));
    const relevantMessages = normalizedChannelId && normalizedQuery && typeof ctx.store?.searchRelevantMessages === "function"
      ? ctx.store.searchRelevantMessages(normalizedChannelId, normalizedQuery, 8)
      : [];
    return {
      ...factProfile,
      relevantMessages: Array.isArray(relevantMessages) ? relevantMessages : []
    };
  } catch (error) {
    ctx.store.logAction({
      kind: "bot_error",
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      userId: normalizedUserId,
      content: `${normalizedSource}: ${String(error?.message || error)}`
    });
    return empty;
  }
}

export function buildMediaMemoryFacts({
  userFacts = [],
  relevantFacts = [],
  maxItems = 5
}: BuildMediaMemoryFactsOptions = {}) {
  const merged = [
    ...(Array.isArray(userFacts) ? userFacts : []),
    ...(Array.isArray(relevantFacts) ? relevantFacts : [])
  ];
  const max = clamp(Math.floor(Number(maxItems) || 5), 1, 8);
  return collectMemoryFactHints(merged, max);
}

export function getScopedFallbackFacts(
  ctx: BotContext,
  { guildId, channelId = null, limit = 8 }: ScopedFallbackFactsOptions
) {
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId || typeof ctx.store?.getFactsForScope !== "function") return [];

  const boundedLimit = clamp(Math.floor(Number(limit) || 8), 1, 24);
  const candidateLimit = clamp(boundedLimit * 4, boundedLimit, 120);
  const rows = ctx.store.getFactsForScope({
    guildId: normalizedGuildId,
    limit: candidateLimit
  });
  if (!rows.length) return [];

  const normalizedChannelId = String(channelId || "").trim();
  if (!normalizedChannelId) return rows.slice(0, boundedLimit);

  const sameChannel = [];
  const noChannel = [];
  const otherChannel = [];
  for (const row of rows) {
    const rowChannelId = String(row?.channel_id || "").trim();
    if (rowChannelId && rowChannelId === normalizedChannelId) {
      sameChannel.push(row);
      continue;
    }
    if (!rowChannelId) {
      noChannel.push(row);
      continue;
    }
    otherChannel.push(row);
  }

  return [...sameChannel, ...noChannel, ...otherChannel].slice(0, boundedLimit);
}

export async function loadRelevantMemoryFacts(
  ctx: BotContext,
  {
    settings,
    guildId,
    channelId = null,
    queryText = "",
    trace = {},
    limit = 8,
    fallbackWhenNoMatch = true
  }: LoadRelevantMemoryFactsOptions
) {
  if (!settings?.memory?.enabled || !ctx.memory?.searchDurableFacts) return [];

  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) return [];

  const normalizedChannelId = String(channelId || "").trim() || null;
  const boundedLimit = clamp(Math.floor(Number(limit) || 8), 1, 24);
  const normalizedQuery = String(queryText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
  if (!normalizedQuery) {
    return getScopedFallbackFacts(ctx, {
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      limit: boundedLimit
    });
  }

  try {
    const results = await ctx.memory.searchDurableFacts({
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      queryText: normalizedQuery,
      settings,
      trace: {
        ...trace,
        source: trace?.source || "memory_context"
      },
      limit: boundedLimit
    });
    if (results.length || !fallbackWhenNoMatch) return results;
    return getScopedFallbackFacts(ctx, {
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      limit: boundedLimit
    });
  } catch (error) {
    ctx.store.logAction({
      kind: "bot_error",
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      content: `memory_context: ${String(error?.message || error)}`,
      metadata: {
        queryText: normalizedQuery.slice(0, 120),
        source: trace?.source || "memory_context"
      }
    });
    return getScopedFallbackFacts(ctx, {
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      limit: boundedLimit
    });
  }
}
