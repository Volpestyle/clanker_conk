import test from "node:test";
import assert from "node:assert/strict";
import { LLMService } from "./llm.ts";

function createService(appConfig = {}) {
  return new LLMService({
    appConfig: {
      openaiApiKey: "",
      xaiApiKey: "",
      xaiBaseUrl: "https://api.x.ai/v1",
      anthropicApiKey: "",
      defaultProvider: "openai",
      defaultOpenAiModel: "gpt-4.1-mini",
      defaultAnthropicModel: "claude-haiku-4-5",
      defaultXaiModel: "grok-3-mini-latest",
      defaultClaudeCodeModel: "sonnet",
      ...appConfig
    },
    store: {
      logAction() {}
    }
  });
}

test("resolveProviderAndModel throws when claude-code is selected but CLI is unavailable", () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  service.claudeCodeAvailable = false;

  assert.throws(
    () => service.resolveProviderAndModel({ provider: "claude-code", model: "opus" }),
    /claude-code.*not available on PATH/i
  );
});

test("resolveProviderAndModel keeps claude-code provider when CLI is available", () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  service.claudeCodeAvailable = true;

  const resolved = service.resolveProviderAndModel({ provider: "claude-code", model: "opus" });
  assert.deepEqual(resolved, { provider: "claude-code", model: "opus" });
});

test("resolveProviderAndModel rejects unsupported claude-code model IDs", () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  service.claudeCodeAvailable = true;

  assert.throws(
    () => service.resolveProviderAndModel({ provider: "claude-code", model: "claude-3-5-haiku-latest" }),
    /invalid claude-code model/i
  );
});

test("resolveDefaultModel uses claude-haiku-4-5 for anthropic fallback", () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key", defaultAnthropicModel: "" });
  const resolved = service.resolveProviderAndModel({ provider: "anthropic", model: "" });
  assert.deepEqual(resolved, { provider: "anthropic", model: "claude-haiku-4-5" });
});
