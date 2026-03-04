import type Anthropic from "@anthropic-ai/sdk";
import { normalizeDirectiveText } from "../botHelpers.ts";

const MAX_WEB_QUERY_LEN = 220;
const MAX_MEMORY_LOOKUP_QUERY_LEN = 220;
const MAX_MEMORY_WRITE_LINE_LEN = 180;
const MAX_IMAGE_LOOKUP_QUERY_LEN = 220;
const MAX_OPEN_ARTICLE_REF_LEN = 260;
const MAX_MEMORY_WRITE_ITEMS = 3;

type ReplyToolScope = "lore" | "self" | "user";

interface ReplyToolDefinition {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
}

interface ReplyToolCallInput {
  [key: string]: unknown;
}

interface ReplyToolResult {
  content: string;
  isError?: boolean;
}

type ReplyToolRuntime = {
  search?: {
    searchAndRead: (opts: {
      settings: Record<string, unknown>;
      query: string;
      trace: Record<string, unknown>;
    }) => Promise<{
      query: string;
      results: Array<Record<string, unknown>>;
      fetchedPages?: number;
      providerUsed?: string | null;
      providerFallbackUsed?: boolean;
    }>;
    readPageSummary?: (url: string, maxChars: number) => Promise<{
      title?: string;
      summary?: string;
      extractionMethod?: string;
    }>;
  };
  memory?: {
    searchDurableFacts: (opts: {
      guildId: string;
      channelId: string | null;
      queryText: string;
      settings: Record<string, unknown>;
      trace: Record<string, unknown>;
      limit?: number;
    }) => Promise<Array<Record<string, unknown>>>;
    rememberDirectiveLine: (opts: {
      line: string;
      sourceMessageId: string;
      userId: string;
      guildId: string;
      channelId: string | null;
      sourceText: string;
      scope: string;
      subjectOverride?: string;
    }) => Promise<boolean>;
  };
  store?: {
    logAction: (opts: Record<string, unknown>) => void;
  };
};

type ReplyToolContext = {
  settings: Record<string, unknown>;
  guildId: string;
  channelId: string | null;
  userId: string;
  sourceMessageId: string;
  sourceText: string;
  botUserId?: string;
  trace?: Record<string, unknown>;
};

// --- Tool definitions ---

const WEB_SEARCH_TOOL: ReplyToolDefinition = {
  name: "web_search",
  description:
    "Search the live web for current information. Returns condensed search results with titles, snippets, and page summaries. Use when the reply needs fresh or factual web info.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Concise search query (max 220 chars)"
      }
    },
    required: ["query"]
  }
};

const MEMORY_SEARCH_TOOL: ReplyToolDefinition = {
  name: "memory_search",
  description:
    "Search durable memory for previously stored facts about users, the bot, or shared lore. Use when the user asks what you remember or when context from past conversations would help.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          'Concise lookup query (max 220 chars). Use "__ALL__" to retrieve everything remembered.'
      }
    },
    required: ["query"]
  }
};

const MEMORY_WRITE_TOOL: ReplyToolDefinition = {
  name: "memory_write",
  description:
    "Store one or more durable facts to long-term memory. Use for lasting personal facts about the user (scope=user), shared lore (scope=lore), or stable self-facts about you (scope=self). Only store genuinely durable facts, not throwaway chatter.",
  input_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The fact to remember (max 180 chars)"
            },
            scope: {
              type: "string",
              enum: ["lore", "self", "user"],
              description:
                "lore = shared context/group knowledge, self = durable fact about you, user = durable fact about the speaker"
            }
          },
          required: ["text", "scope"]
        },
        minItems: 1,
        maxItems: 3
      }
    },
    required: ["items"]
  }
};

const IMAGE_LOOKUP_TOOL: ReplyToolDefinition = {
  name: "image_lookup",
  description:
    "Look up a previously shared image from message history. Use when the user refers to an earlier image/photo.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Concise description of the image to find (max 220 chars)"
      }
    },
    required: ["query"]
  }
};

const OPEN_ARTICLE_TOOL: ReplyToolDefinition = {
  name: "open_article",
  description:
    "Open and read a previously found web article. Use when the user asks to read/open/click a cached article from a prior web search.",
  input_schema: {
    type: "object",
    properties: {
      ref: {
        type: "string",
        description:
          "Article reference — a row:col ref (e.g. r1:2), an index number, or a URL from cached results"
      }
    },
    required: ["ref"]
  }
};

