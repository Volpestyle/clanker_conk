import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  getRealtimeConnectErrorDiagnostics,
  sanitizeHandshakeHeaders,
  summarizeRealtimeSocketUrl,
  type RealtimeConnectErrorDiagnostics
} from "./realtimeClientCore.ts";

test("summarizeRealtimeSocketUrl redacts query values and keeps query keys", () => {
  const summarized = summarizeRealtimeSocketUrl(
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=super-secret&model=gemini-2.5-flash-native-audio-preview-12-2025"
  );

  assert.equal(
    summarized,
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=[redacted]&model=[redacted]"
  );
  assert.equal(String(summarized).includes("super-secret"), false);
  assert.equal(String(summarized).includes("gemini-2.5-flash-native-audio-preview-12-2025"), false);
});

test("sanitizeHandshakeHeaders redacts sensitive headers and compacts values", () => {
  const headers = sanitizeHandshakeHeaders({
    "content-type": "application/json; charset=utf-8",
    "x-request-id": "req_123",
    authorization: "Bearer my-token",
    cookie: "sessionid=abc",
    "set-cookie": ["a=1", "b=2"],
    "x-goog-api-key": "gem-key"
  });

  assert.equal(headers?.["content-type"], "application/json; charset=utf-8");
  assert.equal(headers?.["x-request-id"], "req_123");
  assert.equal(headers?.authorization, "[redacted]");
  assert.equal(headers?.cookie, "[redacted]");
  assert.equal(headers?.["set-cookie"], "[redacted]");
  assert.equal(headers?.["x-goog-api-key"], "[redacted]");
});

test("getRealtimeConnectErrorDiagnostics returns normalized diagnostics payload", () => {
  const diagnostics: RealtimeConnectErrorDiagnostics = {
    source: "unexpected_response",
    url: "wss://api.x.ai/v1/realtime",
    statusCode: 401,
    statusMessage: "Unauthorized",
    headers: {
      "content-type": "application/json"
    },
    bodyPreview: "{\"error\":\"bad auth\"}"
  };
  const error = new Error("connect failed") as Error & {
    diagnostics?: RealtimeConnectErrorDiagnostics;
  };
  error.diagnostics = diagnostics;

  const extracted = getRealtimeConnectErrorDiagnostics(error);

  assert.deepEqual(extracted, diagnostics);
});
