import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  getPromptImpossibleActionLine,
  getPromptTextGuidance,
  interpolatePromptTemplate
} from "./promptCore.ts";
import { normalizeSettings } from "../store/settingsNormalization.ts";

test("interpolatePromptTemplate resolves known variables and preserves unknown ones", () => {
  const rendered = interpolatePromptTemplate("hi {{ botName }} + {{guildName}}", {
    botName: "clanker"
  });
  assert.equal(rendered, "hi clanker + {{guildName}}");
});

test("prompt getters interpolate botName placeholders", () => {
  const settings = normalizeSettings({
    identity: {
      botName: "clanker"
    },
    prompting: {
      global: {
        impossibleActionLine: "cannot do that, {{botName}} mode"
      },
      text: {
        guidance: ["reply as {{ BOTNAME }} only"]
      }
    }
  });

  assert.equal(getPromptImpossibleActionLine(settings), "cannot do that, clanker mode");
  assert.deepEqual(getPromptTextGuidance(settings), ["reply as clanker only"]);
});
