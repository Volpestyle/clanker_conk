import { clamp } from "../utils.ts";
import {
  isBehavioralDirectiveLikeFactText,
  isUnsafeMemoryFactText,
  isInstructionLikeFactText,
  normalizeFactType,
  normalizeMemoryLineInput
} from "./memoryHelpers.ts";

export type MemoryToolNamespaceScope = {
  ok: boolean;
  reason?: string;
  namespace?: string;
  guildId?: string;
  subject?: string | null;
  directiveScope?: "lore" | "self" | "user";
};

type MemorySearchRow = {
  id?: string | number;
  subject?: string | null;
  fact?: string | null;
  fact_type?: string | null;
  score?: number | null;
  semanticScore?: number | null;
  created_at?: string | null;
};

type SharedMemoryRuntime = {
  memory: {
    searchDurableFacts: (opts: {
      guildId: string;
      channelId: string | null;
      queryText: string;
      subjectIds?: string[] | null;
      factTypes?: string[] | null;
      settings: Record<string, unknown>;
      trace: Record<string, unknown>;
      limit?: number;
    }) => Promise<MemorySearchRow[]>;
    rememberDirectiveLineDetailed: (opts: {
      line: string;
      sourceMessageId: string;
      userId: string;
      guildId: string;
      channelId: string | null;
      sourceText: string;
      scope: "lore" | "self" | "user";
      subjectOverride?: string;
      factType?: string | null;
      validationMode?: "strict" | "minimal";
    }) => Promise<{
      ok: boolean;
      reason?: string;
      factText?: string;
      subject?: string;
      factType?: string;
      isNew?: boolean;
    }>;
  };
};

type ResolveScopeArgs = {
  guildId: string;
  actorUserId: string | null;
  namespace?: unknown;
};

type SearchArgs = {
  runtime: SharedMemoryRuntime;
  settings: Record<string, unknown>;
  guildId: string;
  channelId?: string | null;
  actorUserId?: string | null;
  namespace?: unknown;
  queryText: string;
  trace?: Record<string, unknown>;
  limit?: number;
  tags?: string[];
};

type WriteArgs = {
  runtime: SharedMemoryRuntime;
  settings: Record<string, unknown>;
  guildId: string;
  channelId?: string | null;
  actorUserId?: string | null;
  namespace?: unknown;
  items?: Array<{ text?: unknown; type?: unknown }>;
  trace?: Record<string, unknown>;
  sourceMessageIdPrefix?: string;
  sourceText?: string;
  limit?: number;
  dedupeThreshold?: number;
  sensitivePattern?: RegExp | null;
};

const MEMORY_NAMESPACE_USER_RE = /^user:(.+)$/i;
const MEMORY_NAMESPACE_GUILD_RE = /^guild:(.+)$/i;
const USER_NAMESPACE_ALIASES = new Set(["speaker", "user", "me", "current_user", "current-speaker"]);
const GUILD_NAMESPACE_ALIASES = new Set(["guild", "lore", "shared"]);
const SELF_NAMESPACE_ALIASES = new Set(["self", "bot", "assistant"]);
const LORE_SUBJECT = "__lore__";

function resolveMemorySearchSubjectIds(rawNamespace: unknown, scope: MemoryToolNamespaceScope) {
  const normalizedNamespace = String(rawNamespace || "")
    .trim()
    .toLowerCase();

  if (!scope.subject) return null;
  if (!normalizedNamespace || normalizedNamespace === "guild" || MEMORY_NAMESPACE_GUILD_RE.test(normalizedNamespace)) {
    return null;
  }
  if (normalizedNamespace === "lore" || normalizedNamespace === "shared") {
    return [LORE_SUBJECT];
  }
  return [scope.subject];
}

