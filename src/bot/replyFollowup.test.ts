import { test } from "bun:test";
import assert from "node:assert/strict";
import { parseStructuredReplyOutput } from "../botHelpers.ts";
import { maybeRegenerateWithMemoryLookup } from "./replyFollowup.ts";

function toStructuredReplyJson(overrides = {}) {
  return JSON.stringify({
    text: "reply",
    skip: false,
    reactionEmoji: null,
    media: null,
    webSearchQuery: null,
    memoryLookupQuery: null,
    imageLookupQuery: null,
    memoryLine: null,
    selfMemoryLine: null,
    automationAction: {
      operation: "none",
      title: null,
      instruction: null,
      schedule: null,
      targetQuery: null,
      automationId: null,
      runImmediately: false,
      targetChannelId: null
    },
    voiceIntent: {
      intent: "none",
      confidence: 0,
      reason: null
    },
    screenShareIntent: {
      action: "none",
      confidence: 0,
      reason: null
    },
    ...overrides
  });
}

test("reply followup loop can chain web search then memory lookup within one turn", async () => {
  let llmCallCount = 0;
  let webSearchCallCount = 0;
  let memoryLookupCallCount = 0;

  const runtime = {
    llm: {
      async generate() {
        llmCallCount += 1;
        if (llmCallCount === 1) {
          return {
            text: toStructuredReplyJson({
              text: "checking memory too",
              memoryLookupQuery: "starter preferences"
            })
          };
        }
        return {
          text: toStructuredReplyJson({
            text: "you like fast offensive starters",
            memoryLookupQuery: null
          })
        };
      }
    },
    memory: {
      async searchDurableFacts() {
        memoryLookupCallCount += 1;
        return [
          {
            id: 1,
            fact: "user likes offensive starters"
          }
        ];
      }
    }
  };

  const result = await maybeRegenerateWithMemoryLookup(runtime, {
    settings: {},
    followupSettings: null,
    systemPrompt: "system",
    generation: {
      text: toStructuredReplyJson({
        text: "lemme check",
        webSearchQuery: "pokemon starter tier list"
      })
    },
    directive: parseStructuredReplyOutput(
      toStructuredReplyJson({
        text: "lemme check",
        webSearchQuery: "pokemon starter tier list"
      })
    ),
    webSearch: {
      enabled: true,
      configured: true,
      optedOutByUser: false,
      budget: {
        canSearch: true
      },
      requested: false,
      used: false,
      query: "",
      results: [],
      error: null
    },
    memoryLookup: {
      enabled: true,
      requested: false,
      used: false,
      query: "",
      results: [],
      error: null
    },
    imageLookup: null,
    guildId: "guild-1",
    channelId: "chan-1",
    trace: {
      source: "test"
    },
    mediaPromptLimit: 900,
    imageInputs: [],
    forceRegenerate: false,
    buildUserPrompt: ({ webSearch, memoryLookup }) =>
      `web:${String(webSearch?.query || "")} memory:${String(memoryLookup?.query || "")}`,
    runModelRequestedWebSearch: async ({ webSearch, query }) => {
      webSearchCallCount += 1;
      return {
        ...webSearch,
        requested: true,
        used: true,
        query,
        results: [
          {
            url: "https://example.com/starter-tier-list"
          }
        ],
        error: null
      };
    },
    maxModelImageInputs: 8,
    loopConfig: {
      maxSteps: 3,
      maxTotalToolCalls: 3,
      maxWebSearchCalls: 1,
      maxMemoryLookupCalls: 1,
      maxImageLookupCalls: 0
    }
  });

  assert.equal(webSearchCallCount, 1);
  assert.equal(memoryLookupCallCount, 1);
  assert.equal(llmCallCount, 2);
  assert.equal(result.followupSteps, 2);
  assert.equal(result.usedWebSearch, true);
  assert.equal(result.usedMemoryLookup, true);
  assert.equal(result.directive.memoryLookupQuery, null);
});

test("reply followup loop enforces per-turn lookup caps and suppresses extra requests", async () => {
  let llmCallCount = 0;
  let memoryLookupCallCount = 0;

  const runtime = {
    llm: {
      async generate() {
        llmCallCount += 1;
        if (llmCallCount === 1) {
          return {
            text: toStructuredReplyJson({
              text: "double checking",
              memoryLookupQuery: "starter playstyle"
            })
          };
        }
        return {
          text: toStructuredReplyJson({
            text: "cool, got what i need",
            memoryLookupQuery: null
          })
        };
      }
    },
    memory: {
      async searchDurableFacts() {
        memoryLookupCallCount += 1;
        return [
          {
            id: 1,
            fact: "user likes offensive starters"
          }
        ];
      }
    }
  };

  const result = await maybeRegenerateWithMemoryLookup(runtime, {
    settings: {},
    followupSettings: null,
    systemPrompt: "system",
    generation: {
      text: toStructuredReplyJson({
        text: "first pass",
        memoryLookupQuery: "starter preferences"
      })
    },
    directive: parseStructuredReplyOutput(
      toStructuredReplyJson({
        text: "first pass",
        memoryLookupQuery: "starter preferences"
      })
    ),
    webSearch: null,
    memoryLookup: {
      enabled: true,
      requested: false,
      used: false,
      query: "",
      results: [],
      error: null
    },
    imageLookup: null,
    guildId: "guild-1",
    channelId: "chan-1",
    trace: {
      source: "test"
    },
    mediaPromptLimit: 900,
    imageInputs: [],
    forceRegenerate: false,
    buildUserPrompt: ({ memoryLookup }) => `memory:${String(memoryLookup?.query || "")}`,
    maxModelImageInputs: 8,
    loopConfig: {
      maxSteps: 3,
      maxTotalToolCalls: 1,
      maxWebSearchCalls: 0,
      maxMemoryLookupCalls: 1,
      maxImageLookupCalls: 0
    }
  });

  assert.equal(memoryLookupCallCount, 1);
  assert.equal(llmCallCount, 2);
  assert.equal(result.followupSteps, 2);
  assert.equal(result.memoryLookup.error, "Memory lookup cap reached for this turn.");
  assert.equal(result.directive.memoryLookupQuery, null);
});
