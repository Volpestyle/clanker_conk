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

test("buildReplyPrompt includes history image lookup instructions when enabled", () => {
  const prompt = buildReplyPrompt({
    message: {
      authorName: "alice",
      content: "what was that photo again?"
    },
    imageInputs: [],
    recentMessages: [],
    relevantMessages: [],
    userFacts: [],
    relevantFacts: [],
    emojiHints: [],
    reactionEmojiOptions: [],
    webSearch: null,
    memoryLookup: null,
    imageLookup: {
      enabled: true,
      requested: false,
      used: false,
      query: "",
      error: null,
      candidates: [
        {
          filename: "starter.jpg",
          authorName: "smelly conk",
          createdAt: "2026-02-27T21:05:58.891Z",
          context: "",
          matchReason: "",
        }
      ],
      results: []
    },
    allowImageLookupDirective: true
  });

  assert.match(prompt, /History image lookup is available for this turn\./);
  assert.match(prompt, /Recent image references from message history:/);
  assert.match(prompt, /imageLookupQuery/);
});

test("buildReplyPrompt keeps memory citations opt-in for explicit user requests", () => {
  const prompt = buildReplyPrompt({
    message: {
      authorName: "alice",
      content: "what do you remember?"
    },
    imageInputs: [],
    recentMessages: [],
    relevantMessages: [],
    userFacts: [],
    relevantFacts: [],
    emojiHints: [],
    reactionEmojiOptions: [],
    memoryLookup: {
      enabled: true,
      requested: true,
      used: true,
      query: "what do you remember?",
      error: null,
      results: [
        {
          fact: "alice likes giraffes",
          fact_type: "preference",
          confidence: 0.9,
          evidence_text: "i like giraffes",
          source_message_id: "msg-1",
          created_at: "2026-02-27T00:00:00.000Z"
        }
      ]
    }
  });

  assert.match(prompt, /Reference memory naturally without source tags by default\./);
  assert.match(
    prompt,
    /Only cite memory hits inline as \[M1\], \[M2\], etc\. when the user explicitly asks for memory citations, sources, or proof\./
  );
  assert.equal(/If useful, cite memory hits inline as \[M1\], \[M2\], etc\./.test(prompt), false);
});
