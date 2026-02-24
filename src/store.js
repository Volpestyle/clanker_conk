import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DEFAULT_SETTINGS } from "./defaultSettings.js";
import { clamp, deepMerge, nowIso, uniqueIdList } from "./utils.js";

const SETTINGS_KEY = "runtime_settings";

export class Store {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
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
        subject TEXT NOT NULL,
        fact TEXT NOT NULL,
        source_message_id TEXT,
        confidence REAL NOT NULL DEFAULT 0.5,
        UNIQUE(subject, fact)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_channel_time ON messages(channel_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_guild_time ON messages(guild_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_actions_kind_time ON actions(kind, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_actions_time ON actions(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_subject ON memory_facts(subject, created_at DESC);
    `);

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
    this.db
      .prepare(
        `INSERT OR IGNORE INTO messages(
          message_id,
          created_at,
          guild_id,
          channel_id,
          author_id,
          author_name,
          is_bot,
          content,
          referenced_message_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        String(message.messageId),
        nowIso(),
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
      return this.getRecentMessages(channelId, limit);
    }

    const clauses = tokens.map(() => "content LIKE ?").join(" OR ");
    const args = [String(channelId), ...tokens.map((t) => `%${t}%`), clamp(limit, 1, 24)];

    return this.db
      .prepare(
        `SELECT message_id, created_at, channel_id, author_id, author_name, is_bot, content
         FROM messages
         WHERE channel_id = ? AND (${clauses})
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

  hasTriggeredResponse(triggerMessageId) {
    const id = String(triggerMessageId).trim();
    if (!id) return false;

    const likeNeedle = `%"triggerMessageId":"${id}"%`;
    const row = this.db
      .prepare(
        `SELECT 1
         FROM actions
         WHERE kind IN ('sent_reply', 'sent_message')
           AND metadata LIKE ?
         LIMIT 1`
      )
      .get(likeNeedle);

    return Boolean(row);
  }

  getRecentActions(limit = 200) {
    const rows = this.db
      .prepare(
        `SELECT id, created_at, guild_id, channel_id, message_id, user_id, kind, content, metadata, usd_cost
         FROM actions
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(clamp(Math.floor(limit), 1, 1000));

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
      .prepare("SELECT COALESCE(SUM(usd_cost), 0) AS total FROM actions WHERE kind = 'llm_call'")
      .get();

    const dayCostRows = this.db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, COALESCE(SUM(usd_cost), 0) AS usd
         FROM actions
         WHERE kind = 'llm_call' AND created_at >= ?
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
        image_call: 0
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

  addMemoryFact(fact) {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_facts(created_at, subject, fact, source_message_id, confidence)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        nowIso(),
        String(fact.subject),
        String(fact.fact).slice(0, 400),
        fact.sourceMessageId ? String(fact.sourceMessageId) : null,
        clamp(Number(fact.confidence) || 0.5, 0, 1)
      );

    return result.changes > 0;
  }

  getFactsForSubject(subject, limit = 12) {
    return this.db
      .prepare(
        `SELECT id, created_at, subject, fact, source_message_id, confidence
         FROM memory_facts
         WHERE subject = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(String(subject), clamp(limit, 1, 100));
  }

  getRecentFacts(limit = 80) {
    return this.db
      .prepare(
        `SELECT id, created_at, subject, fact, source_message_id, confidence
         FROM memory_facts
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(clamp(limit, 1, 400));
  }

  getRecentHighlights(limit = 16) {
    return this.db
      .prepare(
        `SELECT created_at, author_name, content
         FROM messages
         WHERE is_bot = 0
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(clamp(limit, 1, 100));
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

function safeJsonParse(value, fallback) {
  if (!value || typeof value !== "string") return fallback;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeSettings(raw) {
  const merged = deepMerge(DEFAULT_SETTINGS, raw ?? {});
  if (!merged.activity || typeof merged.activity !== "object") merged.activity = {};
  if (!merged.startup || typeof merged.startup !== "object") merged.startup = {};
  if (!merged.permissions || typeof merged.permissions !== "object") merged.permissions = {};
  if (!merged.initiative || typeof merged.initiative !== "object") merged.initiative = {};
  if (!merged.memory || typeof merged.memory !== "object") merged.memory = {};
  if (!merged.llm || typeof merged.llm !== "object") merged.llm = {};

  merged.botName = String(merged.botName || "clanker conk").slice(0, 50);

  const replyLevel = clamp(
    Number(merged.activity?.replyLevel ?? DEFAULT_SETTINGS.activity.replyLevel) || 0,
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
  merged.activity = {
    replyLevel,
    reactionLevel,
    minSecondsBetweenMessages
  };

  merged.llm.provider = merged.llm?.provider === "anthropic" ? "anthropic" : "openai";
  merged.llm.model = String(merged.llm?.model || "gpt-4.1-mini").slice(0, 120);
  merged.llm.temperature = clamp(Number(merged.llm?.temperature) || 0.9, 0, 2);
  merged.llm.maxOutputTokens = clamp(Number(merged.llm?.maxOutputTokens) || 220, 32, 1400);

  merged.startup.catchupEnabled =
    merged.startup?.catchupEnabled !== undefined ? Boolean(merged.startup?.catchupEnabled) : true;
  const legacyLookbackMinutes = Number(merged.startup?.catchupLookbackMinutes) || 0;
  const configuredHours = Number(merged.startup?.catchupLookbackHours) || 0;
  const derivedHours = configuredHours || (legacyLookbackMinutes ? legacyLookbackMinutes / 60 : 6);
  merged.startup.catchupLookbackHours = clamp(derivedHours, 1, 24);
  if ("catchupLookbackMinutes" in merged.startup) {
    delete merged.startup.catchupLookbackMinutes;
  }
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
    Number(merged.permissions?.maxMessagesPerHour ?? merged.permissions?.maxRepliesPerHour) || 20,
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
  merged.initiative.imagePostChancePercent = clamp(
    Number(merged.initiative?.imagePostChancePercent) || 0,
    0,
    100
  );
  merged.initiative.imageModel = String(merged.initiative?.imageModel || "gpt-image-1").slice(0, 120);

  merged.memory.enabled = Boolean(merged.memory?.enabled);
  merged.memory.maxRecentMessages = clamp(Number(merged.memory?.maxRecentMessages) || 35, 10, 120);
  merged.memory.maxHighlights = clamp(Number(merged.memory?.maxHighlights) || 16, 4, 80);

  return merged;
}