const ALL_REPLY_TOOLS: ReplyToolDefinition[] = [
  WEB_SEARCH_TOOL,
  MEMORY_SEARCH_TOOL,
  MEMORY_WRITE_TOOL,
  IMAGE_LOOKUP_TOOL,
  OPEN_ARTICLE_TOOL
];

// --- Settings-gated tool set builder ---

function isMemoryEnabled(settings: Record<string, unknown>): boolean {
  const memory = settings?.memory as Record<string, unknown> | undefined;
  return Boolean(memory?.enabled);
}

function isWebSearchEnabled(settings: Record<string, unknown>): boolean {
  const webSearch = settings?.webSearch as Record<string, unknown> | undefined;
  return Boolean(webSearch?.enabled);
}

export function buildReplyToolSet(
  settings: Record<string, unknown>,
  capabilities: {
    webSearchAvailable?: boolean;
    memoryAvailable?: boolean;
    imageLookupAvailable?: boolean;
    openArticleAvailable?: boolean;
  } = {}
): ReplyToolDefinition[] {
  const tools: ReplyToolDefinition[] = [];

  if (
    capabilities.webSearchAvailable !== false &&
    isWebSearchEnabled(settings)
  ) {
    tools.push(WEB_SEARCH_TOOL);
  }

  const memoryEnabled = isMemoryEnabled(settings);
  if (capabilities.memoryAvailable !== false && memoryEnabled) {
    tools.push(MEMORY_SEARCH_TOOL);
    tools.push(MEMORY_WRITE_TOOL);
  }

  if (capabilities.imageLookupAvailable) {
    tools.push(IMAGE_LOOKUP_TOOL);
  }

  if (capabilities.openArticleAvailable) {
    tools.push(OPEN_ARTICLE_TOOL);
  }

  return tools;
}

// --- Tool executor ---

export async function executeReplyTool(
  toolName: string,
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  switch (toolName) {
    case "web_search":
      return executeWebSearch(input, runtime, context);
    case "memory_search":
      return executeMemorySearch(input, runtime, context);
    case "memory_write":
      return executeMemoryWrite(input, runtime, context);
    case "image_lookup":
      return executeImageLookup(input, context);
    case "open_article":
      return executeOpenArticle(input, runtime, context);
    default:
      return { content: `Unknown tool: ${toolName}`, isError: true };
  }
}

async function executeWebSearch(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  const query = normalizeDirectiveText(
    String(input?.query || ""),
    MAX_WEB_QUERY_LEN
  );
  if (!query) {
    return { content: "Missing or empty search query.", isError: true };
  }
  if (!runtime.search?.searchAndRead) {
    return { content: "Web search is not available.", isError: true };
  }

  try {
    const result = await runtime.search.searchAndRead({
      settings: context.settings,
      query,
      trace: {
        ...context.trace,
        source: "reply_tool_web_search"
      }
    });

    if (!result.results?.length) {
      return { content: `No results found for: "${query}"` };
    }

    const formatted = result.results
      .map((item, i) => {
        const title = String(item.title || "untitled").trim();
        const url = String(item.url || "").trim();
        const domain = String(item.domain || "").trim();
        const snippet = String(item.snippet || "").trim();
        const pageSummary = String(item.pageSummary || "").trim();
        const domainLabel = domain ? ` (${domain})` : "";
        const snippetLine = snippet ? `\nSnippet: ${snippet}` : "";
        const pageLine = pageSummary ? `\nPage: ${pageSummary}` : "";
        return `[${i + 1}] ${title}${domainLabel}\nURL: ${url}${snippetLine}${pageLine}`;
      })
      .join("\n\n");

    return { content: `Web results for "${query}":\n\n${formatted}` };
  } catch (error) {
    return {
      content: `Web search failed: ${String((error as Error)?.message || error)}`,
      isError: true
    };
  }
}

