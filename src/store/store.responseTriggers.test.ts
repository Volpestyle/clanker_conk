import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { Store } from "../store.ts";

async function withTempStore(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-store-trigger-test-"));
  const dbPath = path.join(dir, "clanker.db");
  const store = new Store(dbPath);
  store.init();

  try {
    await run(store, dbPath);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("hasTriggeredResponse indexes trigger ids from new actions", async () => {
  await withTempStore(async (store) => {
    store.logAction({
      kind: "sent_reply",
      content: "reply",
      metadata: {
        triggerMessageId: "msg-1",
        triggerMessageIds: ["msg-2", "msg-1", "msg-3"]
      }
    });

    assert.equal(store.hasTriggeredResponse("msg-1"), true);
    assert.equal(store.hasTriggeredResponse("msg-2"), true);
    assert.equal(store.hasTriggeredResponse("msg-3"), true);
    assert.equal(store.hasTriggeredResponse("missing-msg"), false);
  });
});

test("syncResponseTriggerIndex backfills pre-index reply actions on startup", async () => {
  await withTempStore(async (store, dbPath) => {
    const createdAt = new Date().toISOString();
    store.db
      .prepare(
        `INSERT INTO actions(
          created_at,
          guild_id,
          channel_id,
          message_id,
          user_id,
          kind,
          content,
          metadata,
          usd_cost
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        createdAt,
        "guild-1",
        "channel-1",
        "bot-msg-1",
        "bot-user",
        "sent_reply",
        "legacy row",
        JSON.stringify({
          triggerMessageId: "legacy-msg",
          triggerMessageIds: ["legacy-extra"]
        }),
        0
      );

    store.close();
    const reopened = new Store(dbPath);
    reopened.init();
    try {
      assert.equal(reopened.hasTriggeredResponse("legacy-msg"), true);
      assert.equal(reopened.hasTriggeredResponse("legacy-extra"), true);
    } finally {
      reopened.close();
    }
  });
});
