import dotenv from "dotenv";
import { normalizeLlmProvider } from "./llm/llmHelpers.ts";
import { parseBooleanFlag, parseNumberOrFallback } from "./normalization/valueParsers.ts";

dotenv.config();

export const appConfig = {
  discordToken: process.env.DISCORD_TOKEN ?? "",
  dashboardPort: parseNumberOrFallback(process.env.DASHBOARD_PORT, 8787),
  dashboardHost: normalizeDashboardHost(process.env.DASHBOARD_HOST),
  dashboardToken: process.env.DASHBOARD_TOKEN ?? "",
  publicApiToken: process.env.PUBLIC_API_TOKEN ?? "",
  publicHttpsEnabled: parseBooleanFlag(process.env.PUBLIC_HTTPS_ENABLED, false),
  publicHttpsTargetUrl: process.env.PUBLIC_HTTPS_TARGET_URL ?? "",
  publicHttpsCloudflaredBin: process.env.PUBLIC_HTTPS_CLOUDFLARED_BIN ?? "cloudflared",
  publicShareSessionTtlMinutes: parseNumberOrFallback(process.env.PUBLIC_SHARE_SESSION_TTL_MINUTES, 12),
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY ?? "",
  geminiApiKey: process.env.GOOGLE_API_KEY ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  xaiApiKey: process.env.XAI_API_KEY ?? "",
  xaiBaseUrl: process.env.XAI_BASE_URL ?? "https://api.x.ai/v1",
  braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY ?? "",
  serpApiKey: process.env.SERPAPI_API_KEY ?? "",
  giphyApiKey: process.env.GIPHY_API_KEY ?? "",
  giphyRating: process.env.GIPHY_RATING ?? "pg-13",
  youtubeApiKey: process.env.YOUTUBE_API_KEY ?? "",
  soundcloudClientId: process.env.SOUNDCLOUD_CLIENT_ID ?? "",
  defaultProvider: normalizeLlmProvider(process.env.DEFAULT_PROVIDER, "anthropic"),
  defaultOpenAiModel: process.env.DEFAULT_MODEL_OPENAI ?? "claude-haiku-4-5",
  defaultAnthropicModel: process.env.DEFAULT_MODEL_ANTHROPIC ?? "claude-haiku-4-5",
  defaultXaiModel: process.env.DEFAULT_MODEL_XAI ?? "grok-3-mini-latest",
  defaultClaudeCodeModel: process.env.DEFAULT_MODEL_CLAUDE_CODE ?? "sonnet",
  defaultMemoryEmbeddingModel: process.env.DEFAULT_MEMORY_EMBEDDING_MODEL ?? "text-embedding-3-small",
  runtimeStructuredLogsEnabled: parseBooleanFlag(process.env.RUNTIME_STRUCTURED_LOGS_ENABLED, true),
  runtimeStructuredLogsStdout: parseBooleanFlag(process.env.RUNTIME_STRUCTURED_LOGS_STDOUT, true),
  runtimeStructuredLogsFilePath:
    process.env.RUNTIME_STRUCTURED_LOGS_FILE_PATH ?? "data/logs/runtime-actions.ndjson"
};

export function ensureRuntimeEnv() {
  if (!appConfig.discordToken) {
    throw new Error("Missing DISCORD_TOKEN in environment.");
  }
}

export function normalizeDashboardHost(value) {
  const normalized = String(value || "").trim();
  return normalized || "127.0.0.1";
}
