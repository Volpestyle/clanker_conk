import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { DEFAULT_SETTINGS } from "../settings/settingsSchema.ts";
import { getResolvedVoiceAdmissionClassifierBinding } from "../settings/agentStack.ts";
import { Store } from "./store.ts";
import { normalizeSettings } from "./settingsNormalization.ts";
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

    // Create enough core facts to exceed the core cap (35) plus some contextual,
    // so the eviction path must archive contextual first, then overflow into core.
    for (let i = 1; i <= 38; i += 1) {
      addFact("user-core-cap", `Core cap ${i}.`, i % 2 === 0 ? "relationship" : "profile", `core-b-${i}`);
    }
    addFact("user-core-cap", "Context survivor.", "preference", "ctx-b-1");

    const archivedMixed = store.archiveOldFactsForSubject({
      guildId: "guild-a",
      subject: "user-core-cap",
      keep: 36
    });
    // 39 total, keep 36 → 3 to archive. 1 contextual archived first, then 2 oldest core.
    assert.equal(archivedMixed, 3);
    const coreCapFacts = store.getFactsForSubjects(["user-core-cap"], 50, { guildId: "guild-a" });
    assert.equal(coreCapFacts.filter((row) => row.fact_type === "preference").length, 0);
    assert.equal(coreCapFacts.filter((row) => row.fact_type === "profile" || row.fact_type === "relationship").length, 36);
  });
});

test("memory facts support query filtering and scope filters", async () => {
  await withTempStore(async (store) => {
    store.addMemoryFact({
      guildId: "guild-a",
      channelId: "chan-1",
      subject: "user-1",
      fact: "User likes old school DS hardware.",
      factType: "preference",
      evidenceText: "Mentioned old school DS hardware.",
      sourceMessageId: "msg-1",
      confidence: 0.77
    });
    store.addMemoryFact({
      guildId: "guild-a",
      channelId: "chan-2",
      subject: "user-2",
      fact: "User likes tea.",
      factType: "preference",
      evidenceText: "Mentioned tea.",
      sourceMessageId: "msg-2",
      confidence: 0.61
    });

    const matching = store.getFactsForScope({
      guildId: "guild-a",
      limit: 10,
      queryText: "old school ds"
    });
    assert.equal(matching.length, 1);
    assert.equal(matching[0]?.subject, "user-1");

    const subjectFiltered = store.getFactsForScope({
      guildId: "guild-a",
      limit: 10,
      subjectIds: ["user-2"]
    });
    assert.equal(subjectFiltered.length, 1);
    assert.equal(subjectFiltered[0]?.subject, "user-2");

    const typeFiltered = store.getFactsForScope({
      guildId: "guild-a",
      limit: 10,
      factTypes: ["preference"]
    });
    assert.equal(typeFiltered.length, 2);
  });
});

test("memory facts can be updated and soft-deleted while clearing stale vectors", async () => {
  await withTempStore(async (store) => {
    store.addMemoryFact({
      guildId: "guild-a",
      channelId: "chan-1",
      subject: "user-1",
      fact: "User likes handhelds.",
      factType: "preference",
      evidenceText: "Mentioned handhelds.",
      sourceMessageId: "msg-1",
      confidence: 0.66
    });

    const inserted = store.getMemoryFactBySubjectAndFact("guild-a", "user-1", "User likes handhelds.");
    assert.ok(inserted);

    const factId = Number(inserted?.id);
    store.upsertMemoryFactVectorNative({
      factId,
      model: "text-embedding-3-small",
      embedding: [0.1, 0.2, 0.3]
    });
    const vector = store.getMemoryFactVectorNative(factId, "text-embedding-3-small");
    assert.ok(vector);
    assert.equal(vector?.length, 3);

    const updated = store.updateMemoryFact({
      guildId: "guild-a",
      factId,
      subject: "user-1",
      fact: "User likes handheld PCs.",
      factType: "project",
      evidenceText: "Updated by operator.",
      confidence: 0.91
    });

    assert.equal(updated.ok, true);
    assert.equal(updated.row?.fact, "User likes handheld PCs.");
    assert.equal(updated.row?.fact_type, "project");
    assert.equal(updated.row?.evidence_text, "Updated by operator.");
    assert.equal(updated.row?.confidence, 0.91);
    assert.equal(store.getMemoryFactVectorNative(factId, "text-embedding-3-small"), null);

    const deleted = store.deleteMemoryFact({
      guildId: "guild-a",
      factId
    });

    assert.equal(deleted.ok, true);
    assert.equal(deleted.deleted, 1);
    assert.equal(store.getMemoryFactById(factId, "guild-a"), null);
    assert.equal(
      store.getFactsForScope({
        guildId: "guild-a",
        limit: 10,
        subjectIds: ["user-1"]
      }).length,
      0
    );
  });
});

test("rewriteRuntimeSettingsRow migrates legacy claude_oauth bootstrap defaults to sonnet brain generation", async () => {
  await withTempStore(async (store) => {
    const legacyDefaultSettingsJson = JSON.stringify(normalizeSettings(DEFAULT_SETTINGS));

    store.db
      .prepare("UPDATE settings SET value = ? WHERE key = ?")
      .run(legacyDefaultSettingsJson, "runtime_settings");

    const rewritten = store.rewriteRuntimeSettingsRow(legacyDefaultSettingsJson);
    const stored = store.getSettings();
    const generation = stored.agentStack.runtimeConfig.voice.generation as {
      mode: string;
      model?: { provider: string; model: string };
    };

    assert.equal(rewritten.agentStack.preset, "claude_oauth");
    assert.equal(generation.mode, "dedicated_model");
    assert.deepEqual(generation.model, {
      provider: "claude-oauth",
      model: "claude-sonnet-4-6"
    });
  });
});

test("voice reply decision llm settings normalize provider and model", async () => {
  await withTempStore(async (store) => {
    const patched = store.patchSettings(createTestSettingsPatch({
      voice: {
        admission: {
          mode: "classifier_gate"
        }
      },
      agentStack: {
        advancedOverridesEnabled: true,
        overrides: {
          voiceAdmissionClassifier: {
            mode: "dedicated_model",
            model: {
              provider: "CLAUDE-OAUTH",
              model: " claude-opus-4-6 "
            }
          }
        }
      }
    }));

    const binding = getResolvedVoiceAdmissionClassifierBinding(patched);
    assert.equal(binding?.provider, "claude-oauth");
    assert.equal(binding?.model, "claude-opus-4-6");
  });
});
