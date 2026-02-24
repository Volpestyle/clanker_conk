const DEFAULT_PRICING = {
  openai: {
    "gpt-4.1": { inputPer1M: 2.0, outputPer1M: 8.0 },
    "gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
    "gpt-4.1-nano": { inputPer1M: 0.1, outputPer1M: 0.4 },
    "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 }
  },
  anthropic: {
    "claude-opus-4-6": {
      inputPer1M: 5.0,
      cacheWritePer1M: 6.25,
      cacheWrite1hPer1M: 10.0,
      cacheReadPer1M: 0.5,
      outputPer1M: 25.0
    },
    "claude-opus-4-5": {
      inputPer1M: 5.0,
      cacheWritePer1M: 6.25,
      cacheWrite1hPer1M: 10.0,
      cacheReadPer1M: 0.5,
      outputPer1M: 25.0
    },
    "claude-opus-4-1": {
      inputPer1M: 15.0,
      cacheWritePer1M: 18.75,
      cacheWrite1hPer1M: 30.0,
      cacheReadPer1M: 1.5,
      outputPer1M: 75.0
    },
    "claude-opus-4": {
      inputPer1M: 15.0,
      cacheWritePer1M: 18.75,
      cacheWrite1hPer1M: 30.0,
      cacheReadPer1M: 1.5,
      outputPer1M: 75.0
    },
    "claude-sonnet-4-6": {
      inputPer1M: 3.0,
      cacheWritePer1M: 3.75,
      cacheWrite1hPer1M: 6.0,
      cacheReadPer1M: 0.3,
      outputPer1M: 15.0
    },
    "claude-sonnet-4-5": {
      inputPer1M: 3.0,
      cacheWritePer1M: 3.75,
      cacheWrite1hPer1M: 6.0,
      cacheReadPer1M: 0.3,
      outputPer1M: 15.0
    },
    "claude-sonnet-4": {
      inputPer1M: 3.0,
      cacheWritePer1M: 3.75,
      cacheWrite1hPer1M: 6.0,
      cacheReadPer1M: 0.3,
      outputPer1M: 15.0
    },
    "claude-3-7-sonnet-latest": {
      inputPer1M: 3.0,
      cacheWritePer1M: 3.75,
      cacheWrite1hPer1M: 6.0,
      cacheReadPer1M: 0.3,
      outputPer1M: 15.0
    },
    "claude-haiku-4-5": {
      inputPer1M: 1.0,
      cacheWritePer1M: 1.25,
      cacheWrite1hPer1M: 2.0,
      cacheReadPer1M: 0.1,
      outputPer1M: 5.0
    },
    "claude-3-5-haiku-latest": { inputPer1M: 0.8, outputPer1M: 4.0 },
    "claude-3-5-sonnet-latest": {
      inputPer1M: 3.0,
      cacheWritePer1M: 3.75,
      cacheWrite1hPer1M: 6.0,
      cacheReadPer1M: 0.3,
      outputPer1M: 15.0
    },
    "claude-opus-3": {
      inputPer1M: 15.0,
      cacheWritePer1M: 18.75,
      cacheWrite1hPer1M: 30.0,
      cacheReadPer1M: 1.5,
      outputPer1M: 75.0
    },
    "claude-haiku-3": {
      inputPer1M: 0.25,
      cacheWritePer1M: 0.3,
      cacheWrite1hPer1M: 0.5,
      cacheReadPer1M: 0.03,
      outputPer1M: 1.25
    }
  }
};

const MODEL_ALIASES = {
  "claude opus 4.6": "claude-opus-4-6",
  "claude opus 4.5": "claude-opus-4-5",
  "claude opus 4.1": "claude-opus-4-1",
  "claude opus 4": "claude-opus-4",
  "claude sonnet 4.6": "claude-sonnet-4-6",
  "claude sonnet 4.5": "claude-sonnet-4-5",
  "claude sonnet 4": "claude-sonnet-4",
  "claude sonnet 3.7": "claude-3-7-sonnet-latest",
  "claude haiku 4.5": "claude-haiku-4-5",
  "claude haiku 3.5": "claude-3-5-haiku-latest",
  "claude opus 3": "claude-opus-3",
  "claude haiku 3": "claude-haiku-3"
};

export function estimateUsdCost({
  provider,
  model,
  inputTokens,
  outputTokens,
  cacheWriteTokens,
  cacheReadTokens,
  customPricing = {}
}) {
  const merged = mergePricing(customPricing);
  const providerPricing = merged[provider] ?? {};
  const pricing = resolvePricing(providerPricing, model);
  if (!pricing) return 0;

  const inputCost = toCost(inputTokens, pricing.inputPer1M);
  const outputCost = toCost(outputTokens, pricing.outputPer1M);
  const cacheWriteRate = Number(pricing.cacheWritePer1M ?? pricing.inputPer1M ?? 0);
  const cacheReadRate = Number(pricing.cacheReadPer1M ?? 0);
  const cacheWriteCost = toCost(cacheWriteTokens, cacheWriteRate);
  const cacheReadCost = toCost(cacheReadTokens, cacheReadRate);
  return Number((inputCost + outputCost + cacheWriteCost + cacheReadCost).toFixed(6));
}

export function getDefaultPricing() {
  return DEFAULT_PRICING;
}

function mergePricing(customPricing) {
  const custom = customPricing && typeof customPricing === "object" ? customPricing : {};
  return {
    openai: {
      ...DEFAULT_PRICING.openai,
      ...(custom.openai && typeof custom.openai === "object" ? custom.openai : {})
    },
    anthropic: {
      ...DEFAULT_PRICING.anthropic,
      ...(custom.anthropic && typeof custom.anthropic === "object" ? custom.anthropic : {})
    }
  };
}

function resolvePricing(providerPricing, model) {
  const exact = providerPricing[model];
  if (exact) return exact;

  const normalized = normalizeModelKey(model);
  if (!normalized) return null;

  const alias = MODEL_ALIASES[normalized];
  if (alias && providerPricing[alias]) return providerPricing[alias];
  return providerPricing[normalized] ?? null;
}

function normalizeModelKey(model) {
  return String(model || "")
    .trim()
    .toLowerCase()
    .replace(/^anthropic:/, "")
    .replace(/\s*\(deprecated\)\s*/g, "")
    .replace(/\s+/g, " ");
}

function toCost(tokens, per1M) {
  return ((Number(tokens) || 0) / 1_000_000) * (Number(per1M) || 0);
}
