import { test } from "bun:test";
import assert from "node:assert/strict";
import { isLikelyBotNameVariantAddress } from "./addressingNameVariants.ts";

test("name-variant addressing detects callout-style wake variants without hardcoded bot names", () => {
  const botName = "clanker conk";
  const positives = [
    "Yo, what's up, Clink?",
    "yo plink",
    "hi clunky",
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
