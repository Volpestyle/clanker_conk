import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  composeDiscoveryImagePrompt,
  composeDiscoveryVideoPrompt,
  composeReplyImagePrompt,
  composeReplyVideoPrompt,
  parseStructuredReplyOutput
} from "./botHelpers.ts";

test("parseStructuredReplyOutput reads structured reply JSON", () => {
  const parsed = parseStructuredReplyOutput(
    JSON.stringify({
      text: "here you go",
      skip: false,
      reactionEmoji: "🔥",
      media: { type: "gif", prompt: "cat dance" },
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
  assert.equal(parsed.automationAction.operation, null);
});

test("parseStructuredReplyOutput rejects unstructured plain text", () => {
  const parsed = parseStructuredReplyOutput("just reply text");

  assert.equal(parsed.text, "");
  assert.equal(parsed.mediaDirective, null);
  assert.equal(parsed.automationAction.operation, null);
  assert.equal(parsed.parseState, "unstructured");
});

test("parseStructuredReplyOutput ignores removed structured memory fields", () => {
  const parsed = parseStructuredReplyOutput(
    JSON.stringify({
      text: "bet",
      skip: false,
      memoryLine: "Alice likes tea.",
      memoryScope: "guild",
      memoryFactType: "identity",
      selfMemoryLine: "I prefer short replies.",
      selfMemoryFactType: "persona"
    })
  );

  assert.equal(parsed.text, "bet");
  assert.equal(parsed.mediaDirective, null);
});

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

test("parseStructuredReplyOutput recovers text from truncated fenced JSON", () => {
  const parsed = parseStructuredReplyOutput(`\`\`\`json
{
  "text": "nah corbexx you're actually unhinged and i respect it lmaooo. 'penjamin' mode activated.\\n\\ncan't be grinding your brain 24/7",
  "skip": false,
  "reactionEmoji": "lmao:1063357443737931876",
  "automationAction": {
    "operation": "none",
`);

  assert.equal(
    parsed.text,
    "nah corbexx you're actually unhinged and i respect it lmaooo. 'penjamin' mode activated. can't be grinding your brain 24/7"
  );
  assert.equal(parsed.parseState, "recovered_json");
});

test("parseStructuredReplyOutput recovers skip from truncated fenced JSON", () => {
  const parsed = parseStructuredReplyOutput(`\`\`\`json
{
  "text": "ignored",
  "skip": true,
  "reactionEmoji": null,
`);

  assert.equal(parsed.text, "[SKIP]");
  assert.equal(parsed.parseState, "recovered_json");
});

test("parseStructuredReplyOutput rejects reasoning text containing JSON-like field patterns", () => {
  const reasoning = `I need to consider the "text": "something" field in the response before deciding.`;
  const parsed = parseStructuredReplyOutput(reasoning);
  assert.equal(parsed.text, "");
  assert.equal(parsed.parseState, "unstructured");
});

test("parseStructuredReplyOutput rejects prose with embedded skip pattern", () => {
  const reasoning = `Let me think about whether "skip": true is appropriate here.`;
  const parsed = parseStructuredReplyOutput(reasoning);
  assert.equal(parsed.text, "");
  assert.equal(parsed.parseState, "unstructured");
});

test("parseStructuredReplyOutput honors skip flag", () => {
  const parsed = parseStructuredReplyOutput(
    JSON.stringify({
      text: "ignored",
      skip: true,
      reactionEmoji: null,
      media: null,
      memoryLine: null,
    })
  );

  assert.equal(parsed.text, "[SKIP]");
});


test("parseStructuredReplyOutput accepts screen share offer intent", () => {
  const parsed = parseStructuredReplyOutput(
    JSON.stringify({
      text: "i can peek your setup",
      skip: false,
      reactionEmoji: null,
      media: null,
      memoryLine: null,
      screenWatchIntent: {
        action: "start_watch",
        confidence: 0.88,
        reason: "needs visual context"
      }
    })
  );

  assert.equal(parsed.screenWatchIntent.action, "start_watch");
  assert.equal(parsed.screenWatchIntent.confidence, 0.88);
  assert.equal(parsed.screenWatchIntent.reason, "needs visual context");
});

test("parseStructuredReplyOutput ignores deprecated screen share aliases", () => {
  const parsed = parseStructuredReplyOutput(
    JSON.stringify({
      text: "old payload",
      skip: false,
      screenShare: {
        action: "start_watch",
        confidence: 1,
        reason: "deprecated alias"
      },
      screenShareLinkRequested: true
    })
  );

  assert.equal(parsed.screenWatchIntent.action, null);
  assert.equal(parsed.screenWatchIntent.confidence, 0);
  assert.equal(parsed.screenWatchIntent.reason, null);
});

test("parseStructuredReplyOutput normalizes automation create payload", () => {
  const parsed = parseStructuredReplyOutput(
    JSON.stringify({
      text: "bet i got you",
      skip: false,
      reactionEmoji: null,
      media: null,
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
