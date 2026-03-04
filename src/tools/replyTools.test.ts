import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildReplyToolSet, executeReplyTool } from "./replyTools.ts";

test("buildReplyToolSet includes browser_browse when browser agent is enabled and available", () => {
  const tools = buildReplyToolSet({
    browser: { enabled: true },
    webSearch: { enabled: false },
    memory: { enabled: false },
    adaptiveDirectives: { enabled: false }
  }, {
    browserBrowseAvailable: true,
    conversationSearchAvailable: false
  });

  assert.equal(tools.some((tool) => tool.name === "browser_browse"), true);
});

test("buildReplyToolSet excludes browser_browse when caller opts out", () => {
  const tools = buildReplyToolSet({
    browser: { enabled: true },
    webSearch: { enabled: false },
    memory: { enabled: false },
    adaptiveDirectives: { enabled: false }
  }, {
    browserBrowseAvailable: false,
    conversationSearchAvailable: false
  });

  assert.equal(tools.some((tool) => tool.name === "browser_browse"), false);
});

test("executeReplyTool delegates browser_browse to runtime", async () => {
  const calls: Array<Record<string, unknown>> = [];

  const result = await executeReplyTool(
    "browser_browse",
    { query: "check the latest post" },
    {
      browser: {
        async browse(opts) {
          calls.push(opts);
          return {
            text: "Found the latest post.",
            steps: 3,
            hitStepLimit: false
          };
        }
      }
    },
    {
      settings: {},
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      sourceMessageId: "msg-1",
      sourceText: "browse it",
      trace: {
        source: "reply_message"
      }
    }
  );

  assert.equal(result.isError, undefined);
  assert.match(result.content, /Found the latest post\./);
  assert.match(result.content, /Steps: 3/);
  assert.deepEqual(calls, [{
    settings: {},
    query: "check the latest post",
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    source: "reply_message"
  }]);
});
