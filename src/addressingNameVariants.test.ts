import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  isLikelyBotNameVariantAddress,
  scoreBotNameVariantAddress
} from "./addressingNameVariants.ts";

test("name-variant addressing detects callout-style wake variants without hardcoded bot names", () => {
  const botName = "clanker conk";
  const positives = [
    "Yo, what's up, Clink?",
    "yo plink",
    "hi clunky",
    "join vc clink",
    "clank join vc",
    "join voice clunk",
    "is that u clank?",
    "is that you clinker?",
    "did i just hear a clanka?",
    "I love the clankers of the world"
  ];
  const negatives = [
    "i pulled a prank on him!",
    "pranked ya",
    "get pranked",
    "get stanked",
    "its stinky in here",
    "join vc prank",
    "join voice cleaner",
    "Hi cleaner."
  ];

  for (const text of positives) {
    assert.equal(isLikelyBotNameVariantAddress(text, botName), true, text);
  }
  for (const text of negatives) {
    assert.equal(isLikelyBotNameVariantAddress(text, botName), false, text);
  }
});

test("name-variant addressing works with other bot names", () => {
  const botName = "astro nova";
  assert.equal(isLikelyBotNameVariantAddress("yo astra", botName), true);
  assert.equal(isLikelyBotNameVariantAddress("is that you astr0?", botName), true);
  assert.equal(isLikelyBotNameVariantAddress("yo everyone", botName), false);
});

test("name-variant scoring boosts command-shaped vc requests without forcing non-command matches", () => {
  const botName = "clanker conk";
  const commandScore = scoreBotNameVariantAddress("join vc clink", botName);
  const nonCommandScore = scoreBotNameVariantAddress("the cable made a clink sound", botName);

  assert.equal(commandScore.matched, true);
  assert.equal(commandScore.matchedToken, "clink");
  assert.equal(commandScore.signals.includes("voice_command_shape"), true);
  assert.equal(nonCommandScore.matched, false);
  assert.equal(commandScore.score > nonCommandScore.score, true);
});
