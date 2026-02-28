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

test("buildVoiceTurnPrompt exposes screen-share directive only when capability is ready", () => {
  const readyPrompt = buildVoiceTurnPrompt({
    speakerName: "tester",
    transcript: "can you see my screen?",
    allowScreenShareDirective: true,
    screenShare: {
      enabled: true,
      status: "ready"
    }
  });
  assert.equal(/\[\[SCREEN_SHARE_LINK\]\]/i.test(readyPrompt), true);

  const blockedPrompt = buildVoiceTurnPrompt({
    speakerName: "tester",
    transcript: "can you see my screen?",
    allowScreenShareDirective: false,
    screenShare: {
      enabled: false,
      status: "disabled"
    }
  });
  assert.equal(/Do not output \[\[SCREEN_SHARE_LINK\]\]\./i.test(blockedPrompt), true);
});
