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
        fact_type TEXT NOT NULL DEFAULT 'general',
        evidence_text TEXT,
        source_message_id TEXT,
        confidence REAL NOT NULL DEFAULT 0.5,
        UNIQUE(subject, fact)
      );

      CREATE TABLE IF NOT EXISTS shared_links (
        url TEXT PRIMARY KEY,
        first_shared_at TEXT NOT NULL,
        last_shared_at TEXT NOT NULL,
        share_count INTEGER NOT NULL DEFAULT 1,
        source TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_messages_channel_time ON messages(channel_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_guild_time ON messages(guild_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_actions_kind_time ON actions(kind, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_actions_time ON actions(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_subject ON memory_facts(subject, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_shared_links_last_shared_at ON shared_links(last_shared_at DESC);
    `);
    this.ensureMemoryFactsSchema();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_subject_type ON memory_facts(subject, fact_type, created_at DESC);
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

    const likeNeedle = `%"triggerMessageId":"${id}"%`;
    const row = this.db
      .prepare(
        `SELECT 1
         FROM actions
         WHERE kind IN ('sent_reply', 'sent_message', 'reply_skipped')
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
      .prepare(
        `SELECT COALESCE(SUM(usd_cost), 0) AS total
         FROM actions
         WHERE kind IN ('llm_call', 'image_call')`
      )
      .get();

    const dayCostRows = this.db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, COALESCE(SUM(usd_cost), 0) AS usd
         FROM actions
         WHERE kind IN ('llm_call', 'image_call') AND created_at >= ?
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
        asr_call: 0
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
    const rawConfidence = Number(fact.confidence);
    const confidence = clamp(Number.isFinite(rawConfidence) ? rawConfidence : 0.5, 0, 1);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_facts(
          created_at,
          subject,
          fact,
          fact_type,
          evidence_text,
          source_message_id,
          confidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        nowIso(),
        String(fact.subject),
        String(fact.fact).slice(0, 400),
        String(fact.factType || "general").slice(0, 40),
        fact.evidenceText ? String(fact.evidenceText).slice(0, 240) : null,
        fact.sourceMessageId ? String(fact.sourceMessageId) : null,
        confidence
      );

    return result.changes > 0;
  }

  getFactsForSubject(subject, limit = 12) {
    return this.db
      .prepare(
        `SELECT id, created_at, subject, fact, fact_type, evidence_text, source_message_id, confidence
         FROM memory_facts
         WHERE subject = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(String(subject), clamp(limit, 1, 100));
  }

  getMemorySubjects(limit = 80) {
    return this.db
      .prepare(
        `SELECT subject, MAX(created_at) AS last_seen_at, COUNT(*) AS fact_count
         FROM memory_facts
         GROUP BY subject
         ORDER BY last_seen_at DESC
         LIMIT ?`
      )
      .all(clamp(limit, 1, 500));
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

    if (!columns.includes("fact_type")) {
      this.db.exec("ALTER TABLE memory_facts ADD COLUMN fact_type TEXT NOT NULL DEFAULT 'general';");
    }

    if (!columns.includes("evidence_text")) {
      this.db.exec("ALTER TABLE memory_facts ADD COLUMN evidence_text TEXT;");
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
  if (!merged.persona || typeof merged.persona !== "object") merged.persona = {};
  if (!merged.activity || typeof merged.activity !== "object") merged.activity = {};
  if (!merged.startup || typeof merged.startup !== "object") merged.startup = {};
  if (!merged.permissions || typeof merged.permissions !== "object") merged.permissions = {};
  if (!merged.initiative || typeof merged.initiative !== "object") merged.initiative = {};
  if (!merged.memory || typeof merged.memory !== "object") merged.memory = {};
  if (!merged.llm || typeof merged.llm !== "object") merged.llm = {};
  if (!merged.webSearch || typeof merged.webSearch !== "object") merged.webSearch = {};
  if (!merged.videoContext || typeof merged.videoContext !== "object") merged.videoContext = {};
  if ("youtubeContext" in merged) {
    delete merged.youtubeContext;
  }

  merged.botName = String(merged.botName || "clanker conk").slice(0, 50);
  merged.persona.flavor = String(merged.persona?.flavor || DEFAULT_SETTINGS.persona.flavor).slice(0, 240);
  merged.persona.hardLimits = normalizeHardLimitList(
    merged.persona?.hardLimits,
    DEFAULT_SETTINGS.persona?.hardLimits ?? []
  );
  if ("shortReplyBias" in merged.persona) {
    delete merged.persona.shortReplyBias;
  }

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

  merged.webSearch.enabled = Boolean(merged.webSearch?.enabled);
  const maxSearchesRaw = Number(merged.webSearch?.maxSearchesPerHour);
  const maxResultsRaw = Number(merged.webSearch?.maxResults);
  const maxPagesRaw = Number(merged.webSearch?.maxPagesToRead);
  const maxCharsRaw = Number(merged.webSearch?.maxCharsPerPage);
  merged.webSearch.maxSearchesPerHour = clamp(Number.isFinite(maxSearchesRaw) ? maxSearchesRaw : 12, 1, 120);
  merged.webSearch.maxResults = clamp(Number.isFinite(maxResultsRaw) ? maxResultsRaw : 5, 1, 10);
  merged.webSearch.maxPagesToRead = clamp(Number.isFinite(maxPagesRaw) ? maxPagesRaw : 3, 0, 6);
  merged.webSearch.maxCharsPerPage = clamp(Number.isFinite(maxCharsRaw) ? maxCharsRaw : 1400, 350, 4000);
  merged.webSearch.safeSearch =
    merged.webSearch?.safeSearch !== undefined ? Boolean(merged.webSearch?.safeSearch) : true;

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
  merged.initiative.allowReplyImages = Boolean(merged.initiative?.allowReplyImages);
  merged.initiative.allowReplyGifs = Boolean(merged.initiative?.allowReplyGifs);
  merged.initiative.maxImagesPerDay = clamp(Number(merged.initiative?.maxImagesPerDay) || 0, 0, 200);
  merged.initiative.maxGifsPerDay = clamp(Number(merged.initiative?.maxGifsPerDay) || 0, 0, 300);
  merged.initiative.imageModel = String(merged.initiative?.imageModel || "gpt-image-1.5").slice(0, 120);
  if ("imagePostChancePercent" in merged.initiative) {
    delete merged.initiative.imagePostChancePercent;
  }
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

function normalizeHardLimitList(input, fallback = []) {
  const source = Array.isArray(input) && input.length ? input : fallback;
  return [...new Set(source.map((item) => String(item || "").trim()).filter(Boolean))]
    .slice(0, 24)
    .map((item) => item.slice(0, 180));
}