export function resolveMemoryToolNamespaceScope({
  guildId,
  actorUserId,
  namespace = ""
}: ResolveScopeArgs): MemoryToolNamespaceScope {
  const normalizedGuildId = String(guildId || "").trim();
  const normalizedActorUserId = String(actorUserId || "").trim() || null;
  if (!normalizedGuildId) {
    return {
      ok: false,
      reason: "guild_required"
    };
  }

  const normalizedNamespace = String(namespace || "")
    .trim()
    .toLowerCase();

  if (!normalizedNamespace || GUILD_NAMESPACE_ALIASES.has(normalizedNamespace)) {
    return {
      ok: true,
      namespace: `guild:${normalizedGuildId}`,
      guildId: normalizedGuildId,
      subject: "__lore__",
      directiveScope: "lore"
    };
  }

  if (SELF_NAMESPACE_ALIASES.has(normalizedNamespace)) {
    return {
      ok: true,
      namespace: "self",
      guildId: normalizedGuildId,
      subject: "__self__",
      directiveScope: "self"
    };
  }

  if (USER_NAMESPACE_ALIASES.has(normalizedNamespace)) {
    if (!normalizedActorUserId) {
      return {
        ok: false,
        reason: "actor_user_required"
      };
    }
    return {
      ok: true,
      namespace: `user:${normalizedActorUserId}`,
      guildId: normalizedGuildId,
      subject: normalizedActorUserId,
      directiveScope: "user"
    };
  }

  if (MEMORY_NAMESPACE_GUILD_RE.test(normalizedNamespace)) {
    const namespaceGuildId = normalizedNamespace.match(MEMORY_NAMESPACE_GUILD_RE)?.[1]?.trim() || "";
    if (!namespaceGuildId) {
      return {
        ok: false,
        reason: "invalid_guild_namespace"
      };
    }
    if (namespaceGuildId !== normalizedGuildId) {
      return {
        ok: false,
        reason: "guild_namespace_mismatch"
      };
    }
    return {
      ok: true,
      namespace: `guild:${normalizedGuildId}`,
      guildId: normalizedGuildId,
      subject: "__lore__",
      directiveScope: "lore"
    };
  }

  if (MEMORY_NAMESPACE_USER_RE.test(normalizedNamespace)) {
    const namespaceUserId = normalizedNamespace.match(MEMORY_NAMESPACE_USER_RE)?.[1]?.trim() || "";
    if (!namespaceUserId) {
      return {
        ok: false,
        reason: "invalid_user_namespace"
      };
    }
    if (!normalizedActorUserId || namespaceUserId !== normalizedActorUserId) {
      return {
        ok: false,
        reason: "user_namespace_mismatch"
      };
    }
    return {
      ok: true,
      namespace: `user:${namespaceUserId}`,
      guildId: normalizedGuildId,
      subject: namespaceUserId,
      directiveScope: "user"
    };
  }

  return {
    ok: false,
    reason: "invalid_namespace"
  };
}

function buildMemoryToolQuery(value: unknown, maxLen: number) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function scoreRow(row: MemorySearchRow) {
  return Math.max(
    Number.isFinite(Number(row?.score)) ? Number(row?.score) : 0,
    Number.isFinite(Number(row?.semanticScore)) ? Number(row?.semanticScore) : 0
  );
}

export async function executeSharedMemoryToolSearch({
  runtime,
  settings,
  guildId,
  channelId = null,
  actorUserId = null,
  namespace = "",
  queryText,
  trace = {},
  limit = 6,
  tags = []
}: SearchArgs) {
  const resolvedQuery = buildMemoryToolQuery(queryText, 220);
  if (!resolvedQuery) {
    return {
      ok: false,
      namespace: null,
      matches: [],
      error: "query_required"
    };
  }
  const scope = resolveMemoryToolNamespaceScope({
    guildId,
    actorUserId,
    namespace
  });
  if (!scope.ok || !scope.guildId) {
    return {
      ok: false,
      namespace: null,
      matches: [],
      error: String(scope.reason || "invalid_namespace")
    };
  }

  const normalizedTags = Array.isArray(tags)
    ? tags.map((entry) => buildMemoryToolQuery(entry, 40)).filter(Boolean)
    : [];
  const boundedLimit = clamp(Math.floor(Number(limit) || 6), 1, 20);
  const searchSubjectIds = resolveMemorySearchSubjectIds(namespace, scope);
  const rows = await runtime.memory.searchDurableFacts({
    guildId: scope.guildId,
    channelId,
    queryText: resolvedQuery,
    subjectIds: searchSubjectIds,
    factTypes: normalizedTags.length ? normalizedTags : null,
    settings,
    trace,
    limit: clamp(boundedLimit * 2, 1, 40)
  });

  const matches = (Array.isArray(rows) ? rows : [])
    .filter((row) => {
      if (
        Array.isArray(searchSubjectIds) &&
        searchSubjectIds.length > 0 &&
        !searchSubjectIds.includes(String(row?.subject || "").trim())
      ) {
        return false;
      }
      if (normalizedTags.length > 0 && !normalizedTags.includes(String(row?.fact_type || "").trim())) return false;
      return true;
    })
    .slice(0, boundedLimit)
    .map((row) => ({
      id: String(row?.id || ""),
      text: buildMemoryToolQuery(row?.fact, 420),
      score: Number(scoreRow(row).toFixed(3)),
      metadata: {
        createdAt: String(row?.created_at || ""),
        tags: [buildMemoryToolQuery(row?.fact_type, 40)].filter(Boolean)
      }
    }));

  return {
    ok: true,
    namespace: scope.namespace || null,
    matches
  };
}

