import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { getResolvedVoiceAdmissionClassifierBinding } from "../settings/agentStack.ts";
import { Store } from "./store.ts";
import { createTestSettingsPatch } from "../testSettings.ts";

async function withTempStore(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-store-test-"));
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

test("memory facts are scoped by guild", async () => {
  await withTempStore(async (store) => {
    const factPayload = {
      channelId: "channel-1",
      subject: "user-1",
      fact: "User likes pineapple pizza.",
      factType: "preference",
      evidenceText: "likes pineapple pizza",
      sourceMessageId: "msg-1",
      confidence: 0.7
    };

    const insertedA = store.addMemoryFact({
      ...factPayload,
      guildId: "guild-a"
    });
    const insertedB = store.addMemoryFact({
      ...factPayload,
      guildId: "guild-b",
      sourceMessageId: "msg-2"
    });

    assert.equal(insertedA, true);
    assert.equal(insertedB, true);

    const guildAFacts = store.getFactsForSubjects(["user-1"], 10, { guildId: "guild-a" });
    const guildBFacts = store.getFactsForSubjects(["user-1"], 10, { guildId: "guild-b" });
    assert.equal(guildAFacts.length, 1);
    assert.equal(guildBFacts.length, 1);
    assert.equal(guildAFacts[0].guild_id, "guild-a");
    assert.equal(guildBFacts[0].guild_id, "guild-b");
  });
});

test("archiveOldFactsForSubject evicts contextual facts before core facts", async () => {
  await withTempStore(async (store) => {
    const addFact = (subject: string, fact: string, factType: string, sourceMessageId: string) => {
      store.addMemoryFact({
        guildId: "guild-a",
        channelId: "chan-1",
        subject,
        fact,
        factType,
        sourceMessageId,
        confidence: 0.6
      });
    };

    for (let i = 1; i <= 19; i += 1) {
      addFact("user-context-first", `Core ${i}.`, i % 2 === 0 ? "relationship" : "profile", `core-a-${i}`);
    }
    addFact("user-context-first", "Context 1.", "preference", "ctx-a-1");
    addFact("user-context-first", "Context 2.", "preference", "ctx-a-2");
    addFact("user-context-first", "Context 3.", "preference", "ctx-a-3");

    const archivedContextual = store.archiveOldFactsForSubject({
      guildId: "guild-a",
      subject: "user-context-first",
      keep: 20
    });
    assert.equal(archivedContextual, 2);
    const contextFirstFacts = store.getFactsForSubjects(["user-context-first"], 30, { guildId: "guild-a" });
    assert.equal(contextFirstFacts.filter((row) => row.fact_type === "profile" || row.fact_type === "relationship").length, 19);
    assert.equal(contextFirstFacts.filter((row) => row.fact_type === "preference").length, 1);

    for (let i = 1; i <= 22; i += 1) {
      addFact("user-core-cap", `Core cap ${i}.`, i % 2 === 0 ? "relationship" : "profile", `core-b-${i}`);
    }
    addFact("user-core-cap", "Context survivor.", "preference", "ctx-b-1");

    const archivedMixed = store.archiveOldFactsForSubject({
      guildId: "guild-a",
      subject: "user-core-cap",
      keep: 20
    });
    assert.equal(archivedMixed, 3);
    const coreCapFacts = store.getFactsForSubjects(["user-core-cap"], 30, { guildId: "guild-a" });
    assert.equal(coreCapFacts.filter((row) => row.fact_type === "preference").length, 0);
    assert.equal(coreCapFacts.filter((row) => row.fact_type === "profile" || row.fact_type === "relationship").length, 20);
  });
});

test("voice reply decision llm settings normalize provider and model", async () => {
  await withTempStore(async (store) => {
    const patched = store.patchSettings(createTestSettingsPatch({
      voice: {
        replyDecisionLlm: {
          provider: "CLAUDE-OAUTH",
          model: " claude-opus-4-6 "
        }
      }
    }));

    const binding = getResolvedVoiceAdmissionClassifierBinding(patched);
    assert.equal(binding?.provider, "claude-oauth");
    assert.equal(binding?.model, "claude-opus-4-6");
  });
});
