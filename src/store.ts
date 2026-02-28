import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { load as loadSqliteVec } from "sqlite-vec";
import { DEFAULT_SETTINGS } from "./settings/settingsSchema.ts";
import { clamp, deepMerge, nowIso } from "./utils.ts";
import {
  buildAutomationMatchText,
  normalizeAutomationInstruction,
  normalizeAutomationTitle
} from "./automation.ts";
import { normalizeSettings } from "./store/settingsNormalization.ts";
import {
  mapAutomationRow,
  normalizeAutomationRunStatus,
  normalizeAutomationStatus,
  normalizeAutomationStatusFilter,
  normalizeEmbeddingVector,
  normalizeMessageCreatedAt,
  parseEmbeddingBlob,
  safeJsonParse,
  vectorToBlob
} from "./store/storeHelpers.ts";
import {
  normalizeResponseTriggerMessageIds,
  shouldTrackResponseTriggerKind
} from "./store/responseTriggers.ts";

const SETTINGS_KEY = "runtime_settings";
const RESPONSE_TRIGGER_INDEX_STATE_KEY = "__response_trigger_index_last_action_id__";

export class Store {
  dbPath;
  db;
  sqliteVecReady;
  sqliteVecError;

  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.sqliteVecReady = null;
    this.sqliteVecError = "";
  }

  init() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
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

      CREATE TABLE IF NOT EXISTS actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        guild_id TEXT,
        channel_id TEXT,
        message_id TEXT,
        user_id TEXT,
        kind TEXT NOT NULL,
        content TEXT,
        metadata TEXT,
        usd_cost REAL NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS memory_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        channel_id TEXT,
        subject TEXT NOT NULL,
        fact TEXT NOT NULL,
        fact_type TEXT NOT NULL DEFAULT 'general',
        evidence_text TEXT,
        source_message_id TEXT,
        confidence REAL NOT NULL DEFAULT 0.5,
        is_active INTEGER NOT NULL DEFAULT 1,
        UNIQUE(guild_id, subject, fact)
      );

      CREATE TABLE IF NOT EXISTS memory_fact_vectors_native (
        fact_id INTEGER NOT NULL,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        embedding_blob BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (fact_id, model)
      );

      CREATE TABLE IF NOT EXISTS shared_links (
        url TEXT PRIMARY KEY,
        first_shared_at TEXT NOT NULL,
        last_shared_at TEXT NOT NULL,
        share_count INTEGER NOT NULL DEFAULT 1,
        source TEXT
      );

      CREATE TABLE IF NOT EXISTS automations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        created_by_name TEXT,
        title TEXT NOT NULL,
        instruction TEXT NOT NULL,
        schedule_json TEXT NOT NULL,
        next_run_at TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        is_running INTEGER NOT NULL DEFAULT 0,
        running_started_at TEXT,
        last_run_at TEXT,
        last_error TEXT,
        last_result TEXT,
        match_text TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automation_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        automation_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        summary TEXT,
        error TEXT,
        message_id TEXT,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS response_triggers (
        trigger_message_id TEXT PRIMARY KEY,
        action_id INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_channel_time ON messages(channel_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_guild_time ON messages(guild_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_actions_kind_time ON actions(kind, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_actions_time ON actions(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_vectors_native_model_dims ON memory_fact_vectors_native(model, dims);
      CREATE INDEX IF NOT EXISTS idx_shared_links_last_shared_at ON shared_links(last_shared_at DESC);
      CREATE INDEX IF NOT EXISTS idx_automations_scope_status_next ON automations(guild_id, status, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_automations_running_next ON automations(is_running, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_automations_match_text ON automations(guild_id, match_text);
      CREATE INDEX IF NOT EXISTS idx_automation_runs_job_time ON automation_runs(automation_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_response_triggers_action_id ON response_triggers(action_id);
    `);
    this.ensureSqliteVecReady();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_scope_subject ON memory_facts(guild_id, subject, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_scope_channel ON memory_facts(guild_id, channel_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_scope_subject_type ON memory_facts(guild_id, subject, fact_type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_scope_active ON memory_facts(guild_id, is_active, created_at DESC);
    `);

    if (!this.db.prepare("SELECT 1 FROM settings WHERE key = ?").get(SETTINGS_KEY)) {
      const defaultSettings = normalizeSettings(DEFAULT_SETTINGS);
      this.db
        .prepare("INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)")
        .run(SETTINGS_KEY, JSON.stringify(defaultSettings), nowIso());
    } else {
      const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(SETTINGS_KEY);
      this.rewriteRuntimeSettingsRow(row?.value);
    }

    this.syncResponseTriggerIndex();
  }

  rewriteRuntimeSettingsRow(rawValue) {
    const parsed = safeJsonParse(rawValue, DEFAULT_SETTINGS);
    const normalized = normalizeSettings(parsed);
    const normalizedJson = JSON.stringify(normalized);
    if (normalizedJson === String(rawValue || "")) return normalized;

    this.db
      .prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?")
      .run(normalizedJson, nowIso(), SETTINGS_KEY);
    return normalized;
  }

  getSettings() {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(SETTINGS_KEY);
    const parsed = safeJsonParse(row?.value, DEFAULT_SETTINGS);
    return normalizeSettings(parsed);
  }

  setSettings(next) {
    const normalized = normalizeSettings(next);
    this.db
      .prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?")
      .run(JSON.stringify(normalized), nowIso(), SETTINGS_KEY);
    return normalized;
  }

  patchSettings(patch) {
    const current = this.getSettings();
    const merged = deepMerge(current, patch ?? {});
    return this.setSettings(merged);
  }

  recordMessage(message) {
    const createdAt = normalizeMessageCreatedAt(
      message?.createdAt ?? message?.created_at ?? message?.createdTimestamp
    );
    this.db
      .prepare(
        `INSERT INTO messages(
          message_id,
          created_at,
          guild_id,
          channel_id,
          author_id,
          author_name,
          is_bot,
          content,
          referenced_message_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET
          guild_id = excluded.guild_id,
          channel_id = excluded.channel_id,
          author_id = excluded.author_id,
          author_name = excluded.author_name,
          is_bot = excluded.is_bot,
          content = excluded.content,
          referenced_message_id = excluded.referenced_message_id`
      )
      .run(
        String(message.messageId),
        createdAt,
        message.guildId ? String(message.guildId) : null,
        String(message.channelId),
        String(message.authorId),
        String(message.authorName).slice(0, 80),
        message.isBot ? 1 : 0,
        String(message.content ?? "").slice(0, 2000),
        message.referencedMessageId ? String(message.referencedMessageId) : null
      );
  }

  getRecentMessages(channelId, limit = 40) {
    return this.db
      .prepare(
        `SELECT message_id, created_at, channel_id, author_id, author_name, is_bot, content
         FROM messages
         WHERE channel_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(String(channelId), clamp(Math.floor(limit), 1, 200));
  }

  getRecentMessagesAcrossGuild(guildId, limit = 120) {
    return this.db
      .prepare(
        `SELECT message_id, created_at, channel_id, author_id, author_name, is_bot, content
         FROM messages
         WHERE guild_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(String(guildId), clamp(Math.floor(limit), 1, 300));
  }

  searchRelevantMessages(channelId, queryText, limit = 8) {
    const raw = String(queryText ?? "").toLowerCase();
    const tokens = [...new Set(raw.match(/[a-z0-9]{4,}/g) ?? [])].slice(0, 5);

    if (!tokens.length) {
      return this.db
        .prepare(
          `SELECT message_id, created_at, channel_id, author_id, author_name, is_bot, content
           FROM messages
           WHERE channel_id = ? AND is_bot = 0
           ORDER BY created_at DESC
           LIMIT ?`
        )
        .all(String(channelId), clamp(limit, 1, 24));
    }

    const clauses = tokens.map(() => "content LIKE ?").join(" OR ");
    const args = [String(channelId), ...tokens.map((t) => `%${t}%`), clamp(limit, 1, 24)];

    return this.db
      .prepare(
        `SELECT message_id, created_at, channel_id, author_id, author_name, is_bot, content
         FROM messages
         WHERE channel_id = ? AND is_bot = 0 AND (${clauses})
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...args);
  }

  getActiveChannels(guildId, hours = 24, limit = 10) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    return this.db
      .prepare(
        `SELECT channel_id, COUNT(*) AS message_count
         FROM messages
         WHERE guild_id = ? AND is_bot = 0 AND created_at >= ?
         GROUP BY channel_id
         ORDER BY message_count DESC
         LIMIT ?`
      )
      .all(String(guildId), since, clamp(limit, 1, 50));
  }

  logAction(action) {
    const metadata = action.metadata ? JSON.stringify(action.metadata) : null;
    const createdAt = nowIso();
    const actionKind = String(action.kind);

    const result = this.db
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
        action.guildId ? String(action.guildId) : null,
        action.channelId ? String(action.channelId) : null,
        action.messageId ? String(action.messageId) : null,
        action.userId ? String(action.userId) : null,
        actionKind,
        action.content ? String(action.content).slice(0, 2000) : null,
        metadata,
        Number(action.usdCost) || 0
      );

    this.indexResponseTriggersForAction({
      actionId: Number(result?.lastInsertRowid || 0),
      kind: actionKind,
      metadata: action.metadata,
      createdAt
    });
  }

  countActionsSince(kind, sinceIso) {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM actions WHERE kind = ? AND created_at >= ?")
      .get(String(kind), String(sinceIso));
    return Number(row?.count ?? 0);
  }

  getLastActionTime(kind) {
    const row = this.db
      .prepare(
        `SELECT created_at
         FROM actions
         WHERE kind = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(String(kind));

    return row?.created_at ?? null;
  }

  countInitiativePostsSince(sinceIso) {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM actions
         WHERE kind = 'initiative_post' AND created_at >= ?`
      )
      .get(String(sinceIso));
    return Number(row?.count ?? 0);
  }

  wasLinkSharedSince(url, sinceIso) {
    const normalizedUrl = String(url || "").trim();
    if (!normalizedUrl) return false;

    const row = this.db
      .prepare(
        `SELECT 1
         FROM shared_links
         WHERE url = ? AND last_shared_at >= ?
         LIMIT 1`
      )
      .get(normalizedUrl, String(sinceIso));

    return Boolean(row);
  }

  recordSharedLink({ url, source = null }) {
    const normalizedUrl = String(url || "").trim();
    if (!normalizedUrl) return;

    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO shared_links(url, first_shared_at, last_shared_at, share_count, source)
         VALUES(?, ?, ?, 1, ?)
         ON CONFLICT(url) DO UPDATE SET
           last_shared_at = excluded.last_shared_at,
           share_count = shared_links.share_count + 1,
           source = excluded.source`
      )
      .run(normalizedUrl, now, now, source ? String(source).slice(0, 120) : null);
  }

  indexResponseTriggersForAction({
    actionId,
    kind,
    metadata,
    createdAt = nowIso()
  }) {
    const normalizedActionId = Number(actionId);
    if (!Number.isInteger(normalizedActionId) || normalizedActionId <= 0) return;
    if (!shouldTrackResponseTriggerKind(kind)) return;

    const triggerMessageIds = normalizeResponseTriggerMessageIds(metadata);
    if (!triggerMessageIds.length) return;

    const insertTrigger = this.db.prepare(
      `INSERT OR IGNORE INTO response_triggers(trigger_message_id, action_id, created_at)
       VALUES (?, ?, ?)`
    );
    const insertTx = this.db.transaction((ids, responseActionId, responseCreatedAt) => {
      for (const triggerMessageId of ids) {
        insertTrigger.run(triggerMessageId, responseActionId, responseCreatedAt);
      }
    });
    insertTx(triggerMessageIds, normalizedActionId, String(createdAt || nowIso()));
  }

  getResponseTriggerIndexCursor() {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ? LIMIT 1")
      .get(RESPONSE_TRIGGER_INDEX_STATE_KEY);
    const parsed = safeJsonParse(row?.value, null);
    const rawLastActionId = Number(parsed?.lastActionId);
    if (!Number.isFinite(rawLastActionId)) return 0;
    if (rawLastActionId <= 0) return 0;
    return Math.floor(rawLastActionId);
  }

  setResponseTriggerIndexCursor(lastActionId) {
    const normalizedLastActionId = Number(lastActionId);
    if (!Number.isFinite(normalizedLastActionId) || normalizedLastActionId < 0) return;

    this.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at)
         VALUES(?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`
      )
      .run(
        RESPONSE_TRIGGER_INDEX_STATE_KEY,
        JSON.stringify({ lastActionId: Math.floor(normalizedLastActionId) }),
        nowIso()
      );
  }

  syncResponseTriggerIndex({ batchSize = 500 } = {}) {
    const boundedBatchSize = clamp(Math.floor(Number(batchSize) || 500), 50, 2000);
    let cursor = this.getResponseTriggerIndexCursor();
    const originalCursor = cursor;
    const selectTrackedActions = this.db.prepare(
      `SELECT id, created_at, kind, metadata
       FROM actions
       WHERE id > ?
         AND kind IN ('sent_reply', 'sent_message', 'reply_skipped')
       ORDER BY id ASC
       LIMIT ?`
    );

    while (true) {
      const rows = selectTrackedActions.all(cursor, boundedBatchSize);
      if (!rows.length) break;

      for (const row of rows) {
        const actionId = Number(row?.id);
        if (!Number.isInteger(actionId) || actionId <= 0) continue;
        const metadata = safeJsonParse(row?.metadata, null);
        this.indexResponseTriggersForAction({
          actionId,
          kind: row?.kind,
          metadata,
          createdAt: row?.created_at
        });
      }

      const nextCursor = Number(rows[rows.length - 1]?.id || 0);
      if (!Number.isInteger(nextCursor) || nextCursor <= cursor) break;
      cursor = nextCursor;
      if (rows.length < boundedBatchSize) break;
    }

    if (cursor > originalCursor) {
      this.setResponseTriggerIndexCursor(cursor);
    }
  }

  hasTriggeredResponse(triggerMessageId) {
    const id = String(triggerMessageId).trim();
    if (!id) return false;

    const row = this.db
      .prepare(
        `SELECT 1
         FROM response_triggers
         WHERE trigger_message_id = ?
         LIMIT 1`
      )
      .get(id);

    return Boolean(row);
  }

  getRecentActions(limit = 200) {
    const parsedLimit = Number(limit);
    const boundedLimit = clamp(Number.isFinite(parsedLimit) ? Math.floor(parsedLimit) : 200, 1, 1000);
    const rows = this.db
      .prepare(
        `SELECT id, created_at, guild_id, channel_id, message_id, user_id, kind, content, metadata, usd_cost
         FROM actions
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(boundedLimit);

    return rows.map((row) => ({
      ...row,
      metadata: safeJsonParse(row.metadata, null)
    }));
  }

  getReplyPerformanceStats({ windowHours = 24, maxSamples = 4000 } = {}) {
    const boundedHours = clamp(Math.floor(Number(windowHours) || 24), 1, 168);
    const boundedSamples = clamp(Math.floor(Number(maxSamples) || 4000), 100, 20000);
    const sinceIso = new Date(Date.now() - boundedHours * 60 * 60 * 1000).toISOString();

    const rows = this.db
      .prepare(
        `SELECT kind, metadata
         FROM actions
         WHERE created_at >= ?
           AND kind IN ('sent_reply', 'sent_message', 'reply_skipped')
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(sinceIso, boundedSamples);

    const byKind = {
      sent_reply: 0,
      sent_message: 0,
      reply_skipped: 0
    };
    const totalMsValues = [];
    const processingMsValues = [];
    const queueMsValues = [];
    const ingestMsValues = [];
    const memorySliceMsValues = [];
    const llm1MsValues = [];
    const followupMsValues = [];
    const typingDelayMsValues = [];
    const sendMsValues = [];

    for (const row of rows) {
      const metadata = safeJsonParse(row?.metadata, null);
      const performance = metadata?.performance;
      if (!performance || typeof performance !== "object") continue;

      const kind = String(row?.kind || "");
      if (kind in byKind) byKind[kind] += 1;

      pushPerformanceMetric(totalMsValues, performance.totalMs);
      pushPerformanceMetric(processingMsValues, performance.processingMs);
      pushPerformanceMetric(queueMsValues, performance.queueMs);
      pushPerformanceMetric(ingestMsValues, performance.ingestMs);
      pushPerformanceMetric(memorySliceMsValues, performance.memorySliceMs);
      pushPerformanceMetric(llm1MsValues, performance.llm1Ms);
      pushPerformanceMetric(followupMsValues, performance.followupMs);
      pushPerformanceMetric(typingDelayMsValues, performance.typingDelayMs);
      pushPerformanceMetric(sendMsValues, performance.sendMs);
    }

    return {
      windowHours: boundedHours,
      sampleLimit: boundedSamples,
      sampleCount: totalMsValues.length,
      byKind,
      totalMs: summarizeLatencyMetric(totalMsValues),
      processingMs: summarizeLatencyMetric(processingMsValues),
      phases: {
        queueMs: summarizeLatencyMetric(queueMsValues),
        ingestMs: summarizeLatencyMetric(ingestMsValues),
        memorySliceMs: summarizeLatencyMetric(memorySliceMsValues),
        llm1Ms: summarizeLatencyMetric(llm1MsValues),
        followupMs: summarizeLatencyMetric(followupMsValues),
        typingDelayMs: summarizeLatencyMetric(typingDelayMsValues),
        sendMs: summarizeLatencyMetric(sendMsValues)
      }
    };
  }

  getStats() {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const rows = this.db
      .prepare(
        `SELECT kind, COUNT(*) AS count
         FROM actions
         WHERE created_at >= ?
         GROUP BY kind`
      )
      .all(since24h);

    const totalCostRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(usd_cost), 0) AS total
         FROM actions`
      )
      .get();

    const dayCostRows = this.db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, COALESCE(SUM(usd_cost), 0) AS usd
         FROM actions
         WHERE created_at >= ?
         GROUP BY day
         ORDER BY day DESC
         LIMIT 14`
      )
      .all(new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString());

    const out = {
      last24h: {
        sent_reply: 0,
        sent_message: 0,
        initiative_post: 0,
        reacted: 0,
        llm_call: 0,
        image_call: 0,
        gif_call: 0,
        search_call: 0,
        video_context_call: 0,
        asr_call: 0,
        voice_session_start: 0,
        voice_session_end: 0,
        voice_intent_detected: 0,
        voice_turn_in: 0,
        voice_turn_out: 0,
        voice_soundboard_play: 0,
        voice_error: 0
      },
      totalCostUsd: Number(totalCostRow?.total ?? 0),
      dailyCost: dayCostRows,
      performance: this.getReplyPerformanceStats({
        windowHours: 24,
        maxSamples: 4000
      })
    };

    for (const row of rows) {
      if (row.kind in out.last24h) {
        out.last24h[row.kind] = Number(row.count ?? 0);
      }
    }

    return out;
  }

  createAutomation({
    guildId,
    channelId,
    createdByUserId,
    createdByName = "",
    title,
    instruction,
    schedule,
    nextRunAt = null
  }) {
    const normalizedGuildId = String(guildId || "").trim();
    const normalizedChannelId = String(channelId || "").trim();
    const normalizedCreatedBy = String(createdByUserId || "").trim();
    const normalizedTitle = normalizeAutomationTitle(title, "scheduled task");
    const normalizedInstruction = normalizeAutomationInstruction(instruction);

    if (!normalizedGuildId || !normalizedChannelId || !normalizedCreatedBy || !normalizedInstruction) {
      return null;
    }

    const normalizedSchedule = safeJsonParse(JSON.stringify(schedule), null);
    if (!normalizedSchedule || typeof normalizedSchedule !== "object") return null;

    const now = nowIso();
    const matchText = buildAutomationMatchText({
      title: normalizedTitle,
      instruction: normalizedInstruction
    });
    const result = this.db
      .prepare(
        `INSERT INTO automations(
          created_at,
          updated_at,
          guild_id,
          channel_id,
          created_by_user_id,
          created_by_name,
          title,
          instruction,
          schedule_json,
          next_run_at,
          status,
          is_running,
          running_started_at,
          last_run_at,
          last_error,
          last_result,
          match_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, NULL, NULL, NULL, NULL, ?)`
      )
      .run(
        now,
        now,
        normalizedGuildId,
        normalizedChannelId,
        normalizedCreatedBy,
        String(createdByName || "").trim().slice(0, 80) || null,
        normalizedTitle,
        normalizedInstruction,
        JSON.stringify(normalizedSchedule),
        nextRunAt ? String(nextRunAt) : null,
        matchText
      );

    const id = Number(result?.lastInsertRowid || 0);
    if (!id) return null;
    return this.getAutomationById(id, normalizedGuildId);
  }

  getAutomationById(automationId, guildId = null) {
    const id = Number(automationId);
    if (!Number.isInteger(id) || id <= 0) return null;

    if (guildId) {
      const row = this.db
        .prepare("SELECT * FROM automations WHERE id = ? AND guild_id = ? LIMIT 1")
        .get(id, String(guildId));
      return mapAutomationRow(row);
    }

    const row = this.db
      .prepare("SELECT * FROM automations WHERE id = ? LIMIT 1")
      .get(id);
    return mapAutomationRow(row);
  }

  countAutomations({ guildId, statuses = ["active", "paused"] }) {
    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId) return 0;

    const normalizedStatuses = normalizeAutomationStatusFilter(statuses);
    if (!normalizedStatuses.length) return 0;

    const placeholders = normalizedStatuses.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM automations
         WHERE guild_id = ? AND status IN (${placeholders})`
      )
      .get(normalizedGuildId, ...normalizedStatuses);
    return Number(row?.count || 0);
  }

  listAutomations({
    guildId,
    channelId = null,
    statuses = ["active", "paused"],
    query = "",
    limit = 20
  }) {
    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId) return [];

    const normalizedStatuses = normalizeAutomationStatusFilter(statuses);
    if (!normalizedStatuses.length) return [];

    const where = ["guild_id = ?"];
    const args = [normalizedGuildId];

    if (channelId) {
      where.push("channel_id = ?");
      args.push(String(channelId));
    }

    where.push(`status IN (${normalizedStatuses.map(() => "?").join(", ")})`);
    args.push(...normalizedStatuses);

    const normalizedQuery = String(query || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (normalizedQuery) {
      where.push("match_text LIKE ?");
      args.push(`%${normalizedQuery}%`);
    }

    const rows = this.db
      .prepare(
        `SELECT *
         FROM automations
         WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`
      )
      .all(...args, clamp(Math.floor(Number(limit) || 20), 1, 120));

    return rows.map((row) => mapAutomationRow(row)).filter(Boolean);
  }

  getMostRecentAutomations({
    guildId,
    channelId = null,
    statuses = ["active", "paused"],
    limit = 8
  }) {
    return this.listAutomations({
      guildId,
      channelId,
      statuses,
      query: "",
      limit
    });
  }

  findAutomationsByQuery({
    guildId,
    channelId = null,
    query = "",
    statuses = ["active", "paused"],
    limit = 8
  }) {
    return this.listAutomations({
      guildId,
      channelId,
      statuses,
      query,
      limit
    });
  }

  setAutomationStatus({
    automationId,
    guildId,
    status,
    nextRunAt = null,
    lastError = null,
    lastResult = null
  }) {
    const id = Number(automationId);
    const normalizedGuildId = String(guildId || "").trim();
    const normalizedStatus = normalizeAutomationStatus(status);
    if (!Number.isInteger(id) || id <= 0 || !normalizedGuildId || !normalizedStatus) return null;

    this.db
      .prepare(
        `UPDATE automations
         SET
           updated_at = ?,
           status = ?,
           next_run_at = ?,
           is_running = 0,
           running_started_at = NULL,
           last_error = ?,
           last_result = ?
         WHERE id = ? AND guild_id = ?`
      )
      .run(
        nowIso(),
        normalizedStatus,
        nextRunAt ? String(nextRunAt) : null,
        lastError ? String(lastError).slice(0, 500) : null,
        lastResult ? String(lastResult).slice(0, 500) : null,
        id,
        normalizedGuildId
      );

    return this.getAutomationById(id, normalizedGuildId);
  }

  claimDueAutomations({ now = nowIso(), limit = 4 }: { now?: string; limit?: number } = {}) {
    const normalizedNow = String(now || nowIso());
    const boundedLimit = clamp(Math.floor(Number(limit) || 4), 1, 40);
    const selectDueIds = this.db.prepare(
      `SELECT id
       FROM automations
       WHERE status = 'active'
         AND is_running = 0
         AND next_run_at IS NOT NULL
         AND next_run_at <= ?
       ORDER BY next_run_at ASC, id ASC
       LIMIT ?`
    );
    const claimOne = this.db.prepare(
      `UPDATE automations
       SET
         is_running = 1,
         running_started_at = ?,
         updated_at = ?
       WHERE id = ?
         AND status = 'active'
         AND is_running = 0
         AND next_run_at IS NOT NULL
         AND next_run_at <= ?`
    );
    const fetchOne = this.db.prepare("SELECT * FROM automations WHERE id = ? LIMIT 1");
    const claimTx = this.db.transaction((referenceNow, requestLimit) => {
      const dueIds = selectDueIds
        .all(referenceNow, requestLimit)
        .map((row) => Number(row?.id))
        .filter((id) => Number.isInteger(id) && id > 0);
      if (!dueIds.length) return [];

      const claimedRows = [];
      for (const id of dueIds) {
        const claim = claimOne.run(referenceNow, referenceNow, id, referenceNow);
        if (Number(claim?.changes || 0) !== 1) continue;
        const row = fetchOne.get(id);
        if (row) claimedRows.push(row);
      }
      return claimedRows;
    });

    const rows = claimTx(normalizedNow, boundedLimit);
    return rows.map((row) => mapAutomationRow(row)).filter(Boolean);
  }

  finalizeAutomationRun({
    automationId,
    guildId,
    status = "active",
    nextRunAt = null,
    lastRunAt = null,
    lastError = null,
    lastResult = null
  }: {
    automationId?: number | string;
    guildId?: string;
    status?: string;
    nextRunAt?: string | null;
    lastRunAt?: string | null;
    lastError?: string | null;
    lastResult?: string | null;
  } = {}) {
    const id = Number(automationId);
    const normalizedGuildId = String(guildId || "").trim();
    const normalizedStatus = normalizeAutomationStatus(status);
    if (!Number.isInteger(id) || id <= 0 || !normalizedGuildId || !normalizedStatus) return null;

    this.db
      .prepare(
        `UPDATE automations
         SET
           updated_at = ?,
           status = ?,
           next_run_at = ?,
           is_running = 0,
           running_started_at = NULL,
           last_run_at = ?,
           last_error = ?,
           last_result = ?
         WHERE id = ? AND guild_id = ?`
      )
      .run(
        nowIso(),
        normalizedStatus,
        nextRunAt ? String(nextRunAt) : null,
        lastRunAt ? String(lastRunAt) : null,
        lastError ? String(lastError).slice(0, 500) : null,
        lastResult ? String(lastResult).slice(0, 500) : null,
        id,
        normalizedGuildId
      );

    return this.getAutomationById(id, normalizedGuildId);
  }

  recordAutomationRun({
    automationId,
    startedAt = null,
    finishedAt = null,
    status = "ok",
    summary = "",
    error = "",
    messageId = null,
    metadata = null
  }) {
    const id = Number(automationId);
    if (!Number.isInteger(id) || id <= 0) return null;

    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO automation_runs(
          automation_id,
          created_at,
          started_at,
          finished_at,
          status,
          summary,
          error,
          message_id,
          metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        createdAt,
        startedAt ? String(startedAt) : createdAt,
        finishedAt ? String(finishedAt) : null,
        normalizeAutomationRunStatus(status),
        summary ? String(summary).slice(0, 700) : null,
        error ? String(error).slice(0, 1000) : null,
        messageId ? String(messageId) : null,
        metadata ? JSON.stringify(metadata) : null
      );
  }

  getAutomationRuns({
    automationId,
    guildId,
    limit = 20
  }: {
    automationId?: number | string;
    guildId?: string;
    limit?: number;
  } = {}) {
    const id = Number(automationId);
    const normalizedGuildId = String(guildId || "").trim();
    if (!Number.isInteger(id) || id <= 0 || !normalizedGuildId) return [];

    const rows = this.db
      .prepare(
        `SELECT runs.*
         FROM automation_runs AS runs
         JOIN automations AS jobs
           ON jobs.id = runs.automation_id
         WHERE runs.automation_id = ?
           AND jobs.guild_id = ?
         ORDER BY runs.created_at DESC
         LIMIT ?`
      )
      .all(id, normalizedGuildId, clamp(Math.floor(Number(limit) || 20), 1, 120));

    return rows.map((row) => ({
      ...row,
      metadata: safeJsonParse(row.metadata, null)
    }));
  }

  addMemoryFact(fact) {
    const guildId = String(fact.guildId || "").trim();
    if (!guildId) return false;

    const rawConfidence = Number(fact.confidence);
    const confidence = clamp(Number.isFinite(rawConfidence) ? rawConfidence : 0.5, 0, 1);
    const now = nowIso();
    const result = this.db
      .prepare(
        `INSERT INTO memory_facts(
          created_at,
          updated_at,
          guild_id,
          channel_id,
          subject,
          fact,
          fact_type,
          evidence_text,
          source_message_id,
          confidence,
          is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(guild_id, subject, fact) DO UPDATE SET
          updated_at = excluded.updated_at,
          channel_id = excluded.channel_id,
          fact_type = excluded.fact_type,
          evidence_text = excluded.evidence_text,
          source_message_id = excluded.source_message_id,
          confidence = MAX(memory_facts.confidence, excluded.confidence),
          is_active = 1`
      )
      .run(
        now,
        now,
        guildId,
        fact.channelId ? String(fact.channelId).slice(0, 120) : null,
        String(fact.subject),
        String(fact.fact).slice(0, 400),
        String(fact.factType || "general").slice(0, 40),
        fact.evidenceText ? String(fact.evidenceText).slice(0, 240) : null,
        fact.sourceMessageId ? String(fact.sourceMessageId) : null,
        confidence
      );

    return result.changes > 0;
  }

  getFactsForSubjectScoped(subject, limit = 12, scope = null) {
    const where = ["subject = ?", "is_active = 1"];
    const args = [String(subject)];
    if (scope?.guildId) {
      where.push("guild_id = ?");
      args.push(String(scope.guildId));
    }

    return this.db
      .prepare(
        `SELECT id, created_at, updated_at, guild_id, channel_id, subject, fact, fact_type, evidence_text, source_message_id, confidence
         FROM memory_facts
         WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(...args, clamp(limit, 1, 100));
  }

  getFactsForSubjects(subjects, limit = 80, scope = null) {
    const normalizedSubjects = [...new Set((subjects || []).map((value) => String(value || "").trim()).filter(Boolean))];
    if (!normalizedSubjects.length) return [];

    const placeholders = normalizedSubjects.map(() => "?").join(", ");
    const where = [`subject IN (${placeholders})`, "is_active = 1"];
    const args = [...normalizedSubjects];
    if (scope?.guildId) {
      where.push("guild_id = ?");
      args.push(String(scope.guildId));
    }

    return this.db
      .prepare(
        `SELECT id, created_at, updated_at, guild_id, channel_id, subject, fact, fact_type, evidence_text, source_message_id, confidence
         FROM memory_facts
         WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(...args, clamp(limit, 1, 500));
  }

  getFactsForScope({ guildId, limit = 120, subjectIds = null }) {
    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId) return [];

    const where = ["guild_id = ?", "is_active = 1"];
    const args = [normalizedGuildId];

    if (Array.isArray(subjectIds) && subjectIds.length) {
      const normalizedSubjects = [...new Set(subjectIds.map((value) => String(value || "").trim()).filter(Boolean))];
      if (normalizedSubjects.length) {
        where.push(`subject IN (${normalizedSubjects.map(() => "?").join(", ")})`);
        args.push(...normalizedSubjects);
      }
    }

    return this.db
      .prepare(
        `SELECT id, created_at, updated_at, guild_id, channel_id, subject, fact, fact_type, evidence_text, source_message_id, confidence
         FROM memory_facts
         WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(...args, clamp(limit, 1, 1000));
  }

  getFactsForSubjectsScoped({
    guildId,
    subjectIds = [],
    perSubjectLimit = 6,
    totalLimit = 600
  } = {}) {
    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId) return [];

    const normalizedSubjects = [
      ...new Set((subjectIds || []).map((value) => String(value || "").trim()).filter(Boolean))
    ];
    if (!normalizedSubjects.length) return [];

    const boundedPerSubjectLimit = clamp(Math.floor(Number(perSubjectLimit) || 6), 1, 24);
    const boundedTotalLimit = clamp(
      Math.floor(Number(totalLimit) || normalizedSubjects.length * boundedPerSubjectLimit * 2),
      boundedPerSubjectLimit,
      1200
    );
    const subjectPlaceholders = normalizedSubjects.map(() => "?").join(", ");

    return this.db
      .prepare(
        `SELECT
           id,
           created_at,
           updated_at,
           guild_id,
           channel_id,
           subject,
           fact,
           fact_type,
           evidence_text,
           source_message_id,
           confidence
         FROM (
           SELECT
             id,
             created_at,
             updated_at,
             guild_id,
             channel_id,
             subject,
             fact,
             fact_type,
             evidence_text,
             source_message_id,
             confidence,
             ROW_NUMBER() OVER (PARTITION BY subject ORDER BY updated_at DESC) AS row_num
           FROM memory_facts
           WHERE guild_id = ?
             AND is_active = 1
             AND subject IN (${subjectPlaceholders})
         ) AS ranked
         WHERE row_num <= ?
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(
        normalizedGuildId,
        ...normalizedSubjects,
        boundedPerSubjectLimit,
        boundedTotalLimit
      );
  }

  getMemoryFactBySubjectAndFact(guildId, subject, fact) {
    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId) return null;

    return (
      this.db
        .prepare(
          `SELECT id, created_at, updated_at, guild_id, channel_id, subject, fact, fact_type, evidence_text, source_message_id, confidence
           FROM memory_facts
           WHERE guild_id = ? AND subject = ? AND fact = ? AND is_active = 1
           LIMIT 1`
        )
        .get(normalizedGuildId, String(subject), String(fact)) || null
    );
  }

  ensureSqliteVecReady() {
    if (this.sqliteVecReady !== null) {
      return this.sqliteVecReady;
    }

    try {
      loadSqliteVec(this.db);
      this.sqliteVecReady = true;
      this.sqliteVecError = "";
    } catch (error) {
      this.sqliteVecReady = false;
      this.sqliteVecError = String(error?.message || error);
    }

    return this.sqliteVecReady;
  }

  upsertMemoryFactVectorNative({ factId, model, embedding, updatedAt = nowIso() }) {
    const factIdInt = Number(factId);
    const normalizedModel = String(model || "").slice(0, 120);
    const vector = normalizeEmbeddingVector(embedding);
    if (!Number.isInteger(factIdInt) || factIdInt <= 0) return false;
    if (!normalizedModel || !vector.length) return false;

    const result = this.db
      .prepare(
        `INSERT INTO memory_fact_vectors_native(fact_id, model, dims, embedding_blob, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(fact_id, model) DO UPDATE SET
           dims = excluded.dims,
           embedding_blob = excluded.embedding_blob,
           updated_at = excluded.updated_at`
      )
      .run(
        factIdInt,
        normalizedModel,
        vector.length,
        vectorToBlob(vector),
        String(updatedAt || nowIso())
      );

    return Number(result?.changes || 0) > 0;
  }

  getMemoryFactVectorNative(factId, model) {
    const factIdInt = Number(factId);
    const normalizedModel = String(model || "").trim();
    if (!Number.isInteger(factIdInt) || factIdInt <= 0) return null;
    if (!normalizedModel) return null;

    const row = this.db
      .prepare(
        `SELECT embedding_blob
         FROM memory_fact_vectors_native
         WHERE fact_id = ? AND model = ?
         LIMIT 1`
      )
      .get(factIdInt, normalizedModel);
    const vector = parseEmbeddingBlob(row?.embedding_blob);
    return vector.length ? vector : null;
  }

  getMemoryFactVectorNativeScores({ factIds, model, queryEmbedding }) {
    if (!this.ensureSqliteVecReady()) return [];

    const ids = [...new Set((factIds || []).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))];
    const normalizedModel = String(model || "").trim();
    const normalizedQueryEmbedding = normalizeEmbeddingVector(queryEmbedding);
    if (!ids.length || !normalizedModel || !normalizedQueryEmbedding.length) return [];

    const placeholders = ids.map(() => "?").join(", ");
    try {
      return this.db
        .prepare(
          `SELECT fact_id, (1 - vec_distance_cosine(embedding_blob, ?)) AS score
           FROM memory_fact_vectors_native
           WHERE model = ? AND dims = ? AND fact_id IN (${placeholders})`
        )
        .all(
          vectorToBlob(normalizedQueryEmbedding),
          normalizedModel,
          normalizedQueryEmbedding.length,
          ...ids
        )
        .map((row) => ({
          fact_id: Number(row.fact_id),
          score: Number(row.score)
        }))
        .filter((row) => Number.isInteger(row.fact_id) && row.fact_id > 0 && Number.isFinite(row.score));
    } catch (error) {
      this.sqliteVecReady = false;
      this.sqliteVecError = String(error?.message || error);
      return [];
    }
  }

  getMemorySubjects(limit = 80, scope = null) {
    const where = ["is_active = 1"];
    const args = [];
    if (scope?.guildId) {
      where.push("guild_id = ?");
      args.push(String(scope.guildId));
    }

    return this.db
      .prepare(
        `SELECT guild_id, subject, MAX(updated_at) AS last_seen_at, COUNT(*) AS fact_count
         FROM memory_facts
         WHERE ${where.join(" AND ")}
         GROUP BY guild_id, subject
         ORDER BY last_seen_at DESC
         LIMIT ?`
      )
      .all(...args, clamp(limit, 1, 500));
  }

  archiveOldFactsForSubject({ guildId, subject, factType = null, keep = 60 }) {
    const normalizedGuildId = String(guildId || "").trim();
    const normalizedSubject = String(subject || "").trim();
    if (!normalizedGuildId || !normalizedSubject) return 0;

    const boundedKeep = clamp(Math.floor(Number(keep) || 60), 1, 400);
    const where = ["guild_id = ?", "subject = ?", "is_active = 1"];
    const args = [normalizedGuildId, normalizedSubject];
    if (factType) {
      where.push("fact_type = ?");
      args.push(String(factType));
    }

    const rows = this.db
      .prepare(
        `SELECT id
         FROM memory_facts
         WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC
         LIMIT 1000`
      )
      .all(...args);
    if (rows.length <= boundedKeep) return 0;

    const staleIds = rows.slice(boundedKeep).map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0);
    if (!staleIds.length) return 0;

    const placeholders = staleIds.map(() => "?").join(", ");
    const result = this.db
      .prepare(`UPDATE memory_facts SET is_active = 0, updated_at = ? WHERE id IN (${placeholders})`)
      .run(nowIso(), ...staleIds);
    return Number(result?.changes || 0);
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

function normalizePerformanceMetricMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function pushPerformanceMetric(target, value) {
  const normalized = normalizePerformanceMetricMs(value);
  if (normalized === null) return;
  target.push(normalized);
}

function percentileNearestRank(sortedValues, percentile) {
  const values = Array.isArray(sortedValues) ? sortedValues : [];
  if (!values.length) return null;
  const p = clamp(Number(percentile) || 0, 0, 100);
  if (p <= 0) return values[0];
  if (p >= 100) return values[values.length - 1];
  const rank = Math.ceil((p / 100) * values.length);
  const index = clamp(rank - 1, 0, values.length - 1);
  return values[index];
}

function summarizeLatencyMetric(values) {
  const numeric = (Array.isArray(values) ? values : [])
    .map((value) => normalizePerformanceMetricMs(value))
    .filter((value) => value !== null);
  if (!numeric.length) {
    return {
      count: 0,
      minMs: null,
      p50Ms: null,
      p95Ms: null,
      avgMs: null,
      maxMs: null
    };
  }

  const sorted = [...numeric].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    count: sorted.length,
    minMs: sorted[0],
    p50Ms: percentileNearestRank(sorted, 50),
    p95Ms: percentileNearestRank(sorted, 95),
    avgMs: Number((sum / sorted.length).toFixed(1)),
    maxMs: sorted[sorted.length - 1]
  };
}
