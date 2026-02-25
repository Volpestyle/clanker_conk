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
  googleSearchApiKey: process.env.GOOGLE_SEARCH_API_KEY ?? "",
  googleSearchEngineId: process.env.GOOGLE_SEARCH_ENGINE_ID ?? "",
  defaultProvider: process.env.DEFAULT_PROVIDER === "anthropic" ? "anthropic" : "openai",
  defaultOpenAiModel: process.env.DEFAULT_MODEL_OPENAI ?? "gpt-4.1-mini",
  defaultAnthropicModel: process.env.DEFAULT_MODEL_ANTHROPIC ?? "claude-3-5-haiku-latest"
};

export function ensureRuntimeEnv() {
  if (!appConfig.discordToken) {
    throw new Error("Missing DISCORD_TOKEN in environment.");
  }
}
