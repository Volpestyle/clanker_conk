const DEFAULT_PRICING = {
  openai: {
    "gpt-4.1": { inputPer1M: 2.0, outputPer1M: 8.0 },
    "gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
    "gpt-4.1-nano": { inputPer1M: 0.1, outputPer1M: 0.4 },
    "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 }
  },
  anthropic: {
    "claude-3-5-haiku-latest": { inputPer1M: 0.8, outputPer1M: 4.0 },
    "claude-3-5-sonnet-latest": { inputPer1M: 3.0, outputPer1M: 15.0 }
  }
};

export function estimateUsdCost({ provider, model, inputTokens, outputTokens, customPricing = {} }) {
  const merged = {
    ...DEFAULT_PRICING,
    ...(customPricing && typeof customPricing === "object" ? customPricing : {})
  };

  const providerPricing = merged[provider] ?? {};
  const pricing = providerPricing[model];
  if (!pricing) return 0;

  const inputCost = ((Number(inputTokens) || 0) / 1_000_000) * pricing.inputPer1M;
  const outputCost = ((Number(outputTokens) || 0) / 1_000_000) * pricing.outputPer1M;
  return Number((inputCost + outputCost).toFixed(6));
}

export function getDefaultPricing() {
  return DEFAULT_PRICING;
}
