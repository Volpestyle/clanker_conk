import {
  MAX_MEMORY_LOOKUP_QUERY_LEN,
  MAX_WEB_QUERY_LEN,
  normalizeDirectiveText,
  parseStructuredReplyOutput
} from "../botHelpers.ts";

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

export async function runModelRequestedWebSearch(runtime, {
  settings,
  webSearch,
  query,
  trace = {}
}) {
  const normalizedQuery = normalizeDirectiveText(query, MAX_WEB_QUERY_LEN);
  const state = {
    ...webSearch,
    requested: true,
    query: normalizedQuery
  };

  if (!normalizedQuery) {
    return {
      ...state,
      error: "Missing web search query."
    };
  }

  if (state.optedOutByUser || !state.enabled || !state.configured) {
    return state;
  }

  if (!state.budget?.canSearch) {
    return {
      ...state,
      blockedByBudget: true
    };
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
    };
  } catch (error) {
    return {
      ...state,
      error: String(error?.message || error)
    };
  }
}

export async function runModelRequestedMemoryLookup(runtime, {
  settings,
  memoryLookup,
  query,
  guildId,
  channelId = null,
  trace = {}
}) {
  const normalizedQuery = normalizeDirectiveText(query, MAX_MEMORY_LOOKUP_QUERY_LEN);
  const state = {
    ...memoryLookup,
    requested: true,
    query: normalizedQuery
  };

  if (!state.enabled || !runtime.memory?.searchDurableFacts) {
    return state;
  }
  if (!normalizedQuery) {
    return {
      ...state,
      error: "Missing memory lookup query."
    };
  }
  if (!guildId) {
    return {
      ...state,
      error: "Memory lookup requires guild scope."
    };
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
    };
  } catch (error) {
    return {
      ...state,
      error: String(error?.message || error)
    };
  }
}

export async function maybeRegenerateWithMemoryLookup(runtime, {
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
      query: directive.memoryLookupQuery,
      guildId,
      channelId,
      trace
    });
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
      query: directive.imageLookupQuery
    });
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
    const generationPayload = {
      settings: followupSettings || settings,
      systemPrompt,
      userPrompt: followupPrompt,
      trace: followupTrace
    };
    if (nextImageInputs.length) {
      generationPayload.imageInputs = nextImageInputs;
    }
    nextGeneration = await runtime.llm.generate(generationPayload);
    nextDirective = parseStructuredReplyOutput(nextGeneration.text, mediaPromptLimit);
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
