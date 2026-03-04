import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, formatAdaptiveDirectives } from "./promptFormatters.ts";

test("formatAdaptiveDirectives renders directive refs and kinds", () => {
  const rendered = formatAdaptiveDirectives([
    {
      id: 12,
      directiveKind: "behavior",
      noteText: "Send a GIF to Tiny Conk whenever they say what the heli."
    },
    {
      id: 18,
      directiveKind: "guidance",
      noteText: "Use type shit occasionally in casual replies."
    }
  ]);

  assert.equal(rendered.includes("[S12] [behavior]"), true);
  assert.equal(rendered.includes("[S18] [guidance]"), true);
});

test("buildSystemPrompt includes adaptive directives block when present", () => {
  const prompt = buildSystemPrompt(
    {
      botName: "clanker conk",
      memory: { enabled: true }
    },
    {
      adaptiveDirectives: [
        {
          id: 4,
          directiveKind: "behavior",
          noteText: "Send a GIF to Tiny Conk whenever they say what the heli."
        }
      ]
    }
  );

  assert.equal(prompt.includes("=== ADAPTIVE DIRECTIVES ==="), true);
  assert.equal(prompt.includes("Behavior directives describe recurring trigger/action behavior."), true);
  assert.equal(prompt.includes("[S4] [behavior]"), true);
});
