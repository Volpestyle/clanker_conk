import {
  MAX_MEMORY_LOOKUP_QUERY_LEN,
  MAX_WEB_QUERY_LEN,
  normalizeDirectiveText,
  parseStructuredReplyOutput
} from "../botHelpers.ts";

type ReplyFollowupTrace = Record<string, unknown> & {
  event?: string;
  source?: string;
};

type WebSearchState = {
  requested?: boolean;
  query?: string;
  optedOutByUser?: boolean;
  enabled?: boolean;
  configured?: boolean;
  used?: boolean;
  blockedByBudget?: boolean;
  error?: string | null;
  results?: unknown[];
  fetchedPages?: number;
  providerUsed?: string | null;
  providerFallbackUsed?: boolean;
  budget?: {
    canSearch?: boolean;
  };
  [key: string]: unknown;
};

type MemoryLookupState = {
  enabled?: boolean;
  requested?: boolean;
  query?: string;
  used?: boolean;
  results?: unknown[];
  error?: string | null;
  [key: string]: unknown;
};

type ImageLookupState = {
  enabled?: boolean;
  requested?: boolean;
  query?: string;
  used?: boolean;
  candidates?: unknown[];
  results?: unknown[];
  selectedImageInputs?: Array<Record<string, unknown>>;
  error?: string | null;
  [key: string]: unknown;
};

type ReplyDirectiveShape = ReturnType<typeof parseStructuredReplyOutput>;

type ReplyGenerationShape = {
  text: string;
  [key: string]: unknown;
};

type ReplyFollowupPromptPayload = {
  memoryLookup: MemoryLookupState;
  imageLookup: ImageLookupState | null;
  imageInputs: Array<Record<string, unknown>>;
  allowMemoryLookupDirective: boolean;
  allowImageLookupDirective: boolean;
};

export function resolveReplyFollowupGenerationSettings(settings) {
  const followupConfig = settings?.replyFollowupLlm || {};
  if (!followupConfig.enabled) return settings;

  const provider = String(followupConfig.provider || settings?.llm?.provider || "").trim();
  const model = String(followupConfig.model || settings?.llm?.model || "").trim();
  if (!provider || !model) return settings;

  return {
    ...settings,
    llm: {
      ...(settings?.llm || {}),
      provider,
      model
    }
  };
}

export async function runModelRequestedWebSearch<T extends WebSearchState>(runtime, {
  settings,
  webSearch,
  query,
  trace = {}
}: {
  settings: Record<string, unknown>;
  webSearch: T;
  query: string;
  trace?: ReplyFollowupTrace;
}): Promise<T> {
  const normalizedQuery = normalizeDirectiveText(query, MAX_WEB_QUERY_LEN);
  const state = {
    ...webSearch,
    requested: true,
    query: normalizedQuery
  } as T;

  if (!normalizedQuery) {
    return {
      ...state,
      error: "Missing web search query."
    } as T;
  }

  if (state.optedOutByUser || !state.enabled || !state.configured) {
    return state;
  }

  if (!state.budget?.canSearch) {
    return {
      ...state,
      blockedByBudget: true
    } as T;
  }

  try {
    const result = await runtime.search.searchAndRead({
      settings,
      query: normalizedQuery,
      trace
    });

    return {
      ...state,
      used: result.results.length > 0,
      query: result.query,
      results: result.results,
      fetchedPages: result.fetchedPages || 0,
      providerUsed: result.providerUsed || null,
      providerFallbackUsed: Boolean(result.providerFallbackUsed)
    } as T;
  } catch (error) {
    return {
      ...state,
      error: String(error?.message || error)
    } as T;
  }
}

