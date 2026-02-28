/**
 * Smoke tests for claude-code voice classifier reliability.
 *
 * Covers the failure modes observed in the 2026-02-27 incident:
 *  - verbose / runaway output instead of strict YES|NO
 *  - empty or invalid stream responses
 *  - JSON-wrapped decisions with extra keys
 *  - code-fenced or quoted outputs
 *  - StructuredOutput tool payloads with no result text
 *  - contract violation retry & bounded fallback
 *
 */
import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildClaudeCodeSystemPrompt,
  parseClaudeCodeStreamOutput,
  parseClaudeCodeJsonOutput
} from "./llm.ts";
import { parseVoiceDecisionContract } from "./voice/voiceSessionManager.ts";
import { VoiceSessionManager } from "./voice/voiceSessionManager.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function createManager({
  participantCount = 2,
  generate = async () => ({ text: "NO" }),
  memory = null
} = {}) {
  const fakeClient = {
    on() {},
    off() {},
    guilds: { cache: new Map() },
    users: { cache: new Map() },
    user: { id: "bot-user", username: "clanker conk" }
  };
  const fakeStore = {
    logAction() {},
    getSettings() {
      return { botName: "clanker conk" };
    }
  };
  const manager = new VoiceSessionManager({
    client: fakeClient,
    store: fakeStore,
    appConfig: {},
    llm: { generate },
    memory
  });
  manager.countHumanVoiceParticipants = () => participantCount;
  return manager;
}

function baseSettings(overrides = {}) {
  return {
    botName: "clanker conk",
    memory: { enabled: false },
    llm: { provider: "openai", model: "gpt-4.1-mini" },
    voice: {
      replyEagerness: 60,
      replyDecisionLlm: {
        provider: "claude-code",
        model: "haiku",
        maxAttempts: 2
      }
    },
    ...overrides
  };
}

// ===========================================================================
// 1. parseVoiceDecisionContract — strict contract enforcement
// ===========================================================================

test("smoke: contract accepts bare YES", () => {
  const result = parseVoiceDecisionContract("YES");
  assert.equal(result.confident, true);
  assert.equal(result.allow, true);
});

test("smoke: contract accepts bare NO", () => {
  const result = parseVoiceDecisionContract("NO");
  assert.equal(result.confident, true);
  assert.equal(result.allow, false);
});

test("smoke: contract accepts lowercase yes/no", () => {
  assert.equal(parseVoiceDecisionContract("yes").allow, true);
  assert.equal(parseVoiceDecisionContract("no").allow, false);
  assert.equal(parseVoiceDecisionContract("yes").confident, true);
  assert.equal(parseVoiceDecisionContract("no").confident, true);
});

test("smoke: contract accepts JSON {decision: YES}", () => {
  const result = parseVoiceDecisionContract('{"decision":"YES"}');
  assert.equal(result.confident, true);
  assert.equal(result.allow, true);
});

test("smoke: contract accepts JSON {decision: NO}", () => {
  const result = parseVoiceDecisionContract('{"decision":"NO"}');
  assert.equal(result.confident, true);
  assert.equal(result.allow, false);
});

test("smoke: contract accepts JSON with extra keys", () => {
  const result = parseVoiceDecisionContract(
    '{"decision":"YES","reasoning":"the user asked a question"}'
  );
  assert.equal(result.confident, true);
  assert.equal(result.allow, true);
});

test("smoke: contract rejects verbose LLM output (incident repro)", () => {
  const verbose =
    "Let me think about this. The user said something interesting. " +
    "Based on the context, I believe the answer would be YES because " +
    "they are directly addressing the bot. However, I need to consider " +
    "several factors including the conversation flow and user intent. " +
    "After careful analysis, my decision is YES.";
  const result = parseVoiceDecisionContract(verbose);
  assert.equal(result.confident, false, "verbose output must NOT be treated as confident");
});

test("smoke: contract rejects empty string", () => {
  const result = parseVoiceDecisionContract("");
  assert.equal(result.confident, false);
  assert.equal(result.allow, false);
});

test("smoke: contract rejects null/undefined", () => {
  assert.equal(parseVoiceDecisionContract(null).confident, false);
  assert.equal(parseVoiceDecisionContract(undefined).confident, false);
});

