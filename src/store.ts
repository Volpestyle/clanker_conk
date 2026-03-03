export const LOOKUP_CONTEXT_MAX_ROWS_PER_CHANNEL_DEFAULT = 120;
export const LOOKUP_CONTEXT_MAX_RESULTS_DEFAULT = 5;
import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { load as loadSqliteVec } from "sqlite-vec";
import { DEFAULT_SETTINGS } from "./settings/settingsSchema.ts";
import { clamp, deepMerge, nowIso } from "./utils.ts";
import { normalizeWhitespaceText } from "./normalization/text.ts";
import {
  buildAutomationMatchText,
  normalizeAutomationInstruction,
  normalizeAutomationTitle
} from "./automation.ts";
import { normalizeSettings } from "./store/settingsNormalization.ts";
import { safeJsonParse } from "./normalization/valueParsers.ts";
import {
  mapAutomationRow,
  normalizeAutomationRunStatus,
  normalizeAutomationStatus,
  normalizeAutomationStatusFilter,
  normalizeEmbeddingVector,
  normalizeMessageCreatedAt,
  parseEmbeddingBlob,
  vectorToBlob
} from "./store/storeHelpers.ts";
import {
  normalizeResponseTriggerMessageIds,
  shouldTrackResponseTriggerKind
} from "./store/responseTriggers.ts";
import { pushPerformanceMetric, summarizeLatencyMetric } from "./store/storePerformance.ts";
import { rewriteRuntimeSettingsRow, getSettings, setSettings, patchSettings, resetSettings } from "./store/storeSettings.ts";
import { recordMessage, getRecentMessages, getRecentMessagesAcrossGuild, searchRelevantMessages, getActiveChannels } from "./store/storeMessages.ts";
import { maybePruneActionLog, pruneActionLog, logAction, countActionsSince, getLastActionTime, countInitiativePostsSince, getRecentActions, indexResponseTriggersForAction, hasTriggeredResponse } from "./store/storeActionLog.ts";
import { wasLinkSharedSince, recordSharedLink, pruneLookupContext, recordLookupContext, searchLookupContext } from "./store/storeLookups.ts";
import { getRecentVoiceSessions, getVoiceSessionEvents } from "./store/storeVoice.ts";
import { getReplyPerformanceStats, getStats } from "./store/storeStats.ts";
import { createAutomation, getAutomationById, countAutomations, listAutomations, getMostRecentAutomations, findAutomationsByQuery, setAutomationStatus, claimDueAutomations, finalizeAutomationRun, recordAutomationRun, getAutomationRuns } from "./store/storeAutomation.ts";
import { addMemoryFact, getFactsForSubjectScoped, getFactsForSubjects, getFactsForScope, getFactsForSubjectsScoped, getMemoryFactBySubjectAndFact, ensureSqliteVecReady, upsertMemoryFactVectorNative, getMemoryFactVectorNative, getMemoryFactVectorNativeScores, getMemorySubjects, archiveOldFactsForSubject } from "./store/storeMemory.ts";

const SETTINGS_KEY = "runtime_settings";
const LOOKUP_CONTEXT_QUERY_MAX_CHARS = 220;
const LOOKUP_CONTEXT_SOURCE_MAX_CHARS = 120;
const LOOKUP_CONTEXT_PROVIDER_MAX_CHARS = 64;
const LOOKUP_CONTEXT_RESULT_MAX_CHARS = 420;
const LOOKUP_CONTEXT_MATCH_TEXT_MAX_CHARS = 1800;

const LOOKUP_CONTEXT_MAX_TTL_HOURS = 168;
const LOOKUP_CONTEXT_MAX_AGE_HOURS = 168;
const LOOKUP_CONTEXT_MAX_SEARCH_LIMIT = 16;
export const ACTION_LOG_RETENTION_DAYS_DEFAULT = 14;
export const ACTION_LOG_RETENTION_DAYS_MIN = 1;
export const ACTION_LOG_RETENTION_DAYS_MAX = 3650;
export const ACTION_LOG_MAX_ROWS_DEFAULT = 120_000;
export const ACTION_LOG_MAX_ROWS_MIN = 1000;
export const ACTION_LOG_MAX_ROWS_RUNTIME_MIN = 1;
export const ACTION_LOG_MAX_ROWS_MAX = 5_000_000;
export const ACTION_LOG_PRUNE_EVERY_WRITES_DEFAULT = 250;
export const ACTION_LOG_PRUNE_EVERY_WRITES_MIN = 1;
export const ACTION_LOG_PRUNE_EVERY_WRITES_MAX = 10_000;

