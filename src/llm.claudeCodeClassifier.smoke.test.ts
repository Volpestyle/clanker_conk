/**
 * Smoke tests for claude-code voice classifier reliability.
 *
 * Covers the failure modes observed in the 2026-02-27 incident:
 *  - verbose / runaway output instead of strict YES|NO
 *  - empty or invalid stream responses
 *  - JSON-wrapped decisions with extra keys
 *  - code-fenced or quoted outputs
 *  - StructuredOutput tool payloads with no result text
 *  - contract violation fail-closed behavior
 *  - bounded retry on hard generation failures
 *
 */
import { test } from "bun:test";
import assert from "node:assert/strict";
import { parseClaudeCodeStreamOutput } from "./llm.ts";
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
    llm: { provider: "openai", model: "claude-haiku-4-5" },
    voice: {
      replyEagerness: 60,
      replyDecisionLlm: {
        provider: "claude-code",
        model: "haiku"
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
// 2. End-to-end: claude-code classifier through evaluateVoiceReplyDecision
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

test("smoke: claude-code verbose output fails contract without retry", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      // Simulate the incident: verbose output instead of YES/NO
      return {
        text: "Based on my analysis of this conversation, I think the bot should respond because the user seems to be asking a question directly.",
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
    settings: baseSettings(),
    transcript: "can someone help with this one?"
  });

  assert.equal(callCount, 1, "should not retry contract violations");
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "llm_contract_violation");
  assert.equal(decision.directAddressed, false);
});

test("smoke: claude-code empty response is contract violation without retry", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "", provider: "claude-code", model: "haiku" };
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

  assert.equal(callCount, 1, "should not retry contract violations");
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "llm_contract_violation");
});

test("smoke: claude-code hard error returns llm_error after single call", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      throw new Error("claude-code stream failure");
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
          model: "haiku"
        }
      }
    }),
    transcript: "so what about the next sprint?"
  });

  assert.equal(callCount, 1, "must stop after single call");
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "llm_error");
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
          model: "haiku"
        }
      }
    }),
    transcript: "anyone have thoughts on this?"
  });

  assert.equal(decision.allow, false, "unaddressed turns must block on error");
});

// ===========================================================================
// 3. Cross-layer: stream output → contract parsing pipeline
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