test("smoke: contract rejects 'maybe later' ambiguity", () => {
  const result = parseVoiceDecisionContract("maybe later");
  assert.equal(result.confident, false);
});

test("smoke: contract rejects multi-sentence with embedded YES", () => {
  const result = parseVoiceDecisionContract(
    "I think the answer is YES. The bot should respond."
  );
  assert.equal(result.confident, false);
});

test("smoke: contract accepts code-fenced JSON", () => {
  const result = parseVoiceDecisionContract('```json\n{"decision":"NO"}\n```');
  assert.equal(result.confident, true);
  assert.equal(result.allow, false);
});

test("smoke: contract accepts single-quoted YES", () => {
  const result = parseVoiceDecisionContract("'YES'");
  assert.equal(result.confident, true);
  assert.equal(result.allow, true);
});

test("smoke: contract accepts double-quoted NO", () => {
  const result = parseVoiceDecisionContract('"NO"');
  assert.equal(result.confident, true);
  assert.equal(result.allow, false);
});

test("smoke: contract rejects claude-code memory preamble (incident repro)", () => {
  const result = parseVoiceDecisionContract(
    "Let me check my memory files first."
  );
  assert.equal(result.confident, false);
});

// ===========================================================================
// 2. parseClaudeCodeStreamOutput — stream parsing resilience
// ===========================================================================

test("smoke: stream parser returns null for empty output", () => {
  assert.equal(parseClaudeCodeStreamOutput(""), null);
  assert.equal(parseClaudeCodeStreamOutput(null), null);
  assert.equal(parseClaudeCodeStreamOutput(undefined), null);
});

test("smoke: stream parser returns null for whitespace-only output", () => {
  assert.equal(parseClaudeCodeStreamOutput("  \n  \n  "), null);
});

test("smoke: stream parser returns null for non-JSON garbage", () => {
  assert.equal(parseClaudeCodeStreamOutput("not json at all"), null);
});

test("smoke: stream parser extracts YES from StructuredOutput tool_use", () => {
  const raw = [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "StructuredOutput", input: { decision: "YES" } }
        ]
      }
    }),
    JSON.stringify({
      type: "result",
      is_error: false,
      result: "",
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      total_cost_usd: 0.001
    })
  ].join("\n");

  const parsed = parseClaudeCodeStreamOutput(raw);
  assert.ok(parsed);
  assert.equal(parsed.text, '{"decision":"YES"}');
  assert.equal(parsed.isError, false);
});

test("smoke: stream parser extracts NO from StructuredOutput tool_use", () => {
  const raw = [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "I will respond with my decision." },
          { type: "tool_use", name: "StructuredOutput", input: { decision: "NO" } }
        ]
      }
    }),
    JSON.stringify({
      type: "result",
      is_error: false,
      result: "",
      usage: { input_tokens: 10, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      total_cost_usd: 0.002
    })
  ].join("\n");

  const parsed = parseClaudeCodeStreamOutput(raw);
  assert.ok(parsed);
  assert.equal(parsed.text, '{"decision":"NO"}');
  assert.equal(parsed.isError, false);
});

test("smoke: stream parser handles result with is_error true", () => {
  const raw = JSON.stringify({
    type: "result",
    is_error: true,
    result: "rate limit exceeded",
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    total_cost_usd: 0
  });

  const parsed = parseClaudeCodeStreamOutput(raw);
  assert.ok(parsed);
  assert.equal(parsed.isError, true);
});

test("smoke: stream parser extracts bare assistant text YES", () => {
  const raw = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "YES" }] }
  });

  const parsed = parseClaudeCodeStreamOutput(raw);
  assert.ok(parsed);
  assert.equal(parsed.text, "YES");
});

test("smoke: stream parser prefers StructuredOutput over verbose assistant text", () => {
  const raw = [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Based on my analysis of the conversation context, I believe the user is asking the bot directly." },
          { type: "tool_use", name: "StructuredOutput", input: { decision: "YES" } }
        ]
      }
    }),
    JSON.stringify({
      type: "result",
      is_error: false,
      result: "",
      usage: { input_tokens: 50, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      total_cost_usd: 0.01
    })
  ].join("\n");

  const parsed = parseClaudeCodeStreamOutput(raw);
  assert.ok(parsed);
  assert.equal(parsed.text, '{"decision":"YES"}');
  // The StructuredOutput payload is what matters, not the verbose text
  const contract = parseVoiceDecisionContract(parsed.text);
  assert.equal(contract.confident, true);
  assert.equal(contract.allow, true);
});

