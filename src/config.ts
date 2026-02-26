import dotenv from "dotenv";

dotenv.config();

const asNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const appConfig = {
  discordToken: process.env.DISCORD_TOKEN ?? "",
  dashboardPort: asNumber(process.env.DASHBOARD_PORT, 8787),
  dashboardToken: process.env.DASHBOARD_TOKEN ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  xaiApiKey: process.env.XAI_API_KEY ?? "",
  xaiBaseUrl: process.env.XAI_BASE_URL ?? "https://api.x.ai/v1",
  braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY ?? "",
  serpApiKey: process.env.SERPAPI_API_KEY ?? "",
  giphyApiKey: process.env.GIPHY_API_KEY ?? "",
  giphyRating: process.env.GIPHY_RATING ?? "pg-13",
  defaultProvider: normalizeDefaultProvider(process.env.DEFAULT_PROVIDER),
  defaultOpenAiModel: process.env.DEFAULT_MODEL_OPENAI ?? "gpt-4.1-mini",
  defaultAnthropicModel: process.env.DEFAULT_MODEL_ANTHROPIC ?? "claude-3-5-haiku-latest",
  defaultXaiModel: process.env.DEFAULT_MODEL_XAI ?? "grok-3-mini-latest",
  defaultMemoryEmbeddingModel: process.env.DEFAULT_MEMORY_EMBEDDING_MODEL ?? "text-embedding-3-small"
};

export function ensureRuntimeEnv() {
  if (!appConfig.discordToken) {
    throw new Error("Missing DISCORD_TOKEN in environment.");
  }
}

function normalizeDefaultProvider(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "anthropic") return "anthropic";
  if (normalized === "xai") return "xai";
  return "openai";
}
