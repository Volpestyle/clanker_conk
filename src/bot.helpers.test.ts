import test from "node:test";
import assert from "node:assert/strict";
import { parseStructuredReplyOutput } from "./botHelpers.ts";

test("parseStructuredReplyOutput reads structured reply JSON", () => {
  const parsed = parseStructuredReplyOutput(
    JSON.stringify({
      text: "here you go",
      skip: false,
      reactionEmoji: "🔥",
      media: { type: "gif", prompt: "cat dance" },
      webSearchQuery: "latest bitcoin price",
      memoryLookupQuery: "favorite games",
      memoryLine: "user likes roguelikes",
      voiceIntent: {
        intent: "join",
        confidence: 0.92,
        reason: "explicit join request"
      }
    })
  );

  assert.equal(parsed.text, "here you go");
  assert.equal(parsed.reactionEmoji, "🔥");
  assert.equal(parsed.gifQuery, "cat dance");
  assert.equal(parsed.mediaDirective?.type, "gif");
  assert.equal(parsed.webSearchQuery, "latest bitcoin price");
  assert.equal(parsed.memoryLookupQuery, "favorite games");
  assert.equal(parsed.memoryLine, "user likes roguelikes");
  assert.equal(parsed.voiceIntent.intent, "join");
  assert.equal(parsed.voiceIntent.confidence, 0.92);
  assert.equal(parsed.voiceIntent.reason, "explicit join request");
});

test("parseStructuredReplyOutput falls back to plain text when output is not JSON", () => {
  const parsed = parseStructuredReplyOutput("just reply text");

  assert.equal(parsed.text, "just reply text");
  assert.equal(parsed.mediaDirective, null);
  assert.equal(parsed.webSearchQuery, null);
  assert.equal(parsed.memoryLookupQuery, null);
  assert.equal(parsed.voiceIntent.intent, null);
  assert.equal(parsed.voiceIntent.confidence, 0);
  assert.equal(parsed.voiceIntent.reason, null);
});

test("parseStructuredReplyOutput honors skip flag", () => {
  const parsed = parseStructuredReplyOutput(
    JSON.stringify({
      text: "ignored",
      skip: true,
      reactionEmoji: null,
      media: null,
      webSearchQuery: null,
      memoryLookupQuery: null,
      memoryLine: null,
      voiceIntent: {
        intent: "none",
        confidence: 0.2,
        reason: "not a voice command"
      }
    })
  );

  assert.equal(parsed.text, "[SKIP]");
  assert.equal(parsed.voiceIntent.intent, null);
});

test("parseStructuredReplyOutput normalizes invalid voice intent payload", () => {
  const parsed = parseStructuredReplyOutput(
    JSON.stringify({
      text: "hello",
      skip: false,
      reactionEmoji: null,
      media: null,
      webSearchQuery: null,
      memoryLookupQuery: null,
      memoryLine: null,
      voiceIntent: {
        intent: "teleport",
        confidence: 3,
        reason: "invalid"
      }
    })
  );

  assert.equal(parsed.voiceIntent.intent, null);
  assert.equal(parsed.voiceIntent.confidence, 0);
  assert.equal(parsed.voiceIntent.reason, null);
});
