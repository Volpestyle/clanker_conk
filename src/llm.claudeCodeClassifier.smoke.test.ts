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
// 2. End-to-end: brain_decides flow through evaluateVoiceReplyDecision
// ===========================================================================

test("smoke: non-addressed turn in stt_pipeline mode returns brain_decides", async () => {
  let callCount = 0;
  const manager = createManager({
    generate: async () => {
      callCount += 1;
      return { text: "NO" };
    }
  });
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "g1", textChannelId: "c1", voiceChannelId: "v1",
      botTurnOpen: false,
      mode: "stt_pipeline"
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "what's the weather like?"
  });

  assert.equal(callCount, 0, "reply decision classifier should not be called");
  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "brain_decides");
});

test("smoke: non-addressed turn without brain session returns no_brain_session", async () => {
  const manager = createManager();
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
  assert.equal(decision.reason, "no_brain_session");
});

test("smoke: direct address still allowed via fast path regardless of mode", async () => {
  const manager = createManager();
  const decision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "g1", textChannelId: "c1", voiceChannelId: "v1",
      botTurnOpen: false
    },
    userId: "speaker-1",
    settings: baseSettings(),
    transcript: "hey clanker what's going on?"
  });

  assert.equal(decision.allow, true, "direct address must be allowed via fast path");
  assert.equal(decision.directAddressed, true);
  assert.equal(decision.reason, "direct_address_fast_path");
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
