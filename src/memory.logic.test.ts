import assert from "node:assert/strict";
import test from "node:test";
import { __memoryTestables } from "./memory.ts";

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