export async function runModelRequestedWebSearchWithTimeout<T extends WebSearchState>({
  runSearch,
  webSearch,
  query,
  timeoutMs = null
}: {
  runSearch: () => Promise<T>;
  webSearch: T;
  query: string;
  timeoutMs?: number | null;
}): Promise<T> {
  const normalizedQuery = normalizeDirectiveText(query, MAX_WEB_QUERY_LEN);
  const baseState = {
    ...webSearch,
    requested: true,
    query: normalizedQuery,
    used: false
  } as T;
  const resolvedTimeoutMs = Math.max(0, Math.floor(Number(timeoutMs) || 0));

  if (!resolvedTimeoutMs) {
    try {
      return await runSearch();
    } catch (error) {
      return {
        ...baseState,
        error: String(error?.message || error || "web lookup failed")
      } as T;
    }
  }

  type WebSearchSuccess<U> = {
    ok: true;
    value: U;
  };
  type WebSearchFailure = {
    ok: false;
    error: Error;
  };
  type WebSearchTimeout = {
    ok: false;
    timeout: true;
  };

  const runPromise = Promise.resolve(runSearch()).then(
    (value): WebSearchSuccess<T> => ({ ok: true, value }),
    (error): WebSearchFailure => ({ ok: false, error: error instanceof Error ? error : new Error(String(error)) })
  );
  const timeoutPromise = new Promise<WebSearchTimeout>((resolve) => {
    setTimeout(() => {
      resolve({ ok: false, timeout: true });
    }, Math.max(50, resolvedTimeoutMs));
  });

  const result = await Promise.race<WebSearchSuccess<T> | WebSearchFailure | WebSearchTimeout>([
    runPromise,
    timeoutPromise
  ]);
  if (result?.ok) return result.value;
  if ("timeout" in result && result.timeout) {
    return {
      ...baseState,
      error: `web lookup timed out after ${Math.max(50, resolvedTimeoutMs)}ms`
    } as T;
  }
  return {
    ...baseState,
    error: "error" in result
      ? String(result.error?.message || result.error || "web lookup failed")
      : "web lookup failed"
  } as T;
}

async function runModelRequestedMemoryLookup<T extends MemoryLookupState>(runtime, {
  settings,
  memoryLookup,
  query,
  guildId,
  channelId = null,
  trace = {}
}: {
  settings: Record<string, unknown>;
  memoryLookup: T;
  query: string;
  guildId: string;
  channelId?: string | null;
  trace?: ReplyFollowupTrace;
}): Promise<T> {
  const normalizedQuery = normalizeDirectiveText(query, MAX_MEMORY_LOOKUP_QUERY_LEN);
  const state = {
    ...memoryLookup,
    requested: true,
    query: normalizedQuery
  } as T;

  if (!state.enabled || !runtime.memory?.searchDurableFacts) {
    return state;
  }
  if (!normalizedQuery) {
    return {
      ...state,
      error: "Missing memory lookup query."
    } as T;
  }
  if (!guildId) {
    return {
      ...state,
      error: "Memory lookup requires guild scope."
    } as T;
  }

  try {
    const results = await runtime.memory.searchDurableFacts({
      guildId: String(guildId),
      channelId: String(channelId || "").trim() || null,
      queryText: normalizedQuery,
      settings,
      trace: {
        ...trace,
        source: "model_memory_lookup"
      },
      limit: 10
    });
    return {
      ...state,
      used: Boolean(results.length),
      results
    } as T;
  } catch (error) {
    return {
      ...state,
      error: String(error?.message || error)
    } as T;
  }
}

export async function maybeRegenerateWithMemoryLookup<
  TGeneration extends ReplyGenerationShape,
  TDirective extends ReplyDirectiveShape,
  TMemoryLookup extends MemoryLookupState,
  TImageLookup extends ImageLookupState | null
