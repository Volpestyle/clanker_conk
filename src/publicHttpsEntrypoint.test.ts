import test from "node:test";
import assert from "node:assert/strict";
import {
  extractCloudflaredPublicUrl,
  resolvePublicHttpsTargetUrl
} from "./publicHttpsEntrypoint.ts";

test("extractCloudflaredPublicUrl returns trycloudflare URL from line", () => {
  const line =
    "INF +--------------------------------------------------------------------------------------------+ https://fancy-cat-bot.trycloudflare.com";
  const extracted = extractCloudflaredPublicUrl(line);
  assert.equal(extracted, "https://fancy-cat-bot.trycloudflare.com");
});

test("extractCloudflaredPublicUrl returns empty string when line has no URL", () => {
  const extracted = extractCloudflaredPublicUrl("cloudflared connected to edge");
  assert.equal(extracted, "");
});

test("resolvePublicHttpsTargetUrl falls back to localhost dashboard", () => {
  assert.equal(resolvePublicHttpsTargetUrl("", 8787), "http://127.0.0.1:8787");
});

test("resolvePublicHttpsTargetUrl normalizes valid input URL", () => {
  assert.equal(
    resolvePublicHttpsTargetUrl("https://localhost:8787/path/?x=1#abc", 9999),
    "https://localhost:8787/path"
  );
});

test("resolvePublicHttpsTargetUrl rejects non-http protocols", () => {
  assert.equal(resolvePublicHttpsTargetUrl("file:///tmp/dashboard", 8787), "http://127.0.0.1:8787");
});
