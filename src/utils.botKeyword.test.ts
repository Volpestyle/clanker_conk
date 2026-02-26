import test from "node:test";
import assert from "node:assert/strict";
import { hasBotKeyword, stripBotKeywords } from "./utils.ts";

test("hasBotKeyword matches configured cl* prefixes with wildcard suffixes", () => {
  assert.equal(hasBotKeyword("clank"), true);
  assert.equal(hasBotKeyword("clanker"), true);
  assert.equal(hasBotKeyword("clinkster"), true);
  assert.equal(hasBotKeyword("CLUNK9000"), true);
  assert.equal(hasBotKeyword("clenk_bot"), true);
  assert.equal(hasBotKeyword("clonky"), true);
});

test("hasBotKeyword does not match unrelated words", () => {
  assert.equal(hasBotKeyword("hello world"), false);
  assert.equal(hasBotKeyword("clockwork orange"), false);
  assert.equal(hasBotKeyword("blanket fort"), false);
});

test("stripBotKeywords removes all matched bot-keyword tokens", () => {
  const source = "yo clanker and clinkguy and CLONK-BOT say hi";
  const stripped = stripBotKeywords(source).replace(/\s+/g, " ").trim();
  assert.equal(stripped, "yo and and say hi");
});