function resolveEnvBoundedInt(rawValue, fallback, min, max) {
  const parsed = Math.floor(Number(rawValue));
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

function resolveStoreEnvInt(name, fallback, min, max) {
  return resolveEnvBoundedInt(process.env[name], fallback, min, max);
}

function normalizeLookupResultText(value, maxChars = LOOKUP_CONTEXT_RESULT_MAX_CHARS) {
  return normalizeWhitespaceText(value, {
    maxLen: maxChars,
    minLen: 40
  });
}

function normalizeLookupResultRows(rows, maxResults = LOOKUP_CONTEXT_MAX_RESULTS_DEFAULT) {
  const source = Array.isArray(rows) ? rows : [];
  const boundedMaxResults = clamp(
    Math.floor(Number(maxResults) || LOOKUP_CONTEXT_MAX_RESULTS_DEFAULT),
    1,
    10
  );
  const normalizedRows = [];
  for (const row of source) {
    if (normalizedRows.length >= boundedMaxResults) break;
    const url = normalizeLookupResultText(row?.url, 420);
    if (!url) continue;
    normalizedRows.push({
      title: normalizeLookupResultText(row?.title, 180),
      url,
      domain: normalizeLookupResultText(row?.domain, 120),
      snippet: normalizeLookupResultText(row?.snippet, 260),
      pageSummary: normalizeLookupResultText(row?.pageSummary, 320)
    });
  }
  return normalizedRows;
}

function buildLookupContextMatchText({ query, results = [] }) {
  const normalizedQuery = normalizeLookupResultText(query, LOOKUP_CONTEXT_QUERY_MAX_CHARS);
  const resultRows = Array.isArray(results) ? results : [];
  const segments = [normalizedQuery];
  for (const row of resultRows) {
    const title = normalizeLookupResultText(row?.title, 180);
    const domain = normalizeLookupResultText(row?.domain, 120);
    const snippet = normalizeLookupResultText(row?.snippet, 220);
    const pageSummary = normalizeLookupResultText(row?.pageSummary, 220);
    if (title) segments.push(title);
    if (domain) segments.push(domain);
    if (snippet) segments.push(snippet);
    if (pageSummary) segments.push(pageSummary);
  }
  return segments
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LOOKUP_CONTEXT_MATCH_TEXT_MAX_CHARS);
}

function scoreLookupContextRow(row, tokens = []) {
  const normalizedTokens = Array.isArray(tokens) ? tokens : [];
  if (!normalizedTokens.length) return 0;
  const query = String(row?.query || "")
    .toLowerCase()
    .trim();
  const matchText = String(row?.match_text || "")
    .toLowerCase()
    .trim();
  if (!query && !matchText) return 0;

  let score = 0;
  for (const token of normalizedTokens) {
    if (!token) continue;
    if (query.includes(token)) {
      score += 3;
      continue;
    }
    if (matchText.includes(token)) {
      score += 1;
    }
  }
  return score;
}

