import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  composeDiscoveryImagePrompt,
  composeDiscoveryVideoPrompt,
  composeReplyImagePrompt,
  composeReplyVideoPrompt,
  embedWebSearchSources,
  normalizeSkipSentinel,
  parseDiscoveryMediaDirective
} from "./botHelpers.ts";

test("compose media prompts fall back to contextual defaults when no prompt is provided", () => {
  const initiativeImage = composeDiscoveryImagePrompt("", "", 900, []);
  const initiativeVideo = composeDiscoveryVideoPrompt("", "", 900, []);
  const replyImage = composeReplyImagePrompt("", "", 900, []);
  const replyVideo = composeReplyVideoPrompt("", "", 900, []);

  assert.match(initiativeImage, /Scene: general chat mood\./);
  assert.match(initiativeVideo, /Scene: general chat mood\./);
  assert.match(replyImage, /Scene: chat reaction\./);
  assert.match(replyImage, /Conversational context \(do not render as text\): chat context\./);
  assert.match(replyVideo, /Scene: chat reaction\./);
  assert.match(replyVideo, /Conversational context \(do not render as text\): chat context\./);
});

test("parseDiscoveryMediaDirective extracts trailing media directives", () => {
  const parsed = parseDiscoveryMediaDirective(
    "check this out [[IMAGE_PROMPT: a chrome giraffe in a rainstorm]]"
  );

  assert.equal(parsed.text, "check this out");
  assert.equal(parsed.imagePrompt, "a chrome giraffe in a rainstorm");
  assert.deepEqual(parsed.mediaDirective, {
    type: "image_simple",
    prompt: "a chrome giraffe in a rainstorm"
  });
});

test("normalizeSkipSentinel preserves bare skip and strips trailing sentinel", () => {
  assert.equal(normalizeSkipSentinel("[SKIP]"), "[SKIP]");
  assert.equal(normalizeSkipSentinel("nah probably not [SKIP]"), "nah probably not");
  assert.equal(normalizeSkipSentinel(""), "");
});

test("embedWebSearchSources appends cited sources inline and in source list", () => {
  const embedded = embedWebSearchSources("here you go [1]", {
    used: true,
    results: [
      {
        url: "https://example.com/story",
        domain: "example.com"
      }
    ]
  });

  assert.match(embedded, /\[1\]\(<https:\/\/example\.com\/story>\)/);
  assert.match(embedded, /Sources:/);
  assert.match(embedded, /\[1\] example\.com - <https:\/\/example\.com\/story>/);
});
