import { test } from "bun:test";
import assert from "node:assert/strict";
import { normalizeExtractedFacts } from "./llmHelpers.ts";

test("normalizeExtractedFacts preserves valid subject-tagged rows", () => {
  const rows = normalizeExtractedFacts(
    {
      facts: [
        {
          subject: "author",
          fact: "I like sci-fi books",
          type: "preference",
          confidence: 0.91,
          evidence: "i like sci-fi books"
        },
        {
          subject: "bot",
          fact: "People call clanker conk clanky",
          type: "profile",
          confidence: 0.72,
          evidence: "we call you clanky"
        },
        {
          subject: "lore",
          fact: "Pizza Friday is sacred in this server",
          type: "other",
          confidence: 0.66,
          evidence: "pizza friday is sacred"
        }
      ]
    },
    6
  );

  assert.deepEqual(
    rows.map((row) => row.subject),
    ["author", "bot", "lore"]
  );
});

test("normalizeExtractedFacts drops rows with invalid or missing subjects", () => {
  const rows = normalizeExtractedFacts(
    {
      facts: [
        {
          subject: "unknown",
          fact: "invalid row",
          type: "profile",
          confidence: 0.7,
          evidence: "invalid row"
        },
        {
          fact: "missing subject row",
          type: "profile",
          confidence: 0.7,
          evidence: "missing subject row"
        },
        {
          subject: "author",
          fact: "valid row",
          type: "profile",
          confidence: 0.7,
          evidence: "valid row"
        }
      ]
    },
    6
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.subject, "author");
});
