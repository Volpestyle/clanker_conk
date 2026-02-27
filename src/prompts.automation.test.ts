import test from "node:test";
import assert from "node:assert/strict";
import { buildAutomationPrompt, buildInitiativePrompt, buildReplyPrompt } from "./prompts.ts";

test("buildAutomationPrompt includes durable memory context", () => {
  const prompt = buildAutomationPrompt({
    instruction: "post an image of me every day",
    channelName: "general",
    recentMessages: [{ author_name: "alice", content: "yo" }],
    userFacts: [{ fact: "user is 7 ft tall", fact_type: "profile", confidence: 0.9 }],
    relevantFacts: [{ fact: "user likes giraffes", fact_type: "preference", confidence: 0.8 }],
    memoryLookup: {
      enabled: true,
      requested: false,
      used: false,
      query: "",
      results: [],
      error: null
    },
    allowMemoryLookupDirective: true
  });

  assert.match(prompt, /Known facts about the automation owner:/);
  assert.match(prompt, /7 ft tall/);
  assert.match(prompt, /Relevant durable memory:/);
  assert.match(prompt, /user likes giraffes/);
  assert.match(prompt, /Durable memory lookup is available/);
});

test("buildAutomationPrompt blocks memory lookup directives when disabled", () => {
  const prompt = buildAutomationPrompt({
    instruction: "post update",
    channelName: "general",
    recentMessages: [],
    allowMemoryLookupDirective: false
  });

  assert.match(prompt, /Set memoryLookupQuery to null\./);
});

test("buildInitiativePrompt includes relevant memory context", () => {
  const prompt = buildInitiativePrompt({
    channelName: "general",
    recentMessages: [{ author_name: "alice", content: "we're talking about giraffes" }],
    relevantFacts: [{ fact: "community likes giraffes", fact_type: "preference", confidence: 0.8 }],
    emojiHints: [],
    allowSimpleImagePosts: false,
    allowComplexImagePosts: false,
    allowVideoPosts: false
  });

  assert.match(prompt, /Relevant durable memory:/);
  assert.match(prompt, /community likes giraffes/);
});

test("buildReplyPrompt treats reply eagerness as a soft contribution threshold", () => {
  const prompt = buildReplyPrompt({
    message: {
      authorName: "alice",
      content: "pokemon starters look mid"
    },
    imageInputs: [],
    recentMessages: [
      { author_name: "alice", content: "pokemon starters look mid" },
      { author_name: "bob", content: "yeah these designs are weird" }
    ],
    relevantMessages: [],
    userFacts: [],
    relevantFacts: [],
    emojiHints: [],
    reactionEmojiOptions: [],
    replyEagerness: 25,
    reactionEagerness: 20,
    addressing: {
      directlyAddressed: false,
      responseRequired: false
    }
  });

  assert.match(prompt, /Reply eagerness hint: 25\/100\./);
  assert.match(prompt, /soft threshold/i);
  assert.match(prompt, /Higher eagerness means lower contribution threshold; lower eagerness means higher threshold\./);
  assert.match(prompt, /useful, interesting, or funny enough/i);
});