async function executeMemorySearch(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  const query = normalizeDirectiveText(
    String(input?.query || ""),
    MAX_MEMORY_LOOKUP_QUERY_LEN
  );
  if (!query) {
    return { content: "Missing or empty memory search query.", isError: true };
  }
  if (!runtime.memory?.searchDurableFacts) {
    return { content: "Memory search is not available.", isError: true };
  }

  try {
    const results = await runtime.memory.searchDurableFacts({
      guildId: context.guildId,
      channelId: context.channelId,
      queryText: query,
      settings: context.settings,
      trace: {
        ...context.trace,
        source: "reply_tool_memory_search"
      },
      limit: 10
    });

    if (!results?.length) {
      return { content: `No memory facts found for: "${query}"` };
    }

    const formatted = results
      .map((fact) => {
        const text = String(fact.fact || fact.text || "").trim();
        const scope = String(fact.scope || fact.subject || "").trim();
        const scopeLabel = scope ? `[${scope}] ` : "";
        return `- ${scopeLabel}${text}`;
      })
      .join("\n");

    return {
      content: `Memory facts for "${query}":\n${formatted}`
    };
  } catch (error) {
    return {
      content: `Memory search failed: ${String((error as Error)?.message || error)}`,
      isError: true
    };
  }
}

async function executeMemoryWrite(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  context: ReplyToolContext
): Promise<ReplyToolResult> {
  if (!runtime.memory?.rememberDirectiveLine) {
    return { content: "Memory write is not available.", isError: true };
  }

  const rawItems = Array.isArray(input?.items) ? input.items : [];
  if (!rawItems.length) {
    return { content: "No items provided to write.", isError: true };
  }

  const items = rawItems.slice(0, MAX_MEMORY_WRITE_ITEMS);
  const results: string[] = [];

  for (const item of items) {
    const text = normalizeDirectiveText(
      String((item as Record<string, unknown>)?.text || ""),
      MAX_MEMORY_WRITE_LINE_LEN
    );
    const scope = String(
      (item as Record<string, unknown>)?.scope || "lore"
    ).trim() as ReplyToolScope;
    if (!text) {
      results.push(`Skipped empty item (scope=${scope})`);
      continue;
    }

    const validScopes = new Set(["lore", "self", "user"]);
    const resolvedScope = validScopes.has(scope) ? scope : "lore";

    try {
      const saved = await runtime.memory.rememberDirectiveLine({
        line: text,
        sourceMessageId:
          resolvedScope === "self"
            ? `${context.sourceMessageId}-self`
            : context.sourceMessageId,
        userId:
          resolvedScope === "self"
            ? context.botUserId || context.userId
            : context.userId,
        guildId: context.guildId,
        channelId: context.channelId,
        sourceText: context.sourceText,
        scope: resolvedScope,
        ...(resolvedScope === "user"
          ? { subjectOverride: context.userId }
          : {})
      });
      results.push(
        saved
          ? `Saved [${resolvedScope}]: "${text}"`
          : `Deduplicated [${resolvedScope}]: "${text}" (already known)`
      );
    } catch (error) {
      results.push(
        `Failed [${resolvedScope}]: ${String((error as Error)?.message || error)}`
      );
    }
  }

  return { content: results.join("\n") };
}

async function executeImageLookup(
  input: ReplyToolCallInput,
  _context: ReplyToolContext
): Promise<ReplyToolResult> {
  const query = normalizeDirectiveText(
    String(input?.query || ""),
    MAX_IMAGE_LOOKUP_QUERY_LEN
  );
  if (!query) {
    return { content: "Missing or empty image lookup query.", isError: true };
  }
  // Image lookup is handled by the caller since it needs access to
  // message history image candidates which are passed at the call site.
  // This tool returns a placeholder that the caller intercepts.
  return {
    content: `__IMAGE_LOOKUP_REQUEST__:${query}`
  };
}

async function executeOpenArticle(
  input: ReplyToolCallInput,
  runtime: ReplyToolRuntime,
  _context: ReplyToolContext
): Promise<ReplyToolResult> {
  const ref = normalizeDirectiveText(
    String(input?.ref || ""),
    MAX_OPEN_ARTICLE_REF_LEN
  );
  if (!ref) {
    return { content: "Missing or empty article reference.", isError: true };
  }
  if (!runtime.search?.readPageSummary) {
    return { content: "Article reading is not available.", isError: true };
  }
  // Open article also needs the caller to resolve the ref from cached
  // candidates. Return a placeholder.
  return {
    content: `__OPEN_ARTICLE_REQUEST__:${ref}`
  };
}

export {
  ALL_REPLY_TOOLS,
  WEB_SEARCH_TOOL,
  MEMORY_SEARCH_TOOL,
  MEMORY_WRITE_TOOL,
  IMAGE_LOOKUP_TOOL,
  OPEN_ARTICLE_TOOL
};

export type {
  ReplyToolDefinition,
  ReplyToolCallInput,
  ReplyToolResult,
  ReplyToolRuntime,
  ReplyToolContext
};