// ===========================================================================
// 3. parseClaudeCodeJsonOutput — JSON fallback parsing
// ===========================================================================

test("smoke: json parser returns null for empty output", () => {
  assert.equal(parseClaudeCodeJsonOutput(""), null);
  assert.equal(parseClaudeCodeJsonOutput(null), null);
});

test("smoke: json parser extracts YES from result event", () => {
  const raw = JSON.stringify({
    type: "result",
    is_error: false,
    result: "YES",
    usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    total_cost_usd: 0.001
  });

  const parsed = parseClaudeCodeJsonOutput(raw);
  assert.ok(parsed);
  assert.equal(parsed.text, "YES");
  assert.equal(parsed.isError, false);
});

test("smoke: json parser extracts structured JSON decision from result", () => {
  const raw = JSON.stringify({
    type: "result",
    is_error: false,
    result: '{"decision":"NO"}',
    usage: { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    total_cost_usd: 0.001
  });

  const parsed = parseClaudeCodeJsonOutput(raw);
  assert.ok(parsed);
  assert.equal(parsed.text, '{"decision":"NO"}');
  const contract = parseVoiceDecisionContract(parsed.text);
  assert.equal(contract.confident, true);
  assert.equal(contract.allow, false);
});

// ===========================================================================
// 4. buildClaudeCodeSystemPrompt — token budget enforcement
// ===========================================================================

test("smoke: system prompt includes token budget for classifier", () => {
  const prompt = buildClaudeCodeSystemPrompt({
    systemPrompt: "Respond with YES or NO only.",
    maxOutputTokens: 2
  });
  assert.match(prompt, /under 2 tokens/);
});

test("smoke: system prompt omits budget when maxOutputTokens is 0", () => {
  const prompt = buildClaudeCodeSystemPrompt({
    systemPrompt: "Free-form assistant.",
    maxOutputTokens: 0
  });
  assert.equal(prompt.includes("tokens"), false);
});

// ===========================================================================
// 5. End-to-end: claude-code classifier through evaluateVoiceReplyDecision
// ===========================================================================

test("smoke: claude-code structured YES accepted through decision pipeline", async () => {
  const seenPayloads = [];
  const manager = createManager({
    generate: async (payload) => {
      seenPayloads.push(payload);
      return { text: '{"decision":"YES"}', provider: "claude-code", model: "haiku" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "g1", textChannelId: "c1", voiceChannelId: "v1",
      botTurnOpen: false
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "what's the weather like?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "llm_yes");
  // Verify JSON schema was sent
  assert.ok(seenPayloads[0]?.jsonSchema);
  const schema = JSON.parse(seenPayloads[0].jsonSchema);
  assert.deepEqual(schema.properties.decision.enum, ["YES", "NO"]);
});

test("smoke: claude-code structured NO accepted through decision pipeline", async () => {
  const manager = createManager({
    generate: async () => {
      return { text: '{"decision":"NO"}', provider: "claude-code", model: "haiku" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "g1", textChannelId: "c1", voiceChannelId: "v1",
      botTurnOpen: false
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "what do you guys think about this?"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "llm_no");
});

test("smoke: claude-code verbose output triggers retry and recovers (incident repro)", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      if (callCount === 1) {
        // Simulate the incident: verbose output instead of YES/NO
        return {
          text: "Based on my analysis of this conversation, I think the bot should respond because the user seems to be asking a question directly.",
          provider: "claude-code",
          model: "haiku"
        };
      }
      // Retry succeeds with strict output
      return { text: '{"decision":"YES"}', provider: "claude-code", model: "haiku" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "g1", textChannelId: "c1", voiceChannelId: "v1",
      botTurnOpen: false
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "clanker can you help with this one?"
  });

  assert.equal(callCount, 2, "should retry after contract violation");
  assert.equal(decision.allow, true);
  assert.equal(decision.directAddressed, true);
});

test("smoke: claude-code empty response triggers retry (incident repro)", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      if (callCount === 1) {
        return { text: "", provider: "claude-code", model: "haiku" };
      }
      return { text: "NO", provider: "claude-code", model: "haiku" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "g1", textChannelId: "c1", voiceChannelId: "v1",
      botTurnOpen: false
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "did you guys see that game last night?"
  });

  assert.equal(callCount, 2, "should retry after empty response");
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "llm_no_retry");
});

test("smoke: claude-code repeated failures bounded by maxAttempts (incident repro)", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      // Every attempt returns verbose garbage
      return {
        text: "I need more context to make this determination. Let me analyze the conversation.",
        provider: "claude-code",
        model: "haiku"
      };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "g1", textChannelId: "c1", voiceChannelId: "v1",
      botTurnOpen: false
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60,
        replyDecisionLlm: {
          provider: "claude-code",
          model: "haiku",
          maxAttempts: 3
        }
      }
    }),
    transcript: "so what about the next sprint?"
  });

  assert.equal(callCount, 3, "must stop after maxAttempts");
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "llm_contract_violation");
});

