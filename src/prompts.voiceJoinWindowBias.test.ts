import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildVoiceTurnPrompt } from "./prompts.ts";

test("buildVoiceTurnPrompt includes multi-participant join-window greeting bias guidance", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "hi",
    joinWindowActive: true,
    participantRoster: [{ displayName: "alice" }, { displayName: "bob" }]
  });

  assert.equal(
    prompt.includes(
      "Join-window bias: if this turn is a short greeting/check-in (for example hi/hey/yo/sup/what's up), default to a brief acknowledgement instead of [SKIP] even in multi-participant channels, unless clearly aimed at another human."
    ),
    true
  );
});

test("buildVoiceTurnPrompt omits join-window greeting bias guidance when join-window is inactive", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "hi",
    joinWindowActive: false
  });

  assert.equal(prompt.includes("Join-window bias:"), false);
});
