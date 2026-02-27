import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { DEFAULT_SETTINGS } from "./defaultSettings.ts";
import { normalizeProviderOrder } from "./search.ts";
import { clamp, deepMerge, nowIso, uniqueIdList } from "./utils.ts";
import {
  buildAutomationMatchText,
  normalizeAutomationInstruction,
  normalizeAutomationTitle
} from "./automation.ts";

const SETTINGS_KEY = "runtime_settings";

export class Store {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.sqliteVecReady = null;
    this.sqliteVecError = "";
  }

  init() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");

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

      CREATE TABLE IF NOT EXISTS memory_fact_orphans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        archived_at TEXT NOT NULL,
        source_stage TEXT NOT NULL,
        legacy_fact_id INTEGER,
        guild_id TEXT,
        channel_id TEXT,
        subject TEXT NOT NULL,
        fact TEXT NOT NULL,
        fact_type TEXT NOT NULL DEFAULT 'general',
        evidence_text TEXT,
        source_message_id TEXT,
        confidence REAL NOT NULL DEFAULT 0.5,
        reason TEXT
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

      CREATE INDEX IF NOT EXISTS idx_messages_channel_time ON messages(channel_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_guild_time ON messages(guild_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_actions_kind_time ON actions(kind, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_actions_time ON actions(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_vectors_native_model_dims ON memory_fact_vectors_native(model, dims);
      CREATE INDEX IF NOT EXISTS idx_memory_orphans_stage_time ON memory_fact_orphans(source_stage, archived_at DESC);
      CREATE INDEX IF NOT EXISTS idx_shared_links_last_shared_at ON shared_links(last_shared_at DESC);
      CREATE INDEX IF NOT EXISTS idx_automations_scope_status_next ON automations(guild_id, status, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_automations_running_next ON automations(is_running, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_automations_match_text ON automations(guild_id, match_text);
      CREATE INDEX IF NOT EXISTS idx_automation_runs_job_time ON automation_runs(automation_id, created_at DESC);
    `);
    this.ensureSqliteVecReady();
    const schemaMigrationSummary = this.ensureMemoryFactsSchema();
    const legacyReconcileSummary = this.reconcileLegacyScopedFacts();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_scope_subject ON memory_facts(guild_id, subject, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_scope_channel ON memory_facts(guild_id, channel_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_scope_subject_type ON memory_facts(guild_id, subject, fact_type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_scope_active ON memory_facts(guild_id, is_active, created_at DESC);
    `);
    this.logMemoryMigrationSummary({
      schemaMigrationSummary,
      legacyReconcileSummary
    });

    if (!this.db.prepare("SELECT 1 FROM settings WHERE key = ?").get(SETTINGS_KEY)) {
      const defaultSettings = normalizeSettings(DEFAULT_SETTINGS);
      this.db
        .prepare("INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)")
        .run(SETTINGS_KEY, JSON.stringify(defaultSettings), nowIso());
    }
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

    this.db
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
        nowIso(),
        action.guildId ? String(action.guildId) : null,
        action.channelId ? String(action.channelId) : null,
        action.messageId ? String(action.messageId) : null,
        action.userId ? String(action.userId) : null,
        String(action.kind),
        action.content ? String(action.content).slice(0, 2000) : null,
        metadata,
        Number(action.usdCost) || 0
      );
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

  hasTriggeredResponse(triggerMessageId) {
    const id = String(triggerMessageId).trim();
    if (!id) return false;

    const singleTriggerNeedle = `%"triggerMessageId":"${id}"%`;
    const triggerListNeedle = `%"triggerMessageIds"%\"${id}\"%`;
    const row = this.db
      .prepare(
        `SELECT 1
         FROM actions
         WHERE kind IN ('sent_reply', 'sent_message', 'reply_skipped')
           AND (metadata LIKE ? OR metadata LIKE ?)
         LIMIT 1`
      )
      .get(singleTriggerNeedle, triggerListNeedle);

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
      dailyCost: dayCostRows
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

  claimDueAutomations({ now = nowIso(), limit = 4 } = {}) {
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

  getAutomationRuns({ automationId, guildId, limit = 20 } = {}) {
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

  ensureMemoryFactsSchema() {
    const columns = this.db
      .prepare("PRAGMA table_info(memory_facts)")
      .all()
      .map((row) => String(row.name));

    const required = new Set([
      "created_at",
      "updated_at",
      "guild_id",
      "channel_id",
      "subject",
      "fact",
      "fact_type",
      "evidence_text",
      "source_message_id",
      "confidence",
      "is_active"
    ]);
    const hasAllColumns = columns.length && [...required].every((column) => columns.includes(column));
    const hasScopedUnique = this.hasMemoryScopedUniqueConstraint();
    if (hasAllColumns && hasScopedUnique) return null;

    return this.migrateMemoryFactsTable(new Set(columns));
  }

  hasMemoryScopedUniqueConstraint() {
    const indexes = this.db.prepare("PRAGMA index_list(memory_facts)").all();
    for (const indexRow of indexes) {
      if (!indexRow?.unique) continue;
      const name = String(indexRow.name || "");
      if (!name) continue;
      const cols = this.db
        .prepare(`PRAGMA index_info(${quoteSqlIdentifier(name)})`)
        .all()
        .map((row) => String(row.name || ""));
      if (cols.join(",") === "guild_id,subject,fact") {
        return true;
      }
    }
    return false;
  }

  migrateMemoryFactsTable(columnSet) {
    const hasUpdatedAt = columnSet.has("updated_at");
    const hasGuildId = columnSet.has("guild_id");
    const hasChannelId = columnSet.has("channel_id");
    const hasFactType = columnSet.has("fact_type");
    const hasEvidenceText = columnSet.has("evidence_text");
    const hasSourceMessageId = columnSet.has("source_message_id");
    const hasConfidence = columnSet.has("confidence");
    const hasIsActive = columnSet.has("is_active");
    const now = nowIso();
    let migratedCount = 0;
    let archivedCount = 0;

    this.db.exec("BEGIN");
    try {
      this.db.exec("ALTER TABLE memory_facts RENAME TO memory_facts_legacy;");
      this.db.exec(`
        CREATE TABLE memory_facts (
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
      `);

      const updatedAtExpr = hasUpdatedAt ? "updated_at" : "created_at";
      const inferredGuildExpr = hasSourceMessageId ? buildInferredGuildExpr("memory_facts_legacy") : "NULL";
      const guildExpr = hasGuildId
        ? `COALESCE(NULLIF(memory_facts_legacy.guild_id, ''), ${inferredGuildExpr})`
        : inferredGuildExpr;
      const channelExpr = hasChannelId ? "channel_id" : "NULL";
      const factTypeExpr = hasFactType ? "COALESCE(NULLIF(fact_type, ''), 'general')" : "'general'";
      const evidenceExpr = hasEvidenceText ? "evidence_text" : "NULL";
      const sourceExpr = hasSourceMessageId ? "source_message_id" : "NULL";
      const legacyGuildExpr = hasGuildId ? "NULLIF(memory_facts_legacy.guild_id, '')" : "NULL";
      const confidenceExpr = hasConfidence ? "COALESCE(confidence, 0.5)" : "0.5";
      const activeExpr = hasIsActive ? "CASE WHEN is_active = 0 THEN 0 ELSE 1 END" : "1";
      const guildWhereExpr = `WHERE ${guildExpr} IS NOT NULL`;

      this.db
        .prepare(
          `INSERT INTO memory_fact_orphans(
            created_at,
            archived_at,
            source_stage,
            legacy_fact_id,
            guild_id,
            channel_id,
            subject,
            fact,
            fact_type,
            evidence_text,
            source_message_id,
            confidence,
            reason
          )
          SELECT
            created_at,
            ?,
            'schema_migration',
            id,
            ${legacyGuildExpr},
            ${channelExpr},
            subject,
            fact,
            ${factTypeExpr},
            ${evidenceExpr},
            ${sourceExpr},
            ${confidenceExpr},
            'missing_guild_scope'
          FROM memory_facts_legacy
          WHERE ${guildExpr} IS NULL`
        )
        .run(now);
      archivedCount += getSqlChanges(this.db);

      this.db.exec(
        `INSERT INTO memory_facts(
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
          is_active
        )
        SELECT
          id,
          created_at,
          ${updatedAtExpr},
          ${guildExpr},
          ${channelExpr},
          subject,
          fact,
          ${factTypeExpr},
          ${evidenceExpr},
          ${sourceExpr},
          ${confidenceExpr},
          ${activeExpr}
        FROM memory_facts_legacy
        ${guildWhereExpr};`
      );
      migratedCount += getSqlChanges(this.db);

      this.db.exec("DROP TABLE memory_facts_legacy;");
      this.db.exec("COMMIT");
      return {
        migratedCount,
        archivedCount
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  reconcileLegacyScopedFacts() {
    const inferredLegacyGuildExpr = buildInferredGuildExpr("legacy");
    const inferredCurrentGuildExpr = buildInferredGuildExpr("memory_facts");
    const now = nowIso();
    let archivedCount = 0;
    let reassignedCount = 0;
    let removedDuplicateCount = 0;
    let removedUnresolvedCount = 0;

    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO memory_fact_orphans(
            created_at,
            archived_at,
            source_stage,
            legacy_fact_id,
            guild_id,
            channel_id,
            subject,
            fact,
            fact_type,
            evidence_text,
            source_message_id,
            confidence,
            reason
          )
          SELECT
            legacy.created_at,
            ?,
            'legacy_reconcile',
            legacy.id,
            legacy.guild_id,
            legacy.channel_id,
            legacy.subject,
            legacy.fact,
            legacy.fact_type,
            legacy.evidence_text,
            legacy.source_message_id,
            legacy.confidence,
            'superseded_by_scoped_duplicate'
          FROM memory_facts AS legacy
          JOIN memory_facts AS scoped
            ON scoped.guild_id = ${inferredLegacyGuildExpr}
           AND scoped.subject = legacy.subject
           AND scoped.fact = legacy.fact
          WHERE legacy.guild_id = '__legacy__'
            AND ${inferredLegacyGuildExpr} IS NOT NULL`
        )
        .run(now);
      archivedCount += getSqlChanges(this.db);

      this.db.exec(`
        DELETE FROM memory_fact_vectors_native
        WHERE fact_id IN (
          SELECT legacy.id
          FROM memory_facts AS legacy
          JOIN memory_facts AS scoped
            ON scoped.guild_id = ${inferredLegacyGuildExpr}
           AND scoped.subject = legacy.subject
           AND scoped.fact = legacy.fact
          WHERE legacy.guild_id = '__legacy__'
            AND ${inferredLegacyGuildExpr} IS NOT NULL
        );
      `);
      this.db.exec(`
        DELETE FROM memory_facts
        WHERE id IN (
          SELECT legacy.id
          FROM memory_facts AS legacy
          JOIN memory_facts AS scoped
            ON scoped.guild_id = ${inferredLegacyGuildExpr}
           AND scoped.subject = legacy.subject
           AND scoped.fact = legacy.fact
          WHERE legacy.guild_id = '__legacy__'
            AND ${inferredLegacyGuildExpr} IS NOT NULL
        );
      `);
      removedDuplicateCount += getSqlChanges(this.db);

      this.db.exec(`
        UPDATE memory_facts
        SET guild_id = ${inferredCurrentGuildExpr}
        WHERE guild_id = '__legacy__'
          AND ${inferredCurrentGuildExpr} IS NOT NULL;
      `);
      reassignedCount += getSqlChanges(this.db);

      this.db
        .prepare(
          `INSERT INTO memory_fact_orphans(
            created_at,
            archived_at,
            source_stage,
            legacy_fact_id,
            guild_id,
            channel_id,
            subject,
            fact,
            fact_type,
            evidence_text,
            source_message_id,
            confidence,
            reason
          )
          SELECT
            created_at,
            ?,
            'legacy_reconcile',
            id,
            guild_id,
            channel_id,
            subject,
            fact,
            fact_type,
            evidence_text,
            source_message_id,
            confidence,
            'missing_guild_scope'
          FROM memory_facts
          WHERE guild_id = '__legacy__'`
        )
        .run(now);
      archivedCount += getSqlChanges(this.db);

      this.db.exec(`
        DELETE FROM memory_fact_vectors_native
        WHERE fact_id IN (
          SELECT id FROM memory_facts WHERE guild_id = '__legacy__'
        );
      `);
      this.db.exec("DELETE FROM memory_facts WHERE guild_id = '__legacy__';");
      removedUnresolvedCount += getSqlChanges(this.db);

      this.db.exec("COMMIT");
      return {
        archivedCount,
        reassignedCount,
        removedDuplicateCount,
        removedUnresolvedCount
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  logMemoryMigrationSummary({ schemaMigrationSummary, legacyReconcileSummary }) {
    const summary = {
      migrated: Number(schemaMigrationSummary?.migratedCount || 0),
      archived: Number(schemaMigrationSummary?.archivedCount || 0) + Number(legacyReconcileSummary?.archivedCount || 0),
      reassignedLegacy: Number(legacyReconcileSummary?.reassignedCount || 0),
      removedLegacyDuplicates: Number(legacyReconcileSummary?.removedDuplicateCount || 0),
      removedLegacyUnresolved: Number(legacyReconcileSummary?.removedUnresolvedCount || 0)
    };
    const changed = Object.values(summary).some((value) => value > 0);
    if (!changed) return;

    this.logAction({
      kind: "memory_migration",
      content: `memory migration applied: migrated=${summary.migrated}, archived=${summary.archived}, reassigned_legacy=${summary.reassignedLegacy}, removed_legacy_duplicates=${summary.removedLegacyDuplicates}, removed_legacy_unresolved=${summary.removedLegacyUnresolved}`,
      metadata: summary
    });
  }
}

function quoteSqlIdentifier(name) {
  return `"${String(name || "").replace(/"/g, "\"\"")}"`;
}

function buildInferredGuildExpr(tableAlias) {
  const sourceMessageIdRef = `${tableAlias}.source_message_id`;
  return `COALESCE(
    (SELECT NULLIF(msg.guild_id, '') FROM messages AS msg WHERE msg.message_id = ${sourceMessageIdRef} LIMIT 1),
    CASE
      WHEN ${sourceMessageIdRef} LIKE 'voice-%'
       AND instr(substr(${sourceMessageIdRef}, 7), '-') > 0
      THEN substr(${sourceMessageIdRef}, 7, instr(substr(${sourceMessageIdRef}, 7), '-') - 1)
      ELSE NULL
    END
  )`;
}

function getSqlChanges(db) {
  const row = db.prepare("SELECT changes() AS count").get();
  return Number(row?.count || 0);
}

function normalizeEmbeddingVector(rawEmbedding) {
  if (!Array.isArray(rawEmbedding) || !rawEmbedding.length) return [];
  const normalized = [];
  for (const value of rawEmbedding) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) continue;
    normalized.push(numeric);
  }
  return normalized;
}

function vectorToBlob(embedding) {
  return Buffer.from(new Float32Array(embedding).buffer);
}

function parseEmbeddingBlob(rawBlob) {
  if (!rawBlob) return [];
  let buffer = rawBlob;
  if (!Buffer.isBuffer(buffer)) {
    try {
      buffer = Buffer.from(buffer);
    } catch {
      return [];
    }
  }
  if (!buffer.length || buffer.length % 4 !== 0) return [];
  const values = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
  const out = [];
  for (const value of values) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return [];
    out.push(numeric);
  }
  return out;
}

function normalizeAutomationStatus(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "active") return "active";
  if (normalized === "paused") return "paused";
  if (normalized === "deleted") return "deleted";
  return "";
}

function normalizeAutomationRunStatus(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "ok") return "ok";
  if (normalized === "error") return "error";
  if (normalized === "skipped") return "skipped";
  return "ok";
}

function normalizeAutomationStatusFilter(statuses) {
  const list = Array.isArray(statuses) ? statuses : [statuses];
  const raw = list
    .map((status) => String(status || "").trim().toLowerCase())
    .filter(Boolean);
  if (raw.includes("all")) {
    return ["active", "paused", "deleted"];
  }
  return [
    ...new Set(
      raw
        .map((status) => normalizeAutomationStatus(status))
        .filter(Boolean)
    )
  ];
}

function mapAutomationRow(row) {
  if (!row) return null;
  const schedule = safeJsonParse(row.schedule_json, null);
  if (!schedule || typeof schedule !== "object") return null;

  return {
    id: Number(row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
    guild_id: row.guild_id,
    channel_id: row.channel_id,
    created_by_user_id: row.created_by_user_id,
    created_by_name: row.created_by_name || null,
    title: row.title,
    instruction: row.instruction,
    schedule,
    next_run_at: row.next_run_at || null,
    status: row.status,
    is_running: Number(row.is_running || 0) === 1,
    running_started_at: row.running_started_at || null,
    last_run_at: row.last_run_at || null,
    last_error: row.last_error || null,
    last_result: row.last_result || null,
    match_text: row.match_text || ""
  };
}

function safeJsonParse(value, fallback) {
  if (!value || typeof value !== "string") return fallback;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeMessageCreatedAt(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : nowIso();
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric).toISOString();
  }

  const text = String(value || "").trim();
  if (text) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  return nowIso();
}

function normalizeSettings(raw) {
  const merged = deepMerge(DEFAULT_SETTINGS, raw ?? {});
  if (!merged.persona || typeof merged.persona !== "object") merged.persona = {};
  if (!merged.activity || typeof merged.activity !== "object") merged.activity = {};
  if (!merged.startup || typeof merged.startup !== "object") merged.startup = {};
  if (!merged.permissions || typeof merged.permissions !== "object") merged.permissions = {};
  if (!merged.initiative || typeof merged.initiative !== "object") merged.initiative = {};
  if (!merged.memory || typeof merged.memory !== "object") merged.memory = {};
  if (!merged.llm || typeof merged.llm !== "object") merged.llm = {};
  if (!merged.replyFollowupLlm || typeof merged.replyFollowupLlm !== "object") merged.replyFollowupLlm = {};
  if (merged.memoryLlm && typeof merged.memoryLlm === "object") {
    merged.memoryLlm.provider = normalizeLlmProvider(merged.memoryLlm?.provider);
    merged.memoryLlm.model = String(merged.memoryLlm?.model || "claude-haiku-4-5").slice(0, 120);
  }
  if (!merged.webSearch || typeof merged.webSearch !== "object") merged.webSearch = {};
  if (!merged.videoContext || typeof merged.videoContext !== "object") merged.videoContext = {};
  if (!merged.voice || typeof merged.voice !== "object") merged.voice = {};

  merged.botName = String(merged.botName || "clanker conk").slice(0, 50);
  merged.persona.flavor = String(merged.persona?.flavor || DEFAULT_SETTINGS.persona.flavor).slice(0, 240);
  merged.persona.hardLimits = normalizeHardLimitList(
    merged.persona?.hardLimits,
    DEFAULT_SETTINGS.persona?.hardLimits ?? []
  );

  const replyLevelInitiative = clamp(
    Number(merged.activity?.replyLevelInitiative ?? DEFAULT_SETTINGS.activity.replyLevelInitiative) || 0,
    0,
    100
  );
  const replyLevelNonInitiative = clamp(
    Number(merged.activity?.replyLevelNonInitiative ?? DEFAULT_SETTINGS.activity.replyLevelNonInitiative) || 0,
    0,
    100
  );
  const reactionLevel = clamp(
    Number(merged.activity?.reactionLevel ?? DEFAULT_SETTINGS.activity.reactionLevel) || 0,
    0,
    100
  );
  const minSecondsBetweenMessages = clamp(
    Number(merged.activity?.minSecondsBetweenMessages) || 15,
    5,
    300
  );
  const replyCoalesceWindowSecondsRaw = Number(merged.activity?.replyCoalesceWindowSeconds);
  const replyCoalesceMaxMessagesRaw = Number(merged.activity?.replyCoalesceMaxMessages);
  const replyCoalesceWindowSeconds = clamp(
    Number.isFinite(replyCoalesceWindowSecondsRaw)
      ? replyCoalesceWindowSecondsRaw
      : Number(DEFAULT_SETTINGS.activity?.replyCoalesceWindowSeconds) || 4,
    0,
    20
  );
  const replyCoalesceMaxMessages = clamp(
    Number.isFinite(replyCoalesceMaxMessagesRaw)
      ? replyCoalesceMaxMessagesRaw
      : Number(DEFAULT_SETTINGS.activity?.replyCoalesceMaxMessages) || 6,
    1,
    20
  );
  merged.activity = {
    replyLevelInitiative,
    replyLevelNonInitiative,
    reactionLevel,
    minSecondsBetweenMessages,
    replyCoalesceWindowSeconds,
    replyCoalesceMaxMessages
  };

  merged.llm.provider = normalizeLlmProvider(merged.llm?.provider);
  merged.llm.model = String(merged.llm?.model || "gpt-4.1-mini").slice(0, 120);
  merged.llm.temperature = clamp(Number(merged.llm?.temperature) || 0.9, 0, 2);
  merged.llm.maxOutputTokens = clamp(Number(merged.llm?.maxOutputTokens) || 220, 32, 1400);
  merged.replyFollowupLlm.enabled =
    merged.replyFollowupLlm?.enabled !== undefined
      ? Boolean(merged.replyFollowupLlm?.enabled)
      : Boolean(DEFAULT_SETTINGS.replyFollowupLlm?.enabled);
  merged.replyFollowupLlm.provider = normalizeLlmProvider(
    String(merged.replyFollowupLlm?.provider || "").trim() ||
      merged.llm.provider ||
      "openai"
  );
  merged.replyFollowupLlm.model = String(
    merged.replyFollowupLlm?.model ||
      merged.llm.model ||
      defaultModelForLlmProvider(merged.replyFollowupLlm.provider)
  )
    .trim()
    .slice(0, 120);
  if (!merged.replyFollowupLlm.model) {
    merged.replyFollowupLlm.model = defaultModelForLlmProvider(merged.replyFollowupLlm.provider);
  }

  merged.webSearch.enabled = Boolean(merged.webSearch?.enabled);
  const maxSearchesRaw = Number(merged.webSearch?.maxSearchesPerHour);
  const maxResultsRaw = Number(merged.webSearch?.maxResults);
  const maxPagesRaw = Number(merged.webSearch?.maxPagesToRead);
  const maxCharsRaw = Number(merged.webSearch?.maxCharsPerPage);
  const recencyDaysRaw = Number(merged.webSearch?.recencyDaysDefault);
  const maxConcurrentFetchesRaw = Number(merged.webSearch?.maxConcurrentFetches);
  merged.webSearch.maxSearchesPerHour = clamp(
    Number.isFinite(maxSearchesRaw)
      ? maxSearchesRaw
      : Number(DEFAULT_SETTINGS.webSearch?.maxSearchesPerHour) || 20,
    1,
    120
  );
  merged.webSearch.maxResults = clamp(Number.isFinite(maxResultsRaw) ? maxResultsRaw : 5, 1, 10);
  merged.webSearch.maxPagesToRead = clamp(Number.isFinite(maxPagesRaw) ? maxPagesRaw : 3, 0, 5);
  merged.webSearch.maxCharsPerPage = clamp(Number.isFinite(maxCharsRaw) ? maxCharsRaw : 1400, 350, 4000);
  merged.webSearch.safeSearch =
    merged.webSearch?.safeSearch !== undefined ? Boolean(merged.webSearch?.safeSearch) : true;
  merged.webSearch.providerOrder = normalizeProviderOrder(merged.webSearch?.providerOrder);
  merged.webSearch.recencyDaysDefault = clamp(Number.isFinite(recencyDaysRaw) ? recencyDaysRaw : 30, 1, 365);
  merged.webSearch.maxConcurrentFetches = clamp(
    Number.isFinite(maxConcurrentFetchesRaw) ? maxConcurrentFetchesRaw : 5,
    1,
    10
  );

  merged.videoContext.enabled =
    merged.videoContext?.enabled !== undefined
      ? Boolean(merged.videoContext?.enabled)
      : Boolean(DEFAULT_SETTINGS.videoContext?.enabled);
  const videoPerHourRaw = Number(merged.videoContext?.maxLookupsPerHour);
  const videoPerMessageRaw = Number(merged.videoContext?.maxVideosPerMessage);
  const transcriptCharsRaw = Number(merged.videoContext?.maxTranscriptChars);
  const keyframeIntervalRaw = Number(merged.videoContext?.keyframeIntervalSeconds);
  const keyframeCountRaw = Number(merged.videoContext?.maxKeyframesPerVideo);
  const maxAsrSecondsRaw = Number(merged.videoContext?.maxAsrSeconds);
  merged.videoContext.maxLookupsPerHour = clamp(
    Number.isFinite(videoPerHourRaw) ? videoPerHourRaw : Number(DEFAULT_SETTINGS.videoContext?.maxLookupsPerHour) || 12,
    0,
    120
  );
  merged.videoContext.maxVideosPerMessage = clamp(
    Number.isFinite(videoPerMessageRaw)
      ? videoPerMessageRaw
      : Number(DEFAULT_SETTINGS.videoContext?.maxVideosPerMessage) || 2,
    0,
    6
  );
  merged.videoContext.maxTranscriptChars = clamp(
    Number.isFinite(transcriptCharsRaw)
      ? transcriptCharsRaw
      : Number(DEFAULT_SETTINGS.videoContext?.maxTranscriptChars) || 1200,
    200,
    4000
  );
  merged.videoContext.keyframeIntervalSeconds = clamp(
    Number.isFinite(keyframeIntervalRaw)
      ? keyframeIntervalRaw
      : Number(DEFAULT_SETTINGS.videoContext?.keyframeIntervalSeconds) || 8,
    0,
    120
  );
  merged.videoContext.maxKeyframesPerVideo = clamp(
    Number.isFinite(keyframeCountRaw)
      ? keyframeCountRaw
      : Number(DEFAULT_SETTINGS.videoContext?.maxKeyframesPerVideo) || 3,
    0,
    8
  );
  merged.videoContext.allowAsrFallback = Boolean(merged.videoContext?.allowAsrFallback);
  merged.videoContext.maxAsrSeconds = clamp(
    Number.isFinite(maxAsrSecondsRaw) ? maxAsrSecondsRaw : Number(DEFAULT_SETTINGS.videoContext?.maxAsrSeconds) || 120,
    15,
    600
  );

  if (!merged.voice.xai || typeof merged.voice.xai !== "object") {
    merged.voice.xai = {};
  }
  if (!merged.voice.openaiRealtime || typeof merged.voice.openaiRealtime !== "object") {
    merged.voice.openaiRealtime = {};
  }
  if (!merged.voice.geminiRealtime || typeof merged.voice.geminiRealtime !== "object") {
    merged.voice.geminiRealtime = {};
  }
  if (!merged.voice.sttPipeline || typeof merged.voice.sttPipeline !== "object") {
    merged.voice.sttPipeline = {};
  }
  if (!merged.voice.replyDecisionLlm || typeof merged.voice.replyDecisionLlm !== "object") {
    merged.voice.replyDecisionLlm = {};
  }
  if (!merged.voice.streamWatch || typeof merged.voice.streamWatch !== "object") {
    merged.voice.streamWatch = {};
  }
  if (!merged.voice.soundboard || typeof merged.voice.soundboard !== "object") {
    merged.voice.soundboard = {};
  }

  const defaultVoice = DEFAULT_SETTINGS.voice || {};
  const defaultVoiceXai = defaultVoice.xai || {};
  const defaultVoiceOpenAiRealtime = defaultVoice.openaiRealtime || {};
  const defaultVoiceGeminiRealtime = defaultVoice.geminiRealtime || {};
  const defaultVoiceSttPipeline = defaultVoice.sttPipeline || {};
  const defaultVoiceReplyDecisionLlm = defaultVoice.replyDecisionLlm || {};
  const defaultVoiceStreamWatch = defaultVoice.streamWatch || {};
  const defaultVoiceSoundboard = defaultVoice.soundboard || {};
  const voiceIntentThresholdRaw = Number(merged.voice?.intentConfidenceThreshold);
  const voiceMaxSessionRaw = Number(merged.voice?.maxSessionMinutes);
  const voiceInactivityRaw = Number(merged.voice?.inactivityLeaveSeconds);
  const voiceDailySessionsRaw = Number(merged.voice?.maxSessionsPerDay);
  const voiceConcurrentSessionsRaw = Number(merged.voice?.maxConcurrentSessions);
  const voiceSampleRateRaw = Number(merged.voice?.xai?.sampleRateHz);
  const openAiRealtimeInputSampleRateRaw = Number(merged.voice?.openaiRealtime?.inputSampleRateHz);
  const openAiRealtimeOutputSampleRateRaw = Number(merged.voice?.openaiRealtime?.outputSampleRateHz);
  const geminiRealtimeInputSampleRateRaw = Number(merged.voice?.geminiRealtime?.inputSampleRateHz);
  const geminiRealtimeOutputSampleRateRaw = Number(merged.voice?.geminiRealtime?.outputSampleRateHz);
  const voiceSttTtsSpeedRaw = Number(merged.voice?.sttPipeline?.ttsSpeed);
  const streamWatchCommentaryIntervalRaw = Number(merged.voice?.streamWatch?.minCommentaryIntervalSeconds);
  const streamWatchMaxFramesPerMinuteRaw = Number(merged.voice?.streamWatch?.maxFramesPerMinute);
  const streamWatchMaxFrameBytesRaw = Number(merged.voice?.streamWatch?.maxFrameBytes);

  merged.voice.enabled =
    merged.voice?.enabled !== undefined ? Boolean(merged.voice?.enabled) : Boolean(defaultVoice.enabled);
  merged.voice.mode = normalizeVoiceMode(merged.voice?.mode, defaultVoice.mode);
  merged.voice.allowNsfwHumor =
    merged.voice?.allowNsfwHumor !== undefined
      ? Boolean(merged.voice?.allowNsfwHumor)
      : Boolean(defaultVoice.allowNsfwHumor);
  delete merged.voice.joinOnTextNL;
  delete merged.voice.requireDirectMentionForJoin;
  merged.voice.intentConfidenceThreshold = clamp(
    Number.isFinite(voiceIntentThresholdRaw)
      ? voiceIntentThresholdRaw
      : Number(defaultVoice.intentConfidenceThreshold) || 0.75,
    0.4,
    0.99
  );
  merged.voice.maxSessionMinutes = clamp(
    Number.isFinite(voiceMaxSessionRaw) ? voiceMaxSessionRaw : Number(defaultVoice.maxSessionMinutes) || 10,
    1,
    120
  );
  merged.voice.inactivityLeaveSeconds = clamp(
    Number.isFinite(voiceInactivityRaw) ? voiceInactivityRaw : Number(defaultVoice.inactivityLeaveSeconds) || 90,
    20,
    3600
  );
  merged.voice.maxSessionsPerDay = clamp(
    Number.isFinite(voiceDailySessionsRaw) ? voiceDailySessionsRaw : Number(defaultVoice.maxSessionsPerDay) || 12,
    0,
    120
  );
  merged.voice.maxConcurrentSessions = clamp(
    Number.isFinite(voiceConcurrentSessionsRaw)
      ? voiceConcurrentSessionsRaw
      : Number(defaultVoice.maxConcurrentSessions) || 1,
    1,
    3
  );
  merged.voice.allowedVoiceChannelIds = uniqueIdList(merged.voice?.allowedVoiceChannelIds);
  merged.voice.blockedVoiceChannelIds = uniqueIdList(merged.voice?.blockedVoiceChannelIds);
  merged.voice.blockedVoiceUserIds = uniqueIdList(merged.voice?.blockedVoiceUserIds);

  const voiceEagernessRaw = Number(merged.voice?.replyEagerness);
  merged.voice.replyEagerness = clamp(
    Number.isFinite(voiceEagernessRaw) ? voiceEagernessRaw : 0, 0, 100
  );
  delete merged.voice.eagerCooldownSeconds;
  merged.voice.replyDecisionLlm.provider = normalizeLlmProvider(
    merged.voice?.replyDecisionLlm?.provider || defaultVoiceReplyDecisionLlm.provider || "anthropic"
  );
  const replyDecisionModelFallback = String(
    defaultVoiceReplyDecisionLlm.model || defaultModelForLlmProvider(merged.voice.replyDecisionLlm.provider)
  )
    .trim()
    .slice(0, 120);
  merged.voice.replyDecisionLlm.model = String(
    merged.voice?.replyDecisionLlm?.model ||
      replyDecisionModelFallback ||
      defaultModelForLlmProvider(merged.voice.replyDecisionLlm.provider)
  )
    .trim()
    .slice(0, 120);
  if (!merged.voice.replyDecisionLlm.model) {
    merged.voice.replyDecisionLlm.model = defaultModelForLlmProvider(merged.voice.replyDecisionLlm.provider);
  }
  const replyDecisionMaxAttemptsRaw = Number(merged.voice?.replyDecisionLlm?.maxAttempts);
  const defaultReplyDecisionMaxAttemptsRaw = Number(defaultVoiceReplyDecisionLlm.maxAttempts);
  merged.voice.replyDecisionLlm.maxAttempts = clamp(
    Number.isFinite(replyDecisionMaxAttemptsRaw)
      ? replyDecisionMaxAttemptsRaw
      : Number.isFinite(defaultReplyDecisionMaxAttemptsRaw)
        ? defaultReplyDecisionMaxAttemptsRaw
        : 1,
    1,
    3
  );

  merged.voice.xai.voice = String(merged.voice?.xai?.voice || defaultVoiceXai.voice || "Rex").slice(0, 60);
  merged.voice.xai.audioFormat = String(merged.voice?.xai?.audioFormat || defaultVoiceXai.audioFormat || "audio/pcm")
    .trim()
    .slice(0, 40);
  merged.voice.xai.sampleRateHz = clamp(
    Number.isFinite(voiceSampleRateRaw) ? voiceSampleRateRaw : Number(defaultVoiceXai.sampleRateHz) || 24000,
    8000,
    48000
  );
  merged.voice.xai.region = String(merged.voice?.xai?.region || defaultVoiceXai.region || "us-east-1")
    .trim()
    .slice(0, 40);
  merged.voice.openaiRealtime.model = String(
    merged.voice?.openaiRealtime?.model || defaultVoiceOpenAiRealtime.model || "gpt-realtime"
  )
    .trim()
    .slice(0, 120);
  merged.voice.openaiRealtime.voice = String(
    merged.voice?.openaiRealtime?.voice || defaultVoiceOpenAiRealtime.voice || "alloy"
  )
    .trim()
    .slice(0, 60);
  merged.voice.openaiRealtime.inputAudioFormat = normalizeOpenAiRealtimeAudioFormat(
    merged.voice?.openaiRealtime?.inputAudioFormat || defaultVoiceOpenAiRealtime.inputAudioFormat || "pcm16"
  );
  merged.voice.openaiRealtime.outputAudioFormat = normalizeOpenAiRealtimeAudioFormat(
    merged.voice?.openaiRealtime?.outputAudioFormat || defaultVoiceOpenAiRealtime.outputAudioFormat || "pcm16"
  );
  merged.voice.openaiRealtime.inputSampleRateHz = clamp(
    Number.isFinite(openAiRealtimeInputSampleRateRaw)
      ? openAiRealtimeInputSampleRateRaw
      : Number(defaultVoiceOpenAiRealtime.inputSampleRateHz) || 24000,
    8000,
    48000
  );
  merged.voice.openaiRealtime.outputSampleRateHz = clamp(
    Number.isFinite(openAiRealtimeOutputSampleRateRaw)
      ? openAiRealtimeOutputSampleRateRaw
      : Number(defaultVoiceOpenAiRealtime.outputSampleRateHz) || 24000,
    8000,
    48000
  );
  merged.voice.openaiRealtime.inputTranscriptionModel = String(
    merged.voice?.openaiRealtime?.inputTranscriptionModel ||
      defaultVoiceOpenAiRealtime.inputTranscriptionModel ||
      "gpt-4o-mini-transcribe"
  )
    .trim()
    .slice(0, 120);
  delete merged.voice.openaiRealtime.allowNsfwHumor;
  merged.voice.geminiRealtime.model = String(
    merged.voice?.geminiRealtime?.model || defaultVoiceGeminiRealtime.model || "gemini-2.5-flash-native-audio-preview-12-2025"
  )
    .trim()
    .slice(0, 140);
  merged.voice.geminiRealtime.voice = String(
    merged.voice?.geminiRealtime?.voice || defaultVoiceGeminiRealtime.voice || "Aoede"
  )
    .trim()
    .slice(0, 60);
  merged.voice.geminiRealtime.apiBaseUrl = normalizeHttpBaseUrl(
    merged.voice?.geminiRealtime?.apiBaseUrl,
    defaultVoiceGeminiRealtime.apiBaseUrl || "https://generativelanguage.googleapis.com"
  );
  merged.voice.geminiRealtime.inputSampleRateHz = clamp(
    Number.isFinite(geminiRealtimeInputSampleRateRaw)
      ? geminiRealtimeInputSampleRateRaw
      : Number(defaultVoiceGeminiRealtime.inputSampleRateHz) || 16000,
    8000,
    48000
  );
  merged.voice.geminiRealtime.outputSampleRateHz = clamp(
    Number.isFinite(geminiRealtimeOutputSampleRateRaw)
      ? geminiRealtimeOutputSampleRateRaw
      : Number(defaultVoiceGeminiRealtime.outputSampleRateHz) || 24000,
    8000,
    48000
  );
  delete merged.voice.geminiRealtime.allowNsfwHumor;
  merged.voice.sttPipeline.transcriptionModel = String(
    merged.voice?.sttPipeline?.transcriptionModel || defaultVoiceSttPipeline.transcriptionModel || "gpt-4o-mini-transcribe"
  )
    .trim()
    .slice(0, 120);
  merged.voice.sttPipeline.ttsModel = String(
    merged.voice?.sttPipeline?.ttsModel || defaultVoiceSttPipeline.ttsModel || "gpt-4o-mini-tts"
  )
    .trim()
    .slice(0, 120);
  merged.voice.sttPipeline.ttsVoice = String(
    merged.voice?.sttPipeline?.ttsVoice || defaultVoiceSttPipeline.ttsVoice || "alloy"
  )
    .trim()
    .slice(0, 60);
  merged.voice.sttPipeline.ttsSpeed = clamp(
    Number.isFinite(voiceSttTtsSpeedRaw)
      ? voiceSttTtsSpeedRaw
      : Number(defaultVoiceSttPipeline.ttsSpeed) || 1,
    0.25,
    2
  );
  merged.voice.streamWatch.enabled =
    merged.voice?.streamWatch?.enabled !== undefined
      ? Boolean(merged.voice?.streamWatch?.enabled)
      : Boolean(defaultVoiceStreamWatch.enabled);
  merged.voice.streamWatch.minCommentaryIntervalSeconds = clamp(
    Number.isFinite(streamWatchCommentaryIntervalRaw)
      ? streamWatchCommentaryIntervalRaw
      : Number(defaultVoiceStreamWatch.minCommentaryIntervalSeconds) || 8,
    3,
    120
  );
  merged.voice.streamWatch.maxFramesPerMinute = clamp(
    Number.isFinite(streamWatchMaxFramesPerMinuteRaw)
      ? streamWatchMaxFramesPerMinuteRaw
      : Number(defaultVoiceStreamWatch.maxFramesPerMinute) || 180,
    6,
    600
  );
  merged.voice.streamWatch.maxFrameBytes = clamp(
    Number.isFinite(streamWatchMaxFrameBytesRaw)
      ? streamWatchMaxFrameBytesRaw
      : Number(defaultVoiceStreamWatch.maxFrameBytes) || 350000,
    50_000,
    4_000_000
  );

  merged.voice.soundboard.enabled =
    merged.voice?.soundboard?.enabled !== undefined
      ? Boolean(merged.voice?.soundboard?.enabled)
      : Boolean(defaultVoiceSoundboard.enabled);
  merged.voice.soundboard.allowExternalSounds =
    merged.voice?.soundboard?.allowExternalSounds !== undefined
      ? Boolean(merged.voice?.soundboard?.allowExternalSounds)
      : Boolean(defaultVoiceSoundboard.allowExternalSounds);
  merged.voice.soundboard.preferredSoundIds = uniqueIdList(merged.voice?.soundboard?.preferredSoundIds).slice(0, 40);
  delete merged.voice.soundboard.mappings;

  merged.startup.catchupEnabled =
    merged.startup?.catchupEnabled !== undefined ? Boolean(merged.startup?.catchupEnabled) : true;
  const catchupLookbackHoursRaw = Number(merged.startup?.catchupLookbackHours);
  merged.startup.catchupLookbackHours = clamp(
    Number.isFinite(catchupLookbackHoursRaw) ? catchupLookbackHoursRaw : 6,
    1,
    24
  );
  merged.startup.catchupMaxMessagesPerChannel = clamp(
    Number(merged.startup?.catchupMaxMessagesPerChannel) || 20,
    5,
    80
  );
  merged.startup.maxCatchupRepliesPerChannel = clamp(
    Number(merged.startup?.maxCatchupRepliesPerChannel) || 2,
    1,
    12
  );

  merged.permissions.allowReplies = Boolean(merged.permissions?.allowReplies);
  merged.permissions.allowInitiativeReplies =
    merged.permissions?.allowInitiativeReplies !== undefined
      ? Boolean(merged.permissions?.allowInitiativeReplies)
      : true;
  merged.permissions.allowReactions = Boolean(merged.permissions?.allowReactions);
  merged.permissions.initiativeChannelIds = uniqueIdList(merged.permissions?.initiativeChannelIds);
  merged.permissions.allowedChannelIds = uniqueIdList(merged.permissions?.allowedChannelIds);
  merged.permissions.blockedChannelIds = uniqueIdList(merged.permissions?.blockedChannelIds);
  merged.permissions.blockedUserIds = uniqueIdList(merged.permissions?.blockedUserIds);
  merged.permissions.maxMessagesPerHour = clamp(
    Number(merged.permissions?.maxMessagesPerHour) || 20,
    1,
    200
  );
  merged.permissions.maxReactionsPerHour = clamp(Number(merged.permissions?.maxReactionsPerHour) || 24, 1, 300);

  merged.initiative.enabled =
    merged.initiative?.enabled !== undefined ? Boolean(merged.initiative?.enabled) : false;
  merged.initiative.maxPostsPerDay = clamp(Number(merged.initiative?.maxPostsPerDay) || 0, 0, 100);
  merged.initiative.minMinutesBetweenPosts = clamp(
    Number(merged.initiative?.minMinutesBetweenPosts) || 120,
    5,
    24 * 60
  );
  merged.initiative.pacingMode =
    String(merged.initiative?.pacingMode || "even").toLowerCase() === "spontaneous"
      ? "spontaneous"
      : "even";
  merged.initiative.spontaneity = clamp(Number(merged.initiative?.spontaneity) || 65, 0, 100);
  merged.initiative.postOnStartup = Boolean(merged.initiative?.postOnStartup);
  merged.initiative.allowImagePosts = Boolean(merged.initiative?.allowImagePosts);
  merged.initiative.allowVideoPosts = Boolean(merged.initiative?.allowVideoPosts);
  merged.initiative.allowReplyImages = Boolean(merged.initiative?.allowReplyImages);
  merged.initiative.allowReplyVideos = Boolean(merged.initiative?.allowReplyVideos);
  merged.initiative.allowReplyGifs = Boolean(merged.initiative?.allowReplyGifs);
  merged.initiative.maxImagesPerDay = clamp(Number(merged.initiative?.maxImagesPerDay) || 0, 0, 200);
  merged.initiative.maxVideosPerDay = clamp(Number(merged.initiative?.maxVideosPerDay) || 0, 0, 120);
  merged.initiative.maxGifsPerDay = clamp(Number(merged.initiative?.maxGifsPerDay) || 0, 0, 300);
  merged.initiative.simpleImageModel = String(
    merged.initiative?.simpleImageModel || "gpt-image-1.5"
  ).slice(0, 120);
  merged.initiative.complexImageModel = String(
    merged.initiative?.complexImageModel || "grok-imagine-image"
  ).slice(0, 120);
  merged.initiative.videoModel = String(merged.initiative?.videoModel || "grok-imagine-video").slice(0, 120);
  merged.initiative.allowedImageModels = uniqueStringList(
    merged.initiative?.allowedImageModels ?? DEFAULT_SETTINGS.initiative?.allowedImageModels ?? [],
    12,
    120
  );
  merged.initiative.allowedVideoModels = uniqueStringList(
    merged.initiative?.allowedVideoModels ?? DEFAULT_SETTINGS.initiative?.allowedVideoModels ?? [],
    8,
    120
  );
  if (!merged.initiative.discovery || typeof merged.initiative.discovery !== "object") {
    merged.initiative.discovery = {};
  }
  if (!merged.initiative.discovery.sources || typeof merged.initiative.discovery.sources !== "object") {
    merged.initiative.discovery.sources = {};
  }

  const defaultDiscovery = DEFAULT_SETTINGS.initiative?.discovery ?? {};
  const defaultSources = defaultDiscovery.sources ?? {};
  const sourceConfig = merged.initiative.discovery.sources ?? {};
  merged.initiative.discovery = {
    enabled:
      merged.initiative.discovery?.enabled !== undefined
        ? Boolean(merged.initiative.discovery?.enabled)
        : Boolean(defaultDiscovery.enabled),
    linkChancePercent: clamp(
      Number(merged.initiative.discovery?.linkChancePercent) || Number(defaultDiscovery.linkChancePercent) || 0,
      0,
      100
    ),
    maxLinksPerPost: clamp(
      Number(merged.initiative.discovery?.maxLinksPerPost) || Number(defaultDiscovery.maxLinksPerPost) || 2,
      1,
      4
    ),
    maxCandidatesForPrompt: clamp(
      Number(merged.initiative.discovery?.maxCandidatesForPrompt) ||
        Number(defaultDiscovery.maxCandidatesForPrompt) ||
        6,
      1,
      12
    ),
    freshnessHours: clamp(
      Number(merged.initiative.discovery?.freshnessHours) || Number(defaultDiscovery.freshnessHours) || 96,
      1,
      24 * 14
    ),
    dedupeHours: clamp(
      Number(merged.initiative.discovery?.dedupeHours) || Number(defaultDiscovery.dedupeHours) || 168,
      1,
      24 * 45
    ),
    randomness: clamp(
      Number(merged.initiative.discovery?.randomness) || Number(defaultDiscovery.randomness) || 55,
      0,
      100
    ),
    sourceFetchLimit: clamp(
      Number(merged.initiative.discovery?.sourceFetchLimit) || Number(defaultDiscovery.sourceFetchLimit) || 10,
      2,
      30
    ),
    allowNsfw: Boolean(merged.initiative.discovery?.allowNsfw),
    preferredTopics: uniqueStringList(
      merged.initiative.discovery?.preferredTopics,
      Number(defaultDiscovery.preferredTopics?.length ? defaultDiscovery.preferredTopics.length : 12),
      80
    ),
    redditSubreddits: uniqueStringList(
      merged.initiative.discovery?.redditSubreddits,
      20,
      40
    ).map((entry) => entry.replace(/^r\//i, "")),
    youtubeChannelIds: uniqueStringList(merged.initiative.discovery?.youtubeChannelIds, 20, 80),
    rssFeeds: uniqueStringList(merged.initiative.discovery?.rssFeeds, 30, 240).filter(isHttpLikeUrl),
    xHandles: uniqueStringList(merged.initiative.discovery?.xHandles, 20, 40).map((entry) =>
      entry.replace(/^@/, "")
    ),
    xNitterBaseUrl: normalizeHttpBaseUrl(
      merged.initiative.discovery?.xNitterBaseUrl,
      defaultDiscovery.xNitterBaseUrl || "https://nitter.net"
    ),
    sources: {
      reddit:
        sourceConfig.reddit !== undefined
          ? Boolean(sourceConfig.reddit)
          : Boolean(defaultSources.reddit ?? true),
      hackerNews:
        sourceConfig.hackerNews !== undefined
          ? Boolean(sourceConfig.hackerNews)
          : Boolean(defaultSources.hackerNews ?? true),
      youtube:
        sourceConfig.youtube !== undefined
          ? Boolean(sourceConfig.youtube)
          : Boolean(defaultSources.youtube ?? true),
      rss:
        sourceConfig.rss !== undefined
          ? Boolean(sourceConfig.rss)
          : Boolean(defaultSources.rss ?? true),
      x:
        sourceConfig.x !== undefined
          ? Boolean(sourceConfig.x)
          : Boolean(defaultSources.x ?? false)
    }
  };

  merged.memory.enabled = Boolean(merged.memory?.enabled);
  merged.memory.maxRecentMessages = clamp(Number(merged.memory?.maxRecentMessages) || 35, 10, 120);
  merged.memory.embeddingModel = String(merged.memory?.embeddingModel || "text-embedding-3-small").slice(0, 120);

  return merged;
}

function uniqueStringList(input, maxItems = 20, maxLen = 120) {
  if (Array.isArray(input)) {
    return [...new Set(input.map((item) => String(item || "").trim()).filter(Boolean))]
      .slice(0, Math.max(1, maxItems))
      .map((item) => item.slice(0, maxLen));
  }

  if (typeof input !== "string") return [];

  return [...new Set(input.split(/[\n,]/g).map((item) => item.trim()).filter(Boolean))]
    .slice(0, Math.max(1, maxItems))
    .map((item) => item.slice(0, maxLen));
}

function isHttpLikeUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return false;

  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeHttpBaseUrl(value, fallback) {
  const target = String(value || fallback || "").trim();

  try {
    const parsed = new URL(target);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return String(fallback || "https://nitter.net");
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return String(fallback || "https://nitter.net");
  }
}

function normalizeLlmProvider(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "anthropic") return "anthropic";
  if (normalized === "xai") return "xai";
  if (normalized === "claude-code") return "claude-code";
  return "openai";
}

function defaultModelForLlmProvider(provider) {
  if (provider === "anthropic") return "claude-haiku-4-5";
  if (provider === "xai") return "grok-3-mini-latest";
  if (provider === "claude-code") return "sonnet";
  return "gpt-4.1-mini";
}

function normalizeVoiceMode(value, fallback = "voice_agent") {
  const normalized = String(value || fallback || "")
    .trim()
    .toLowerCase();
  if (normalized === "gemini_realtime") return "gemini_realtime";
  if (normalized === "openai_realtime") return "openai_realtime";
  if (normalized === "stt_pipeline") return "stt_pipeline";
  return "voice_agent";
}

function normalizeOpenAiRealtimeAudioFormat(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "g711_ulaw") return "g711_ulaw";
  if (normalized === "g711_alaw") return "g711_alaw";
  return "pcm16";
}

function normalizeHardLimitList(input, fallback = []) {
  const source = Array.isArray(input) ? input : fallback;
  return [...new Set(source.map((item) => String(item || "").trim()).filter(Boolean))]
    .slice(0, 24)
    .map((item) => item.slice(0, 180));
}
