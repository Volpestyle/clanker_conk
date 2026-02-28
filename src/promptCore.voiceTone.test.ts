import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildVoiceTurnPrompt } from "./prompts.ts";
import { buildVoiceSelfContextLines, buildVoiceToneGuardrails } from "./promptCore.ts";

test("buildVoiceToneGuardrails provides concise non-assistant voice constraints", () => {
  const lines = buildVoiceToneGuardrails();
  assert.equal(Array.isArray(lines), true);
  assert.equal(lines.length >= 4, true);
  assert.equal(lines.every((line) => typeof line === "string" && line.trim().length > 0), true);
  assert.equal(lines.some((line) => /one clear idea/i.test(line)), true);
  assert.equal(lines.some((line) => /avoid chat-only shorthand acronyms/i.test(line)), true);
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
  assert.equal(/avoid chat-only shorthand acronyms/i.test(prompt), true);
});

test("buildVoiceSelfContextLines captures in-vc continuity state", () => {
  const active = buildVoiceSelfContextLines({
    voiceEnabled: true,
    inVoiceChannel: true,
    participantRoster: [{ displayName: "alice" }]
  }).join("\n");
  assert.equal(/Voice mode is enabled right now\./i.test(active), true);
  assert.equal(/You are currently in VC right now\./i.test(active), true);
  assert.equal(/Humans currently in channel: alice\./i.test(active), true);
  assert.equal(/do not claim you are outside VC/i.test(active), true);

  const inactive = buildVoiceSelfContextLines({
    voiceEnabled: true,
    inVoiceChannel: false
  }).join("\n");
  assert.equal(/You are currently not in VC\./i.test(inactive), true);
  assert.equal(/outside VC/i.test(inactive), false);
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
