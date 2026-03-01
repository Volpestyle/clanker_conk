import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  collectPromptTemplateVariables,
  collectUnsupportedPromptTemplateVariables,
  interpolatePromptTemplate
} from "./promptTemplate";

test("interpolatePromptTemplate resolves botName placeholders with flexible casing and spacing", () => {
  const rendered = interpolatePromptTemplate("Yo {{ botName }} / {{BOTNAME}}", {
    botName: "conk"
  });
  assert.equal(rendered, "Yo conk / conk");
});

test("interpolatePromptTemplate keeps unknown placeholders unchanged", () => {
  const rendered = interpolatePromptTemplate("{{botName}} + {{guildName}}", {
    botName: "conk"
  });
  assert.equal(rendered, "conk + {{guildName}}");
});

test("collectPromptTemplateVariables dedupes tokens and tracks unsupported ones", () => {
  const template = "{{botName}} hi {{BOTNAME}} and {{channelName}}";
  const variables = collectPromptTemplateVariables(template);
  const unsupported = collectUnsupportedPromptTemplateVariables(template);

  assert.deepEqual(variables, ["botname", "channelname"]);
  assert.deepEqual(unsupported, ["channelname"]);
});
