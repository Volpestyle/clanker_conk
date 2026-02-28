import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { Store } from "../store.ts";

async function withTempStore(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-store-lookup-test-"));
  const dbPath = path.join(dir, "clanker.db");
  const store = new Store(dbPath);
  store.init();

  try {
    await run(store);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("searchLookupContext returns relevant short-term lookup memory", async () => {
  await withTempStore(async (store) => {
    const rustSaved = store.recordLookupContext({
      guildId: "guild-1",
      channelId: "chan-1",
      userId: "user-1",
      source: "reply_web_lookup",
      query: "latest rust stable version",
      provider: "brave",
      results: [
        {
          title: "Rust Releases",
          url: "https://blog.rust-lang.org/releases/",
          domain: "blog.rust-lang.org",
          snippet: "Rust release notes."
        }
      ]
    });
    const bunSaved = store.recordLookupContext({
      guildId: "guild-1",
      channelId: "chan-1",
      userId: "user-1",
      source: "reply_web_lookup",
      query: "bun release notes",
      provider: "brave",
      results: [
        {
          title: "Bun Release Notes",
          url: "https://bun.sh/blog",
          domain: "bun.sh",
          snippet: "Bun runtime release updates."
        }
      ]
    });

    assert.equal(rustSaved, true);
    assert.equal(bunSaved, true);

    const rows = store.searchLookupContext({
      guildId: "guild-1",
      channelId: "chan-1",
      queryText: "what rust stable is current",
      limit: 4
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.query, "latest rust stable version");
    assert.equal(rows[0]?.results?.[0]?.domain, "blog.rust-lang.org");
  });
});

test("recordLookupContext enforces per-channel cap and expiry filtering", async () => {
  await withTempStore(async (store) => {
    for (let index = 1; index <= 4; index += 1) {
      const saved = store.recordLookupContext({
        guildId: "guild-1",
        channelId: "chan-1",
        source: "reply_web_lookup",
        query: `query-${index}`,
        provider: "brave",
        maxRowsPerChannel: 2,
        results: [
          {
            title: `Result ${index}`,
            url: `https://example.com/${index}`,
            domain: "example.com",
            snippet: `snippet-${index}`
          }
        ]
      });
      assert.equal(saved, true);
    }

    const cappedRows = store.searchLookupContext({
      guildId: "guild-1",
      channelId: "chan-1",
      queryText: "",
      limit: 10
    });
    assert.equal(cappedRows.length, 2);
    assert.equal(cappedRows[0]?.query, "query-4");
    assert.equal(cappedRows[1]?.query, "query-3");

    store.db
      .prepare(
        `UPDATE lookup_context
         SET expires_at = ?`
      )
      .run("2000-01-01T00:00:00.000Z");

    const expiredRows = store.searchLookupContext({
      guildId: "guild-1",
      channelId: "chan-1",
      queryText: "",
      limit: 10
    });
    assert.equal(expiredRows.length, 0);
  });
});
