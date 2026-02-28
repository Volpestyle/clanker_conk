import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { Store } from "../store.ts";

async function withTempStore(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-store-trigger-test-"));
  const store = new Store(path.join(dir, "clanker.db"));
  store.init();

  try {
    await run(store);
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
