import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildVoiceTurnPrompt } from "./prompts.ts";
import { buildVoiceToneGuardrails } from "./promptCore.ts";

test("buildVoiceToneGuardrails provides concise non-assistant voice constraints", () => {
  const lines = buildVoiceToneGuardrails();
  assert.equal(Array.isArray(lines), true);
  assert.equal(lines.length >= 4, true);
  assert.equal(lines.every((line) => typeof line === "string" && line.trim().length > 0), true);
  assert.equal(lines.some((line) => /one clear idea/i.test(line)), true);
  assert.equal(lines.some((line) => /assistant-like preambles/i.test(line)), true);
});

test("buildVoiceTurnPrompt includes shared voice tone guardrails", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "tester",
    transcript: "yo what do you think",
    isEagerTurn: false
  });
  assert.equal(/Match your normal text-chat persona in voice/i.test(prompt), true);
  assert.equal(/one clear idea, usually one short sentence/i.test(prompt), true);
});