export class Store {
  dbPath;
  db;
  sqliteVecReady;
  sqliteVecError;
  onActionLogged;
  actionLogRetentionDays;
  actionLogMaxRows;
  actionLogPruneEveryWrites;
  actionWritesSincePrune;

  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.sqliteVecReady = null;
    this.sqliteVecError = "";
    this.onActionLogged = null;
    this.actionLogRetentionDays = resolveStoreEnvInt(
      "ACTION_LOG_RETENTION_DAYS",
      ACTION_LOG_RETENTION_DAYS_DEFAULT,
      ACTION_LOG_RETENTION_DAYS_MIN,
      ACTION_LOG_RETENTION_DAYS_MAX
    );
    this.actionLogMaxRows = resolveStoreEnvInt(
      "ACTION_LOG_MAX_ROWS",
      ACTION_LOG_MAX_ROWS_DEFAULT,
      ACTION_LOG_MAX_ROWS_MIN,
      ACTION_LOG_MAX_ROWS_MAX
    );
    this.actionLogPruneEveryWrites = resolveStoreEnvInt(
      "ACTION_LOG_PRUNE_EVERY_WRITES",
      ACTION_LOG_PRUNE_EVERY_WRITES_DEFAULT,
      ACTION_LOG_PRUNE_EVERY_WRITES_MIN,
      ACTION_LOG_PRUNE_EVERY_WRITES_MAX
    );
    this.actionWritesSincePrune = 0;
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

