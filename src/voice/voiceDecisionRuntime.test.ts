import { test } from "bun:test";
import assert from "node:assert/strict";
import { parseVoiceThoughtDecisionContract } from "./voiceDecisionRuntime.ts";

test("parseVoiceThoughtDecisionContract parses strict JSON payloads", () => {
  const parsed = parseVoiceThoughtDecisionContract(
    JSON.stringify({
      allow: true,
      finalThought: "let's switch topics real quick",
      usedMemory: true,
      reason: "natural_memory_callback"
    })
  );

  assert.equal(parsed.confident, true);
  assert.equal(parsed.allow, true);
  assert.equal(parsed.finalThought, "let's switch topics real quick");
  assert.equal(parsed.usedMemory, true);
  assert.equal(parsed.reason, "natural_memory_callback");
});

test("parseVoiceThoughtDecisionContract parses YES/NO token fallback", () => {
  const parsed = parseVoiceThoughtDecisionContract(
    "YES: here's a cleaner line used_memory=true reason=rewrote_for_flow"
  );

  assert.equal(parsed.confident, true);
  assert.equal(parsed.allow, true);
  assert.equal(parsed.finalThought, "here's a cleaner line");
  assert.equal(parsed.usedMemory, true);
  assert.equal(parsed.reason, "rewrote_for_flow");
});

test("parseVoiceThoughtDecisionContract marks invalid output as not confident", () => {
  const parsed = parseVoiceThoughtDecisionContract("maybe");
  assert.equal(parsed.confident, false);
  assert.equal(parsed.allow, false);
  assert.equal(parsed.finalThought, "");
});
