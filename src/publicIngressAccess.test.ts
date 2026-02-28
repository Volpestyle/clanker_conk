import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  classifyApiAccessPath,
  getPublicTunnelHost,
  isAllowedPublicApiPath,
  isPublicSessionTokenApiPath,
  isPublicTunnelRequestHost,
  normalizeHost
} from "./publicIngressAccess.ts";

test("normalizeHost trims and lowercases host values", () => {
  assert.equal(normalizeHost(" EXAMPLE.TryCloudflare.com. "), "example.trycloudflare.com");
});

test("getPublicTunnelHost reads host from runtime public URL", () => {
  const host = getPublicTunnelHost({
    publicUrl: "https://fancy-cat.trycloudflare.com"
  });
  assert.equal(host, "fancy-cat.trycloudflare.com");
});

test("isPublicTunnelRequestHost matches against current tunnel host", () => {
  const matches = isPublicTunnelRequestHost("fancy-cat.trycloudflare.com", {
    publicUrl: "https://fancy-cat.trycloudflare.com"
  });
  assert.equal(matches, true);
});

test("isAllowedPublicApiPath only allows stream ingest route", () => {
  assert.equal(isAllowedPublicApiPath("/voice/stream-ingest/frame"), true);
  assert.equal(isAllowedPublicApiPath("/voice/stream-ingest/frame/"), true);
  assert.equal(isAllowedPublicApiPath("/settings"), false);
});

test("classifyApiAccessPath classifies share-session token routes as public session token", () => {
  assert.equal(
    classifyApiAccessPath("/voice/share-session/abcDEF1234567890/frame"),
    "public_session_token"
  );
  assert.equal(isPublicSessionTokenApiPath("/voice/share-session/abcDEF1234567890"), true);
});
