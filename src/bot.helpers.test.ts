import test from "node:test";
import assert from "node:assert/strict";
import { composeReplyImagePrompt, parseReplyDirectives, parseStructuredReplyOutput } from "./botHelpers.ts";

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
  assert.equal(parsed.automationAction.operation, null);
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
  assert.equal(parsed.automationAction.operation, null);
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

test("parseStructuredReplyOutput accepts stream watch voice intents", () => {
  const parsed = parseStructuredReplyOutput(
    JSON.stringify({
      text: "bet",
      skip: false,
      reactionEmoji: null,
      media: null,
      webSearchQuery: null,
      memoryLookupQuery: null,
      memoryLine: null,
      voiceIntent: {
        intent: "watch_stream",
        confidence: 0.95,
        reason: "explicit stream watch request"
      }
    })
  );

  assert.equal(parsed.voiceIntent.intent, "watch_stream");
  assert.equal(parsed.voiceIntent.confidence, 0.95);
  assert.equal(parsed.voiceIntent.reason, "explicit stream watch request");
});

test("parseStructuredReplyOutput accepts screen share offer intent", () => {
  const parsed = parseStructuredReplyOutput(
    JSON.stringify({
      text: "i can peek your setup",
      skip: false,
      reactionEmoji: null,
      media: null,
      webSearchQuery: null,
      memoryLookupQuery: null,
      memoryLine: null,
      voiceIntent: {
        intent: "none",
        confidence: 0,
        reason: null
      },
      screenShareIntent: {
        action: "offer_link",
        confidence: 0.88,
        reason: "needs visual context"
      }
    })
  );

  assert.equal(parsed.screenShareIntent.action, "offer_link");
  assert.equal(parsed.screenShareIntent.confidence, 0.88);
  assert.equal(parsed.screenShareIntent.reason, "needs visual context");
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

test("parseStructuredReplyOutput normalizes automation create payload", () => {
  const parsed = parseStructuredReplyOutput(
    JSON.stringify({
      text: "bet i got you",
      skip: false,
      reactionEmoji: null,
      media: null,
      webSearchQuery: null,
      memoryLookupQuery: null,
      memoryLine: null,
      automationAction: {
        operation: "create",
        title: "giraffe drip",
        instruction: "post a giraffe picture",
        schedule: {
          kind: "daily",
          hour: 13,
          minute: 0
        },
        runImmediately: true
      },
      voiceIntent: {
        intent: "none",
        confidence: 0,
        reason: null
      }
    })
  );

  assert.equal(parsed.automationAction.operation, "create");
  assert.equal(parsed.automationAction.title, "giraffe drip");
  assert.equal(parsed.automationAction.instruction, "post a giraffe picture");
  assert.equal(parsed.automationAction.schedule?.kind, "daily");
  assert.equal(parsed.automationAction.schedule?.hour, 13);
  assert.equal(parsed.automationAction.schedule?.minute, 0);
  assert.equal(parsed.automationAction.runImmediately, true);
});

test("parseStructuredReplyOutput maps automation stop to pause", () => {
  const parsed = parseStructuredReplyOutput(
    JSON.stringify({
      text: "say less",
      automationAction: {
        operation: "stop",
        targetQuery: "giraffe"
      }
    })
  );

  assert.equal(parsed.automationAction.operation, "pause");
  assert.equal(parsed.automationAction.targetQuery, "giraffe");
});

test("composeReplyImagePrompt includes memory hints when provided", () => {
  const prompt = composeReplyImagePrompt(
    "portrait of the user",
    "here you go",
    900,
    ["user is 7 ft tall", "user wears red hoodies"]
  );

  assert.match(prompt, /Relevant memory facts/);
  assert.match(prompt, /7 ft tall/);
  assert.match(prompt, /red hoodies/);
});

test("parseReplyDirectives parses trailing soundboard directive", () => {
  const parsed = parseReplyDirectives("say less [[SOUNDBOARD:1234567890@555666777]]");
  assert.equal(parsed.text, "say less");
  assert.equal(parsed.soundboardRef, "1234567890@555666777");
});
