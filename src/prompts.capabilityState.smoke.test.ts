import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildReplyPrompt } from "./prompts.ts";

test("smoke: reply prompt distinguishes supported-but-unavailable ability states", () => {
  const prompt = buildReplyPrompt({
    message: {
      authorName: "alice",
      content: "can you handle this?"
    },
    imageInputs: [],
    recentMessages: [],
    relevantMessages: [],
    userFacts: [],
    relevantFacts: [],
    emojiHints: [],
    reactionEmojiOptions: [],
    allowReplySimpleImages: false,
    allowReplyComplexImages: false,
    remainingReplyImages: 0,
    allowReplyVideos: false,
    remainingReplyVideos: 0,
    allowReplyGifs: false,
    remainingReplyGifs: 0,
    gifRepliesEnabled: true,
    gifsConfigured: false,
    replyEagerness: 50,
    reactionEagerness: 20,
    addressing: {
      directlyAddressed: true,
      responseRequired: true
    },
    webSearch: {
      requested: false,
      configured: true,
      enabled: false,
      used: false,
      blockedByBudget: false,
      optedOutByUser: false,
      error: null,
      query: "",
      results: [],
      fetchedPages: 0,
      providerUsed: null,
      providerFallbackUsed: false,
      budget: {
        canSearch: true
      }
    },
    recentWebLookups: [],
    memoryLookup: {
      enabled: false
    },
    imageLookup: {
      enabled: false,
      candidates: []
    },
    allowWebSearchDirective: true,
    allowMemoryLookupDirective: true,
    allowImageLookupDirective: true,
    allowMemoryDirective: false,
    allowAutomationDirective: false,
    automationTimeZoneLabel: "UTC",
    voiceMode: {
      enabled: false,
      activeSession: false,
      participantRoster: []
    },
    screenShare: {
      supported: true,
      enabled: true,
      available: false,
      status: "starting",
      reason: "public_https_starting",
      publicUrl: "https://demo.trycloudflare.com"
    },
    videoContext: {
      requested: true,
      used: false,
      enabled: false,
      blockedByBudget: false,
      budget: {
        canLookup: true
      },
      error: null,
      videos: []
    },
    channelMode: "non_initiative",
    maxMediaPromptChars: 900,
    mediaPromptCraftGuidance: "be specific"
  });

  assert.equal(
    prompt.includes(
      "Live web lookup capability exists but is currently unavailable (disabled in settings)."
    ),
    true
  );
  assert.equal(
    prompt.includes("Durable memory lookup capability exists but is currently unavailable for this turn."),
    true
  );
  assert.equal(
    prompt.includes("History image lookup capability exists but is currently unavailable for this turn."),
    true
  );
  assert.equal(
    prompt.includes(
      "Video link understanding capability exists but is currently unavailable (disabled in settings)."
    ),
    true
  );
  assert.equal(
    prompt.includes("Reply image/video generation capability exists but is currently unavailable for this turn."),
    true
  );
  assert.equal(
    prompt.includes(
      "Reply GIF lookup capability exists but is currently unavailable (missing GIPHY configuration)."
    ),
    true
  );
  assert.equal(prompt.includes("Voice control capability exists but is currently disabled in settings."), true);
  assert.equal(
    prompt.includes(
      "Screen-share link capability exists but is currently unavailable (reason: public_https_starting)."
    ),
    true
  );
});
