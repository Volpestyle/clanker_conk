import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildOpenAiToolLoopInput,
  buildOpenAiReasoningParam,
  buildOpenAiTemperatureParam
} from "./serviceShared.ts";

test("buildOpenAiTemperatureParam omits temperature for gpt-5 dot-version models", () => {
  assert.deepEqual(buildOpenAiTemperatureParam("gpt-5.4-mini", 0.7), {});
  assert.deepEqual(buildOpenAiTemperatureParam("gpt-5.4", 0.2), {});
  assert.deepEqual(buildOpenAiTemperatureParam("gpt-5-mini", 0.2), {});
});

test("buildOpenAiTemperatureParam keeps temperature for non-gpt-5 families", () => {
  assert.deepEqual(buildOpenAiTemperatureParam("gpt-4o-mini", 0.6), { temperature: 0.6 });
});

test("buildOpenAiReasoningParam applies to gpt-5 dot-version models", () => {
  assert.deepEqual(buildOpenAiReasoningParam("gpt-5.4-mini", "minimal"), {
    reasoning: {
      effort: "low"
    }
  });
  assert.deepEqual(buildOpenAiReasoningParam("gpt-4o-mini", "minimal"), {});
});

test("buildOpenAiReasoningParam accepts none and xhigh efforts", () => {
  assert.deepEqual(buildOpenAiReasoningParam("gpt-5.4-mini", "none"), {
    reasoning: {
      effort: "none"
    }
  });
  assert.deepEqual(buildOpenAiReasoningParam("gpt-5.4-mini", "xhigh"), {
    reasoning: {
      effort: "xhigh"
    }
  });
});

test("buildOpenAiToolLoopInput omits synthetic assistant ids for OpenAI responses compatibility", () => {
  const input = buildOpenAiToolLoopInput([
    { role: "user", content: "play some minecraft music" },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Sure, I'll start that."
        },
        {
          type: "tool_call",
          id: "call_music_play",
          name: "music_play",
          input: { query: "minecraft soundtrack" }
        }
      ]
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "call_music_play",
          content: "Playing C418 - Sweden"
        }
      ]
    }
  ]);

  assert.equal(input[1]?.type, "message");
  assert.equal(Object.prototype.hasOwnProperty.call(input[1] || {}, "id"), false);

  assert.equal(input[2]?.type, "function_call");
  assert.equal(Object.prototype.hasOwnProperty.call(input[2] || {}, "id"), false);
});
