import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  executeSharedMemoryToolSearch,
  executeSharedMemoryToolWrite
} from "./memoryToolRuntime.ts";

test("executeSharedMemoryToolSearch forwards namespace subject and fact-type filters", async () => {
  const calls: Array<Record<string, unknown>> = [];

  const result = await executeSharedMemoryToolSearch({
    runtime: {
      memory: {
        async searchDurableFacts(opts) {
          calls.push(opts as Record<string, unknown>);
          return [
            {
              id: "fact-1",
              subject: "user-1",
              fact: "Alice likes tea.",
              fact_type: "profile",
              score: 0.88,
              created_at: "2026-03-09T00:00:00.000Z"
            }
          ];
        },
        async rememberDirectiveLineDetailed() {
          throw new Error("not used");
        }
      }
    },
    settings: {},
    guildId: "guild-1",
    channelId: "chan-1",
    actorUserId: "user-1",
    namespace: "speaker",
    queryText: "tea",
    tags: ["profile"],
    trace: { source: "test_memory_search" },
    limit: 3
  });

  assert.equal(result.ok, true);
  assert.equal(result.namespace, "user:user-1");
  assert.deepEqual(calls, [{
    guildId: "guild-1",
    scope: "user",
    channelId: "chan-1",
    queryText: "tea",
    subjectIds: ["user-1"],
    factTypes: ["profile"],
    settings: {},
    trace: { source: "test_memory_search" },
    limit: 6
  }]);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]?.text, "Alice likes tea.");
  assert.deepEqual(result.matches[0]?.metadata?.tags, ["profile"]);
});

test("executeSharedMemoryToolSearch uses guild scope for cross-subject lookup", async () => {
  const calls: Array<Record<string, unknown>> = [];

  const result = await executeSharedMemoryToolSearch({
    runtime: {
      memory: {
        async searchDurableFacts(opts) {
          calls.push(opts as Record<string, unknown>);
          return [
            {
              id: "fact-1",
              subject: "__lore__",
              fact: "Sarah likes Rust.",
              fact_type: "preference",
              score: 0.91,
              created_at: "2026-03-09T00:00:00.000Z"
            }
          ];
        },
        async rememberDirectiveLineDetailed() {
          throw new Error("not used");
        }
      }
    },
    settings: {},
    guildId: "guild-1",
    channelId: "chan-1",
    actorUserId: "user-1",
    namespace: "guild",
    queryText: "who likes rust",
    trace: { source: "test_memory_search_guild" },
    limit: 4
  });

  assert.equal(result.ok, true);
  assert.equal(result.namespace, "guild:guild-1");
  assert.deepEqual(calls, [{
    guildId: "guild-1",
    scope: "guild",
    channelId: "chan-1",
    queryText: "who likes rust",
    subjectIds: ["__lore__"],
    factTypes: null,
    settings: {},
    trace: { source: "test_memory_search_guild" },
    limit: 8
  }]);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]?.text, "Sarah likes Rust.");
});

test("executeSharedMemoryToolWrite forwards fact type through dedupe and write", async () => {
  const searchCalls: Array<Record<string, unknown>> = [];
  const writeCalls: Array<Record<string, unknown>> = [];

  const result = await executeSharedMemoryToolWrite({
    runtime: {
      memory: {
        async searchDurableFacts(opts) {
          searchCalls.push(opts as Record<string, unknown>);
          return [];
        },
        async rememberDirectiveLineDetailed(opts) {
          writeCalls.push(opts as Record<string, unknown>);
          return {
            ok: true,
            reason: "added_new",
            factText: String(opts.line || ""),
            subject: String(opts.subjectOverride || ""),
            factType: String(opts.factType || "")
          };
        }
      }
    },
    settings: {},
    guildId: "guild-1",
    channelId: "chan-1",
    actorUserId: "user-1",
    namespace: "speaker",
    items: [{ text: "Alice is my sister.", type: "relationship" }],
    trace: { source: "test_memory_write" },
    sourceMessageIdPrefix: "memory-test",
    sourceText: "Alice is my sister."
  });

  assert.equal(result.ok, true);
  assert.deepEqual(searchCalls, [{
    guildId: "guild-1",
    scope: "user",
    channelId: "chan-1",
    queryText: "Alice is my sister",
    subjectIds: ["user-1"],
    factTypes: ["relationship"],
    settings: {},
    trace: { source: "test_memory_write" },
    limit: 8
  }]);
  assert.equal(writeCalls.length, 1);
  assert.equal(writeCalls[0]?.guildId, "guild-1");
  assert.equal(writeCalls[0]?.channelId, "chan-1");
  assert.equal(writeCalls[0]?.userId, "user-1");
  assert.equal(writeCalls[0]?.scope, "user");
  assert.equal(writeCalls[0]?.subjectOverride, "user-1");
  assert.equal(writeCalls[0]?.factType, "relationship");
  assert.equal(writeCalls[0]?.sourceText, "Alice is my sister.");
  assert.match(String(writeCalls[0]?.sourceMessageId || ""), /^memory-test-\d+-1$/);
  assert.deepEqual(result.written, [{
    status: "added_new",
    text: "Alice is my sister",
    subject: "user-1"
  }]);
});

test("executeSharedMemoryToolSearch defaults to user scope in DMs", async () => {
  const calls: Array<Record<string, unknown>> = [];

  const result = await executeSharedMemoryToolSearch({
    runtime: {
      memory: {
        async searchDurableFacts(opts) {
          calls.push(opts as Record<string, unknown>);
          return [];
        },
        async rememberDirectiveLineDetailed() {
          throw new Error("not used");
        }
      }
    },
    settings: {},
    guildId: null,
    channelId: "dm-chan-1",
    actorUserId: "user-7",
    namespace: "",
    queryText: "what do you remember",
    trace: { source: "test_memory_search_dm" },
    limit: 5
  });

  assert.equal(result.ok, true);
  assert.equal(result.namespace, "user:user-7");
  assert.deepEqual(calls, [{
    guildId: null,
    scope: "user",
    channelId: "dm-chan-1",
    queryText: "what do you remember",
    subjectIds: ["user-7", "__self__"],
    factTypes: null,
    settings: {},
    trace: { source: "test_memory_search_dm" },
    limit: 10
  }]);
});

test("executeSharedMemoryToolWrite rejects guild namespace in DMs", async () => {
  const result = await executeSharedMemoryToolWrite({
    runtime: {
      memory: {
        async searchDurableFacts() {
          return [];
        },
        async rememberDirectiveLineDetailed() {
          return { ok: true };
        }
      }
    },
    settings: {},
    guildId: null,
    channelId: "dm-chan-1",
    actorUserId: "user-7",
    namespace: "guild",
    items: [{ text: "Friday is meme day." }]
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "guild_context_required");
});
