import dotenv from "dotenv";

dotenv.config();

const asNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const asBoolean = (value, fallback = false) => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return Boolean(fallback);
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return Boolean(fallback);
};

export const appConfig = {
  discordToken: process.env.DISCORD_TOKEN ?? "",
  dashboardPort: asNumber(process.env.DASHBOARD_PORT, 8787),
  dashboardHost: normalizeDashboardHost(process.env.DASHBOARD_HOST),
  dashboardToken: process.env.DASHBOARD_TOKEN ?? "",
  publicApiToken: process.env.PUBLIC_API_TOKEN ?? "",
  publicHttpsEnabled: asBoolean(process.env.PUBLIC_HTTPS_ENABLED, false),
  publicHttpsProvider: normalizePublicHttpsProvider(process.env.PUBLIC_HTTPS_PROVIDER),
  publicHttpsTargetUrl: process.env.PUBLIC_HTTPS_TARGET_URL ?? "",
  publicHttpsCloudflaredBin: process.env.PUBLIC_HTTPS_CLOUDFLARED_BIN ?? "cloudflared",
  publicShareSessionTtlMinutes: asNumber(process.env.PUBLIC_SHARE_SESSION_TTL_MINUTES, 12),
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  geminiApiKey: process.env.GOOGLE_API_KEY ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  xaiApiKey: process.env.XAI_API_KEY ?? "",
  xaiBaseUrl: process.env.XAI_BASE_URL ?? "https://api.x.ai/v1",
  braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY ?? "",
  serpApiKey: process.env.SERPAPI_API_KEY ?? "",
  giphyApiKey: process.env.GIPHY_API_KEY ?? "",
  giphyRating: process.env.GIPHY_RATING ?? "pg-13",
  defaultProvider: normalizeDefaultProvider(process.env.DEFAULT_PROVIDER),
  defaultOpenAiModel: process.env.DEFAULT_MODEL_OPENAI ?? "gpt-4.1-mini",
  defaultAnthropicModel: process.env.DEFAULT_MODEL_ANTHROPIC ?? "claude-haiku-4-5",
  defaultXaiModel: process.env.DEFAULT_MODEL_XAI ?? "grok-3-mini-latest",
  defaultClaudeCodeModel: process.env.DEFAULT_MODEL_CLAUDE_CODE ?? "sonnet",
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
  if (normalized === "claude-code") return "claude-code";
  return "openai";
}

function normalizePublicHttpsProvider(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "cloudflared") return "cloudflared";
  return "cloudflared";
}

function normalizeDashboardHost(value) {
  const normalized = String(value || "").trim();
  return normalized || "127.0.0.1";
}
