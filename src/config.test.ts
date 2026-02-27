import test from "node:test";
import assert from "node:assert/strict";

const CONFIG_ENV_KEYS = [
  "DISCORD_TOKEN",
  "DASHBOARD_PORT",
  "DASHBOARD_HOST",
  "DASHBOARD_TOKEN",
  "PUBLIC_API_TOKEN",
  "PUBLIC_HTTPS_ENABLED",
  "PUBLIC_HTTPS_PROVIDER",
  "PUBLIC_HTTPS_TARGET_URL",
  "PUBLIC_HTTPS_CLOUDFLARED_BIN",
  "PUBLIC_SHARE_SESSION_TTL_MINUTES",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "ANTHROPIC_API_KEY",
  "XAI_API_KEY",
  "XAI_BASE_URL",
  "BRAVE_SEARCH_API_KEY",
  "SERPAPI_API_KEY",
  "GIPHY_API_KEY",
  "GIPHY_RATING",
  "DEFAULT_PROVIDER",
  "DEFAULT_MODEL_OPENAI",
  "DEFAULT_MODEL_ANTHROPIC",
  "DEFAULT_MODEL_XAI",
  "DEFAULT_MODEL_CLAUDE_CODE",
  "DEFAULT_MEMORY_EMBEDDING_MODEL"
];

async function withConfigEnv(overrides, run) {
  const saved = new Map();
  for (const key of CONFIG_ENV_KEYS) {
    saved.set(key, process.env[key]);
    process.env[key] = "";
  }

  for (const [key, value] of Object.entries(overrides || {})) {
    process.env[key] = String(value);
  }

  try {
    await run();
  } finally {
    for (const key of CONFIG_ENV_KEYS) {
      const prior = saved.get(key);
      if (prior === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prior;
      }
    }
  }
}

async function importFreshConfig(seed) {
  const stamp = `${seed}-${Date.now()}-${Math.random()}`;
  return import(`./config.ts?${stamp}`);
}

test("config parses explicit env values", async () => {
  await withConfigEnv(
    {
      DISCORD_TOKEN: "token-1",
      DASHBOARD_PORT: "9191",
      DASHBOARD_HOST: "0.0.0.0",
      PUBLIC_HTTPS_ENABLED: "YES",
      PUBLIC_HTTPS_PROVIDER: "cloudflared",
      PUBLIC_SHARE_SESSION_TTL_MINUTES: "25",
      DEFAULT_PROVIDER: "claude-code",
      DEFAULT_MODEL_OPENAI: "gpt-4.1",
      DEFAULT_MODEL_ANTHROPIC: "claude-sonnet-4-5",
      DEFAULT_MODEL_XAI: "grok-4-latest",
      DEFAULT_MODEL_CLAUDE_CODE: "opus",
      GIPHY_RATING: "PG",
      XAI_BASE_URL: "https://x.ai/custom"
    },
    async () => {
      const { appConfig, ensureRuntimeEnv } = await importFreshConfig("explicit");
      assert.equal(appConfig.discordToken, "token-1");
      assert.equal(appConfig.dashboardPort, 9191);
      assert.equal(appConfig.dashboardHost, "0.0.0.0");
      assert.equal(appConfig.publicHttpsEnabled, true);
      assert.equal(appConfig.publicHttpsProvider, "cloudflared");
      assert.equal(appConfig.publicShareSessionTtlMinutes, 25);
      assert.equal(appConfig.defaultProvider, "claude-code");
      assert.equal(appConfig.defaultOpenAiModel, "gpt-4.1");
      assert.equal(appConfig.defaultAnthropicModel, "claude-sonnet-4-5");
      assert.equal(appConfig.defaultXaiModel, "grok-4-latest");
      assert.equal(appConfig.defaultClaudeCodeModel, "opus");
      assert.equal(appConfig.giphyRating, "PG");
      assert.equal(appConfig.xaiBaseUrl, "https://x.ai/custom");
      assert.doesNotThrow(() => ensureRuntimeEnv());
    }
  );
});

test("config falls back for invalid values", async () => {
  await withConfigEnv(
    {
      DISCORD_TOKEN: "",
      DASHBOARD_PORT: "not-a-number",
      DASHBOARD_HOST: "   ",
      PUBLIC_HTTPS_ENABLED: "maybe",
      PUBLIC_SHARE_SESSION_TTL_MINUTES: "bad",
      DEFAULT_PROVIDER: "not-supported"
    },
    async () => {
      const { appConfig, ensureRuntimeEnv } = await importFreshConfig("fallbacks");
      assert.equal(appConfig.dashboardPort, 8787);
      assert.equal(appConfig.dashboardHost, "127.0.0.1");
      assert.equal(appConfig.publicHttpsEnabled, false);
      assert.equal(appConfig.publicShareSessionTtlMinutes, 12);
      assert.equal(appConfig.defaultProvider, "openai");
      assert.throws(() => ensureRuntimeEnv(), /Missing DISCORD_TOKEN/);
    }
  );
});

test("config accepts other provider normalizations", async () => {
  await withConfigEnv(
    {
      DISCORD_TOKEN: "token-2",
      DEFAULT_PROVIDER: "anthropic"
    },
    async () => {
      const { appConfig } = await importFreshConfig("provider-anthropic");
      assert.equal(appConfig.defaultProvider, "anthropic");
    }
  );

  await withConfigEnv(
    {
      DISCORD_TOKEN: "token-3",
      DEFAULT_PROVIDER: "xai"
    },
    async () => {
      const { appConfig } = await importFreshConfig("provider-xai");
      assert.equal(appConfig.defaultProvider, "xai");
    }
  );
});
