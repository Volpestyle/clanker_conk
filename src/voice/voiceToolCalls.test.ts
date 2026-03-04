import { test } from "bun:test";
import assert from "node:assert/strict";
import { executeLocalVoiceToolCall } from "./voiceToolCalls.ts";

test("executeLocalVoiceToolCall forwards browser abort signals to browser_browse", async () => {
  const controller = new AbortController();
  controller.abort("cancel voice browser task");

  let llmCalled = false;
  let browserCalled = false;
  const manager = {
    llm: {
      async chatWithTools() {
        llmCalled = true;
        return {
          content: [],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
          costUsd: 0
        };
      }
    },
    browserManager: {
      async open() {
        browserCalled = true;
        return "opened";
      },
      async close() {
        return undefined;
      }
    },
    store: {
      logAction() {
        return undefined;
      }
    }
  };

  const result = await executeLocalVoiceToolCall(manager, {
    session: {
      id: "voice-session-1",
      guildId: "guild-1",
      textChannelId: "channel-1",
      lastOpenAiToolCallerUserId: "user-1"
    },
    settings: {
      browser: {
        maxStepsPerTask: 5,
        stepTimeoutMs: 10_000,
        llm: {
          provider: "anthropic",
          model: "claude-sonnet-4-5-20250929"
        }
      }
    },
    toolName: "browser_browse",
    args: {
      query: "check example.com"
    },
    signal: controller.signal
  });

  assert.deepEqual(result, {
    ok: false,
    text: "",
    error: "Browser session cancelled."
  });
  assert.equal(llmCalled, false);
  assert.equal(browserCalled, false);
});
