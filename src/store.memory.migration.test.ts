import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { Store } from "./store.ts";

async function withMigratedLegacyStore({ tempPrefix, setupLegacy, run }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), tempPrefix));
  const dbPath = path.join(dir, "clanker.db");
  const legacyDb = new Database(dbPath);

  try {
    setupLegacy(legacyDb);
  } finally {
    legacyDb.close();
  }

  const store = new Store(dbPath);
  store.init();

  try {
    await run(store);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function createLegacyMemoryFactsTable(db) {
  db.exec(`
    CREATE TABLE memory_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      subject TEXT NOT NULL,
      fact TEXT NOT NULL,
      source_message_id TEXT,
      confidence REAL NOT NULL DEFAULT 0.5,
      fact_type TEXT NOT NULL DEFAULT 'general',
      evidence_text TEXT
    );
  `);
}

function insertLegacyFact(db, { subject, fact, sourceMessageId, confidence = 0.7, factType = "preference", evidenceText = "" }) {
  db
    .prepare(
      "INSERT INTO memory_facts(created_at, subject, fact, source_message_id, confidence, fact_type, evidence_text) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(new Date().toISOString(), subject, fact, sourceMessageId, confidence, factType, evidenceText);
}

test("schema migration backfills guild scope from message metadata", async () => {
  await withMigratedLegacyStore({
    tempPrefix: "clanker-store-migrate-test-",
    setupLegacy(legacyDb) {
      legacyDb.exec(`
        CREATE TABLE messages (
          message_id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          guild_id TEXT,
          channel_id TEXT NOT NULL,
          author_id TEXT NOT NULL,
          author_name TEXT NOT NULL,
          is_bot INTEGER NOT NULL,
          content TEXT NOT NULL,
          referenced_message_id TEXT
        );
      `);
      createLegacyMemoryFactsTable(legacyDb);

      legacyDb
        .prepare(
          `INSERT INTO messages(
            message_id, created_at, guild_id, channel_id, author_id, author_name, is_bot, content, referenced_message_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "msg-keep",
          new Date().toISOString(),
          "guild-a",
          "chan-1",
          "user-1",
          "user-1",
          0,
          "hello",
          null
        );
      legacyDb
        .prepare(
          `INSERT INTO messages(
            message_id, created_at, guild_id, channel_id, author_id, author_name, is_bot, content, referenced_message_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "msg-drop",
          new Date().toISOString(),
          "",
          "chan-1",
          "user-1",
          "user-1",
          0,
          "hello",
          null
        );

      insertLegacyFact(legacyDb, {
        subject: "user-1",
        fact: "User likes tea.",
        sourceMessageId: "msg-keep",
        evidenceText: "likes tea"
      });
      insertLegacyFact(legacyDb, {
        subject: "user-1",
        fact: "User likes coffee.",
        sourceMessageId: "msg-drop",
        evidenceText: "likes coffee"
      });
    },
    async run(store) {
      const scoped = store.getFactsForScope({ guildId: "guild-a", limit: 20 });
      assert.equal(scoped.length, 1);
      assert.equal(scoped[0].fact, "User likes tea.");

      const totalRow = store.db.prepare("SELECT COUNT(*) AS count FROM memory_facts").get();
      assert.equal(Number(totalRow?.count || 0), 1);
    }
  });
});

test("schema migration infers guild from voice-style source id", async () => {
  await withMigratedLegacyStore({
    tempPrefix: "clanker-store-migrate-voice-test-",
    setupLegacy(legacyDb) {
      createLegacyMemoryFactsTable(legacyDb);
      insertLegacyFact(legacyDb, {
        subject: "user-voice",
        fact: "User likes karaoke.",
        sourceMessageId: "voice-123456789012345678-1772081847494-abcd",
        confidence: 0.8,
        evidenceText: "likes karaoke"
      });
    },
    async run(store) {
      const scoped = store.getFactsForScope({ guildId: "123456789012345678", limit: 20 });
      assert.equal(scoped.length, 1);
      assert.equal(scoped[0].fact, "User likes karaoke.");
    }
  });
});