export async function executeSharedMemoryToolWrite({
  runtime,
  settings,
  guildId,
  channelId = null,
  actorUserId = null,
  namespace = "",
  items = [],
  trace = {},
  sourceMessageIdPrefix = "memory-tool",
  sourceText = "",
  limit = 5,
  dedupeThreshold = 0.9,
  sensitivePattern = null
}: WriteArgs) {
  const scope = resolveMemoryToolNamespaceScope({
    guildId,
    actorUserId,
    namespace
  });
  if (!scope.ok || !scope.guildId || !scope.directiveScope) {
    return {
      ok: false,
      namespace: null,
      written: [],
      skipped: [],
      error: String(scope.reason || "invalid_namespace")
    };
  }

  const normalizedItems = (Array.isArray(items) ? items : [])
    .map((entry) => ({
      text: normalizeMemoryLineInput(entry?.text),
      factType: entry?.type == null ? null : normalizeFactType(entry?.type)
    }))
    .filter((entry) => Boolean(entry.text))
    .slice(0, clamp(Math.floor(Number(limit) || 5), 1, 8));
  if (!normalizedItems.length) {
    return {
      ok: false,
      namespace: scope.namespace || null,
      written: [],
      skipped: [],
      error: "items_required"
    };
  }

  const written = [];
  const skipped = [];
  const resolvedDedupeThreshold = clamp(Number(dedupeThreshold) || 0.9, 0, 1);

  for (const [index, item] of normalizedItems.entries()) {
    const factType = String(item.factType || "").trim().toLowerCase();
    const allowsBehavioralWrite = factType === "guidance" || factType === "behavioral";
    if (sensitivePattern && sensitivePattern.test(item.text)) {
      skipped.push({
        text: item.text,
        reason: "sensitive_content"
      });
      continue;
    }
    if (isUnsafeMemoryFactText(item.text)) {
      skipped.push({
        text: item.text,
        reason: "unsafe_instruction"
      });
      continue;
    }
    if (allowsBehavioralWrite ? false : isBehavioralDirectiveLikeFactText(item.text) || isInstructionLikeFactText(item.text)) {
      skipped.push({
        text: item.text,
        reason: "instruction_like"
      });
      continue;
    }

    const potentialDuplicates = await runtime.memory.searchDurableFacts({
      guildId: scope.guildId,
      channelId,
      queryText: item.text,
      subjectIds: scope.subject ? [scope.subject] : null,
      factTypes: item.factType ? [item.factType] : null,
      settings,
      trace,
      limit: 8
    });
    const hasDuplicate = (Array.isArray(potentialDuplicates) ? potentialDuplicates : []).some((row) => {
      if (scope.subject && String(row?.subject || "").trim() !== scope.subject) return false;
      return scoreRow(row) >= resolvedDedupeThreshold;
    });
    if (hasDuplicate) {
      skipped.push({
        text: item.text,
        reason: "duplicate"
      });
      continue;
    }

    const sourceMessageId = `${sourceMessageIdPrefix}-${Date.now()}-${index + 1}`;
    const result = await runtime.memory.rememberDirectiveLineDetailed({
      line: item.text,
      sourceMessageId,
      userId: String(actorUserId || ""),
      guildId: scope.guildId,
      channelId,
      sourceText: sourceText || item.text,
      scope: scope.directiveScope,
      factType: item.factType,
      ...(scope.directiveScope === "user" && scope.subject ? { subjectOverride: scope.subject } : {})
    });
    if (!result?.ok) {
      skipped.push({
        text: item.text,
        reason: String(result?.reason || "write_failed")
      });
      continue;
    }
    written.push({
      status: String(result.reason || "added_new"),
      text: String(result.factText || item.text),
      subject: String(result.subject || scope.subject || "").trim() || null
    });
  }

  return {
    ok: true,
    namespace: scope.namespace || null,
    dedupeThreshold: resolvedDedupeThreshold,
    written,
    skipped
  };
}