      CREATE TABLE IF NOT EXISTS lookup_context (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        channel_id TEXT,
        user_id TEXT,
        source TEXT,
        query TEXT NOT NULL,
        provider TEXT,
        results_json TEXT NOT NULL,
        match_text TEXT NOT NULL
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
      CREATE INDEX IF NOT EXISTS idx_lookup_context_scope_time ON lookup_context(guild_id, channel_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_lookup_context_expires ON lookup_context(expires_at);
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

    this.pruneActionLog({ now: nowIso() });
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  rewriteRuntimeSettingsRow(rawValue) {
    return rewriteRuntimeSettingsRow(this, ...arguments);
  }

  getSettings() {
    return getSettings(this, ...arguments);
  }

  setSettings(next) {
    return setSettings(this, ...arguments);
  }

  patchSettings(patch) {
    return patchSettings(this, ...arguments);
  }

  resetSettings() {
    return resetSettings(this, ...arguments);
  }

  recordMessage(message) {
    return recordMessage(this, ...arguments);
  }

  getRecentMessages(channelId, limit = 40) {
    return getRecentMessages(this, ...arguments);
  }

  getRecentMessagesAcrossGuild(guildId, limit = 120) {
    return getRecentMessagesAcrossGuild(this, ...arguments);
  }

  searchRelevantMessages(channelId, queryText, limit = 8) {
    return searchRelevantMessages(this, ...arguments);
  }

  getActiveChannels(guildId, hours = 24, limit = 10) {
    return getActiveChannels(this, ...arguments);
  }

  maybePruneActionLog({ now = nowIso() } = {}) {
    return maybePruneActionLog(this, ...arguments);
  }

  pruneActionLog({
    now = nowIso(),
    maxAgeDays = this.actionLogRetentionDays,
    maxRows = this.actionLogMaxRows
  } = {}) {
    return pruneActionLog(this, ...arguments);
  }

  logAction(action) {
    return logAction(this, ...arguments);
  }

  countActionsSince(kind, sinceIso) {
    return countActionsSince(this, ...arguments);
  }

  getLastActionTime(kind) {
    return getLastActionTime(this, ...arguments);
  }

  countInitiativePostsSince(sinceIso) {
    return countInitiativePostsSince(this, ...arguments);
  }

  getRecentActions(limit = 200) {
    return getRecentActions(this, ...arguments);
  }

  indexResponseTriggersForAction({
    actionId,
    kind,
    metadata,
    createdAt = nowIso()
  }) {
    return indexResponseTriggersForAction(this, ...arguments);
  }

  hasTriggeredResponse(triggerMessageId) {
    return hasTriggeredResponse(this, ...arguments);
  }

  wasLinkSharedSince(url, sinceIso) {
    return wasLinkSharedSince(this, ...arguments);
  }

  recordSharedLink({ url, source = null }) {
    return recordSharedLink(this, ...arguments);
  }

  pruneLookupContext({
    now = nowIso(),
    guildId = null,
    channelId = null,
    maxRowsPerChannel = LOOKUP_CONTEXT_MAX_ROWS_PER_CHANNEL_DEFAULT
  } = {}) {
    return pruneLookupContext(this, ...arguments);
  }

  recordLookupContext({
    guildId,
    channelId = null,
    userId = null,
    source = null,
    query,
    provider = null,
    results = [],
    ttlHours = 48,
    maxResults = LOOKUP_CONTEXT_MAX_RESULTS_DEFAULT,
    maxRowsPerChannel = LOOKUP_CONTEXT_MAX_ROWS_PER_CHANNEL_DEFAULT
  }) {
    return recordLookupContext(this, ...arguments);
  }

  searchLookupContext({
    guildId,
    channelId = null,
    queryText = "",
    limit = 4,
    maxAgeHours = 72
  }) {
    return searchLookupContext(this, ...arguments);
  }

  getRecentVoiceSessions(limit = 3) {
    return getRecentVoiceSessions(this, ...arguments);
  }

  getVoiceSessionEvents(sessionId: string, limit = 500) {
    return getVoiceSessionEvents(this, ...arguments);
  }

  getReplyPerformanceStats({ windowHours = 24, maxSamples = 4000 } = {}) {
    return getReplyPerformanceStats(this, ...arguments);
  }

  getStats() {
    return getStats(this, ...arguments);
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
    return createAutomation(this, ...arguments);
  }

  getAutomationById(automationId, guildId = null) {
    return getAutomationById(this, ...arguments);
  }

  countAutomations({ guildId, statuses = ["active", "paused"] }) {
    return countAutomations(this, ...arguments);
  }

  listAutomations({
    guildId,
    channelId = null,
    statuses = ["active", "paused"],
    query = "",
    limit = 20
  }) {
    return listAutomations(this, ...arguments);
  }

  getMostRecentAutomations({
    guildId,
    channelId = null,
    statuses = ["active", "paused"],
    limit = 8
  }) {
    return getMostRecentAutomations(this, ...arguments);
  }

  findAutomationsByQuery({
    guildId,
    channelId = null,
    query = "",
    statuses = ["active", "paused"],
    limit = 8
  }) {
    return findAutomationsByQuery(this, ...arguments);
  }

  setAutomationStatus({
    automationId,
    guildId,
    status,
    nextRunAt = null,
    lastError = null,
    lastResult = null
  }) {
    return setAutomationStatus(this, ...arguments);
  }

  claimDueAutomations({ now = nowIso(), limit = 4 }: { now?: string; limit?: number } = {}) {
    return claimDueAutomations(this, ...arguments);
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
    return finalizeAutomationRun(this, ...arguments);
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
    return recordAutomationRun(this, ...arguments);
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
    return getAutomationRuns(this, ...arguments);
  }

  addMemoryFact(fact) {
    return addMemoryFact(this, ...arguments);
  }

  getFactsForSubjectScoped(subject, limit = 12, scope = null) {
    return getFactsForSubjectScoped(this, ...arguments);
  }

  getFactsForSubjects(subjects, limit = 80, scope = null) {
    return getFactsForSubjects(this, ...arguments);
  }

  getFactsForScope({ guildId, limit = 120, subjectIds = null }) {
    return getFactsForScope(this, ...arguments);
  }

  getFactsForSubjectsScoped({
    guildId = null,
    subjectIds = [],
    perSubjectLimit = 6,
    totalLimit = 600
  } = {}) {
    return getFactsForSubjectsScoped(this, ...arguments);
  }

  getMemoryFactBySubjectAndFact(guildId, subject, fact) {
    return getMemoryFactBySubjectAndFact(this, ...arguments);
  }

  ensureSqliteVecReady() {
    return ensureSqliteVecReady(this, ...arguments);
  }

  upsertMemoryFactVectorNative({ factId, model, embedding, updatedAt = nowIso() }) {
    return upsertMemoryFactVectorNative(this, ...arguments);
  }

  getMemoryFactVectorNative(factId, model) {
    return getMemoryFactVectorNative(this, ...arguments);
  }

  getMemoryFactVectorNativeScores({ factIds, model, queryEmbedding }) {
    return getMemoryFactVectorNativeScores(this, ...arguments);
  }

  getMemorySubjects(limit = 80, scope = null) {
    return getMemorySubjects(this, ...arguments);
  }

  archiveOldFactsForSubject({ guildId, subject, factType = null, keep = 60 }) {
    return archiveOldFactsForSubject(this, ...arguments);
  }
}
