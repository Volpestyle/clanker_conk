import { test } from "bun:test";
import assert from "node:assert/strict";
import { BrowserTaskRegistry, buildBrowserTaskScopeKey, isAbortError } from "./browserTaskRuntime.ts";

test("BrowserTaskRegistry scopes active browser tasks to the channel and does not clear newer tasks", () => {
  const registry = new BrowserTaskRegistry();
  const scopeKey = buildBrowserTaskScopeKey({
    guildId: "guild-1",
    channelId: "channel-1"
  });

  const firstTask = registry.beginTask(scopeKey);
  assert.equal(firstTask.abortController.signal.aborted, false);

  const secondTask = registry.beginTask(scopeKey);
  assert.equal(firstTask.abortController.signal.aborted, true);
  assert.equal(Boolean(registry.get(scopeKey)), true);
  assert.equal(registry.get(scopeKey)?.taskId, secondTask.taskId);

  registry.clear(firstTask);
  assert.equal(registry.get(scopeKey)?.taskId, secondTask.taskId);

  registry.clear(secondTask);
  assert.equal(registry.get(scopeKey), undefined);
});

test("BrowserTaskRegistry aborts only the matching channel scope", () => {
  const registry = new BrowserTaskRegistry();
  const firstScopeKey = buildBrowserTaskScopeKey({
    guildId: "guild-1",
    channelId: "channel-1"
  });
  const secondScopeKey = buildBrowserTaskScopeKey({
    guildId: "guild-1",
    channelId: "channel-2"
  });

  registry.beginTask(firstScopeKey);
  const secondTask = registry.beginTask(secondScopeKey);

  const cancelled = registry.abort(firstScopeKey, "cancel first");
  assert.equal(cancelled, true);
  assert.equal(registry.get(firstScopeKey), undefined);
  assert.equal(registry.get(secondScopeKey)?.taskId, secondTask.taskId);
});

test("isAbortError recognizes native and wrapped abort failures", () => {
  assert.equal(isAbortError(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })), true);
  assert.equal(isAbortError(new Error("AbortError: Browse agent run cancelled")), true);
  assert.equal(isAbortError(new Error("ordinary failure")), false);
});