>(runtime, {
  settings,
  followupSettings = null,
  systemPrompt,
  generation,
  directive,
  memoryLookup,
  imageLookup = null,
  guildId,
  channelId = null,
  trace = {},
  mediaPromptLimit,
  imageInputs = null,
  forceRegenerate = false,
  buildUserPrompt,
  runModelRequestedImageLookup,
  mergeImageInputs,
  maxModelImageInputs
}: {
  settings: Record<string, unknown>;
  followupSettings?: Record<string, unknown> | null;
  systemPrompt: string;
  generation: TGeneration;
  directive: TDirective;
  memoryLookup: TMemoryLookup;
  imageLookup?: TImageLookup;
  guildId: string;
  channelId?: string | null;
  trace?: ReplyFollowupTrace;
  mediaPromptLimit: number;
  imageInputs?: Array<Record<string, unknown>> | null;
  forceRegenerate?: boolean;
  buildUserPrompt: (payload: ReplyFollowupPromptPayload) => string;
  runModelRequestedImageLookup?: (payload: {
    imageLookup: TImageLookup;
    query: string;
  }) => Promise<TImageLookup>;
  mergeImageInputs?: (payload: {
    baseInputs: Array<Record<string, unknown>>;
    extraInputs: Array<Record<string, unknown>>;
    maxInputs: number;
  }) => Array<Record<string, unknown>>;
  maxModelImageInputs: number;
}) {
  let nextMemoryLookup = memoryLookup;
  let nextImageLookup = imageLookup;
  let nextGeneration = generation;
  let nextDirective = directive;
  let usedMemoryLookup = false;
  let usedImageLookup = false;
  let nextImageInputs = Array.isArray(imageInputs) ? [...imageInputs] : [];
  let shouldRegenerate = Boolean(forceRegenerate);

  if (directive?.memoryLookupQuery) {
    usedMemoryLookup = true;
    shouldRegenerate = true;
    nextMemoryLookup = await runModelRequestedMemoryLookup(runtime, {
      settings,
      memoryLookup: nextMemoryLookup,
      query: String(directive.memoryLookupQuery || ""),
      guildId,
      channelId,
      trace
    }) as TMemoryLookup;
  }

  if (
    directive?.imageLookupQuery &&
    nextImageLookup &&
    typeof runModelRequestedImageLookup === "function"
  ) {
    usedImageLookup = true;
    shouldRegenerate = true;
    nextImageLookup = await runModelRequestedImageLookup({
      imageLookup: nextImageLookup,
      query: String(directive.imageLookupQuery || "")
    }) as TImageLookup;
    if (
      Array.isArray(nextImageLookup?.selectedImageInputs) &&
      nextImageLookup.selectedImageInputs.length &&
      typeof mergeImageInputs === "function"
    ) {
      nextImageInputs = mergeImageInputs({
        baseInputs: nextImageInputs,
        extraInputs: nextImageLookup.selectedImageInputs,
        maxInputs: maxModelImageInputs
      });
    }
  }

  if (shouldRegenerate && typeof buildUserPrompt === "function") {
    const followupPrompt = buildUserPrompt({
      memoryLookup: nextMemoryLookup,
      imageLookup: nextImageLookup,
      imageInputs: nextImageInputs,
      allowMemoryLookupDirective: false,
      allowImageLookupDirective: false
    });
    const followupTrace = {
      ...trace,
      event: String(trace?.event || "llm_followup")
        .trim()
        .concat(":lookup_followup")
    };
    const generationPayload: {
      settings: Record<string, unknown>;
      systemPrompt: string;
      userPrompt: string;
      trace: ReplyFollowupTrace;
      imageInputs?: Array<Record<string, unknown>>;
    } = {
      settings: followupSettings || settings,
      systemPrompt,
      userPrompt: followupPrompt,
      trace: followupTrace
    };
    if (nextImageInputs.length) {
      generationPayload.imageInputs = nextImageInputs;
    }
    nextGeneration = await runtime.llm.generate(generationPayload) as TGeneration;
    nextDirective = parseStructuredReplyOutput(
      String(nextGeneration.text || ""),
      mediaPromptLimit
    ) as TDirective;
  }

  return {
    generation: nextGeneration,
    directive: nextDirective,
    memoryLookup: nextMemoryLookup,
    imageLookup: nextImageLookup,
    imageInputs: nextImageInputs,
    usedMemoryLookup,
    usedImageLookup
  };
}