test("smoke: claude-code error throws still fail-open for direct address", async () => {
  const manager = createManager({
    generate: async () => {
      throw new Error("claude-code returned an empty or invalid stream response");
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "g1", textChannelId: "c1", voiceChannelId: "v1",
      botTurnOpen: false
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "hey clanker what's going on?"
  });

  assert.equal(decision.allow, true, "direct address must fail-open on error");
  assert.equal(decision.directAddressed, true);
});

test("smoke: claude-code error blocks unaddressed turns", async () => {
  const manager = createManager({
    generate: async () => {
      throw new Error("claude-code returned an empty or invalid stream response");
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "g1", textChannelId: "c1", voiceChannelId: "v1",
      botTurnOpen: false
    },
    userId: "speaker-1",
    settings: baseSettings({
      voice: {
        replyEagerness: 60,
        replyDecisionLlm: {
          provider: "claude-code",
          model: "haiku",
          maxAttempts: 1
        }
      }
    }),
    transcript: "anyone have thoughts on this?"
  });

  assert.equal(decision.allow, false, "unaddressed turns must block on error");
});

// ===========================================================================
// 6. Cross-layer: stream output → contract parsing pipeline
// ===========================================================================

test("smoke: full pipeline - StructuredOutput YES → contract YES", () => {
  const streamRaw = [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "StructuredOutput", input: { decision: "YES" } }
        ]
      }
    }),
    JSON.stringify({
      type: "result",
      is_error: false,
      result: "",
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      total_cost_usd: 0.001
    })
  ].join("\n");

  const parsed = parseClaudeCodeStreamOutput(streamRaw);
  assert.ok(parsed);
  const contract = parseVoiceDecisionContract(parsed.text);
  assert.equal(contract.confident, true);
  assert.equal(contract.allow, true);
});

test("smoke: full pipeline - bare assistant NO → contract NO", () => {
  const streamRaw = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "NO" }] }
  });

  const parsed = parseClaudeCodeStreamOutput(streamRaw);
  assert.ok(parsed);
  const contract = parseVoiceDecisionContract(parsed.text);
  assert.equal(contract.confident, true);
  assert.equal(contract.allow, false);
});

test("smoke: full pipeline - verbose assistant text → contract violation", () => {
  const streamRaw = [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "text",
          text: "After analyzing the conversation, I believe the user is speaking to someone else in the voice channel and not to the bot. The context suggests a side conversation."
        }]
      }
    }),
    JSON.stringify({
      type: "result",
      is_error: false,
      result: "After analyzing the conversation, I believe the user is speaking to someone else in the voice channel and not to the bot.",
      usage: { input_tokens: 100, output_tokens: 250, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      total_cost_usd: 0.05
    })
  ].join("\n");

  const parsed = parseClaudeCodeStreamOutput(streamRaw);
  assert.ok(parsed);
  const contract = parseVoiceDecisionContract(parsed.text);
  assert.equal(contract.confident, false, "verbose output must be a contract violation");
});

test("smoke: full pipeline - empty stream → null → triggers fallback in caller", () => {
  const parsed = parseClaudeCodeStreamOutput("");
  assert.equal(parsed, null, "empty stream must return null to trigger fallback");
});
