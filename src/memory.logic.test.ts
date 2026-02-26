import assert from "node:assert/strict";
import test from "node:test";
import { MemoryManager, __memoryTestables } from "./memory.ts";

test("memory grounding requires substantial overlap", () => {
  const source = "I talked about pizza and coding today.";
  const weakLine = "User loves pizza and plays soccer.";
  const strongLine = "I talked about pizza and coding today.";

  assert.equal(__memoryTestables.isTextGroundedInSource(weakLine, source), false);
  assert.equal(__memoryTestables.isTextGroundedInSource(strongLine, source), true);
});

test("hybrid relevance gate blocks weak matches", () => {
  assert.equal(
    __memoryTestables.passesHybridRelevanceGate({
      row: { _lexicalScore: 0, _semanticScore: 0, _score: 0.35 },
      semanticAvailable: true
    }),
    false
  );

  assert.equal(
    __memoryTestables.passesHybridRelevanceGate({
      row: { _lexicalScore: 0.26, _semanticScore: 0.02, _score: 0.27 },
      semanticAvailable: true
    }),
    true
  );

  assert.equal(
    __memoryTestables.passesHybridRelevanceGate({
      row: { _lexicalScore: 0.1, _semanticScore: 0.09, _score: 0.56 },
      semanticAvailable: true
    }),
    true
  );
});

test("channel scope score prefers same channel and gives small credit to unknown channel", () => {
  assert.equal(__memoryTestables.computeChannelScopeScore("chan-1", "chan-1"), 1);
  assert.equal(__memoryTestables.computeChannelScopeScore("chan-2", "chan-1"), 0);
  assert.equal(__memoryTestables.computeChannelScopeScore("", "chan-1"), 0.25);
  assert.equal(__memoryTestables.computeChannelScopeScore("chan-1", ""), 0);
});

test("strict relevance mode returns no results when every candidate is weak", async () => {
  const memory = new MemoryManager({
    store: {},
    llm: {
      isEmbeddingReady() {
        return false;
      }
    },
    memoryFilePath: "memory/MEMORY.md"
  });

  const candidates = [
    {
      id: 1,
      created_at: new Date().toISOString(),
      channel_id: "chan-1",
      confidence: 0.8,
      fact: "User likes long walks.",
      evidence_text: "long walks"
    }
  ];

  const strictResults = await memory.rankHybridCandidates({
    candidates,
    queryText: "database replication",
    settings: {},
    requireRelevanceGate: true
  });
  assert.equal(strictResults.length, 0);

  const fallbackResults = await memory.rankHybridCandidates({
    candidates,
    queryText: "database replication",
    settings: {},
    requireRelevanceGate: false
  });
  assert.equal(fallbackResults.length, 1);
});
