#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { appConfig } from "../src/config.ts";
import { parseStructuredReplyOutput } from "../src/botHelpers.ts";
import { LLMService } from "../src/llm.ts";
import { buildReplyPrompt, buildSystemPrompt } from "../src/prompts.ts";
import { shouldAttemptReplyDecision } from "../src/bot/replyAdmission.ts";
import { normalizeSettings } from "../src/store/settingsNormalization.ts";
import { isBotNameAddressed } from "../src/voice/voiceSessionHelpers.ts";

type HarnessMode = "recorded" | "live";

type ReplayArgs = {
  mode: HarnessMode;
  dbPath: string;
  since: string;
  until: string;
  historyLookbackHours: number;
  channelId: string;
  maxTurns: number;
  snapshotsLimit: number;
  actorProvider: string;
  actorModel: string;
  judgeProvider: string;
  judgeModel: string;
  judge: boolean;
  windowStart: string;
  windowEnd: string;
  assertMaxUnaddressedSendRate: number;
  assertMaxUnaddressedSends: number;
  assertMinAddressedSendRate: number;
  assertMinAddressedSends: number;
  assertMaxSentTurns: number;
  assertMinLlmCalls: number;
  failOnLlmError: boolean;
  outJsonPath: string;
};

type MessageRow = {
  message_id: string;
  created_at: string;
  guild_id: string | null;
  channel_id: string;
  author_id: string;
  author_name: string;
  is_bot: number;
  content: string;
  referenced_message_id: string | null;
};

type ActionRow = {
  id: number;
  created_at: string;
  channel_id: string | null;
  kind: string;
  content: string | null;
  metadata: string | null;
  message_id?: string | null;
};

type DecisionOutcomeKind = "sent_message" | "sent_reply" | "reply_skipped" | "voice_intent_detected" | "no_action";

type ReplayDecision = {
  kind: DecisionOutcomeKind;
  addressed: boolean;
  attempted: boolean;
  content: string;
  reason: string;
  voiceIntent: string;
  llmProvider: string;
  llmModel: string;
  llmCostUsd: number;
};

type ReplayEvent = {
  createdAt: string;
  channelId: string;
  role: "USER" | "BOT" | "BOT_ACTION";
  authorName: string;
  content: string;
};

type ChannelStats = {
  channelMode: "initiative" | "non_initiative";
  userTurns: number;
  addressedTurns: number;
  unaddressedTurns: number;
  attemptedTurns: number;
  attemptedAddressed: number;
  attemptedUnaddressed: number;
  sentTurns: number;
  sentAddressed: number;
  sentUnaddressed: number;
  skippedTurns: number;
  skippedAddressed: number;
  skippedUnaddressed: number;
  voiceIntentTurns: number;
  noActionTurns: number;
  errorTurns: number;
  llmCalls: number;
  llmCostUsd: number;
};

type JudgeResult = {
  isFlooding: boolean;
  floodScore: number;
  confidence: number;
  summary: string;
  signals: string[];
  rawText: string;
};

type TurnSnapshot = {
  index: number;
  messageId: string;
  createdAt: string;
  channelId: string;
  channelMode: "initiative" | "non_initiative";
  authorName: string;
  userContent: string;
  addressed: boolean;
  attempted: boolean;
  decisionKind: DecisionOutcomeKind;
  decisionReason: string;
  botContent: string;
  llmProvider: string;
  llmModel: string;
  llmCostUsd: number;
};

const DEFAULT_ARGS: ReplayArgs = {
  mode: "recorded",
  dbPath: "data/clanker.db",
  since: "2026-02-27T00:00:00.000Z",
  until: "",
  historyLookbackHours: 6,
  channelId: "",
  maxTurns: 0,
  snapshotsLimit: 40,
  actorProvider: "",
  actorModel: "",
  judgeProvider: "",
  judgeModel: "",
  judge: true,
  windowStart: "2026-02-27T16:28:30.000Z",
  windowEnd: "2026-02-27T16:32:45.000Z",
  assertMaxUnaddressedSendRate: -1,
  assertMaxUnaddressedSends: -1,
  assertMinAddressedSendRate: -1,
  assertMinAddressedSends: -1,
  assertMaxSentTurns: -1,
  assertMinLlmCalls: -1,
  failOnLlmError: false,
  outJsonPath: ""
};

function parseArgs(argv: string[]): ReplayArgs {
  const out: ReplayArgs = { ...DEFAULT_ARGS };
  for (let i = 0; i < argv.length; i += 1) {
    const key = String(argv[i] || "").trim();
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    const rawValue = String(argv[i + 1] || "").trim();
    const needsValue = !["judge", "no-judge"].includes(name);
    if (needsValue && !rawValue.startsWith("--")) {
      i += 1;
    }

    switch (name) {
      case "mode":
        out.mode = rawValue === "live" ? "live" : "recorded";
        break;
      case "db":
        out.dbPath = rawValue || out.dbPath;
        break;
      case "since":
        out.since = rawValue || out.since;
        break;
      case "until":
        out.until = rawValue;
        break;
      case "channel-id":
        out.channelId = rawValue;
        break;
      case "history-lookback-hours":
        out.historyLookbackHours = Math.max(0, Math.floor(Number(rawValue) || 0));
        break;
      case "max-turns":
        out.maxTurns = Math.max(0, Math.floor(Number(rawValue) || 0));
        break;
      case "snapshots-limit":
        out.snapshotsLimit = Math.max(0, Math.floor(Number(rawValue) || 0));
        break;
      case "actor-provider":
        out.actorProvider = rawValue;
        break;
      case "actor-model":
        out.actorModel = rawValue;
        break;
      case "judge-provider":
        out.judgeProvider = rawValue;
        break;
      case "judge-model":
        out.judgeModel = rawValue;
        break;
      case "judge":
        out.judge = true;
        break;
      case "no-judge":
        out.judge = false;
        break;
      case "window-start":
        out.windowStart = rawValue;
        break;
      case "window-end":
        out.windowEnd = rawValue;
        break;
      case "assert-max-unaddressed-send-rate":
        out.assertMaxUnaddressedSendRate = Number.isFinite(Number(rawValue)) ? Number(rawValue) : -1;
        break;
      case "assert-max-unaddressed-sends":
        out.assertMaxUnaddressedSends = Number.isFinite(Number(rawValue)) ? Math.floor(Number(rawValue)) : -1;
        break;
      case "assert-min-addressed-send-rate":
        out.assertMinAddressedSendRate = Number.isFinite(Number(rawValue)) ? Number(rawValue) : -1;
        break;
      case "assert-min-addressed-sends":
        out.assertMinAddressedSends = Number.isFinite(Number(rawValue)) ? Math.floor(Number(rawValue)) : -1;
        break;
      case "assert-max-sent-turns":
        out.assertMaxSentTurns = Number.isFinite(Number(rawValue)) ? Math.floor(Number(rawValue)) : -1;
        break;
      case "assert-min-llm-calls":
        out.assertMinLlmCalls = Number.isFinite(Number(rawValue)) ? Math.floor(Number(rawValue)) : -1;
        break;
      case "fail-on-llm-error":
        out.failOnLlmError = true;
        break;
      case "out-json":
        out.outJsonPath = rawValue;
        break;
      default:
        break;
    }
  }
  return out;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isoInWindow(value: string, start: string, end: string) {
  if (!value) return false;
  if (!start && !end) return false;
  if (start && value < start) return false;
  if (end && value > end) return false;
  return true;
}

function parseJsonSafe(rawText: string) {
  try {
    return JSON.parse(rawText);
  } catch {
    return null;
  }
}

function parseJsonObjectFromText(rawText: string) {
  const value = String(rawText || "").trim();
  if (!value) return null;
  const direct = parseJsonSafe(value);
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  const sliced = value.slice(firstBrace, lastBrace + 1);
  const parsed = parseJsonSafe(sliced);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  return null;
}

function stableNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildAddressSignal({
  botUserId,
  botName,
  message,
  recentById
}: {
  botUserId: string;
  botName: string;
  message: MessageRow;
  recentById: Map<string, MessageRow>;
}) {
  const content = String(message.content || "");
  const normalized = content.toLowerCase();
  const mentioned =
    normalized.includes(`<@${botUserId.toLowerCase()}>`) ||
    normalized.includes(`<@!${botUserId.toLowerCase()}>`);
  const namePing = isBotNameAddressed({
    transcript: content,
    botName
  });
  const referencedId = String(message.referenced_message_id || "").trim();
  const referenced = referencedId ? recentById.get(referencedId) : null;
  const replyToBot = Boolean(referenced && Number(referenced.is_bot) === 1 && String(referenced.author_id) === botUserId);
  const direct = Boolean(mentioned || namePing || replyToBot);
  return {
    direct,
    inferred: false,
    triggered: direct,
    reason: direct ? "direct" : "llm_decides"
  };
}

function buildChannelStats(channelMode: "initiative" | "non_initiative"): ChannelStats {
  return {
    channelMode,
    userTurns: 0,
    addressedTurns: 0,
    unaddressedTurns: 0,
    attemptedTurns: 0,
    attemptedAddressed: 0,
    attemptedUnaddressed: 0,
    sentTurns: 0,
    sentAddressed: 0,
    sentUnaddressed: 0,
    skippedTurns: 0,
    skippedAddressed: 0,
    skippedUnaddressed: 0,
    voiceIntentTurns: 0,
    noActionTurns: 0,
    errorTurns: 0,
    llmCalls: 0,
    llmCostUsd: 0
  };
}

class HarnessStore {
  logAction() {
    // Intentionally no-op: harness reporting prints to stdout/json.
  }
}

function createLlmService() {
  return new LLMService({
    appConfig,
    store: new HarnessStore()
  });
}

function queryRows<T extends Record<string, unknown>>(db: DatabaseSync, sql: string, params: unknown[] = []): T[] {
  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as T[];
  return Array.isArray(rows) ? rows : [];
}

function parseMetadataObject(row: ActionRow) {
  const raw = String(row.metadata || "").trim();
  if (!raw) return {};
  const parsed = parseJsonSafe(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

async function runLiveActorDecision({
  llm,
  settings,
  botUserId,
  message,
  recentMessages,
  addressed,
  replyEagerness,
  reactionEagerness
}: {
  llm: LLMService;
  settings: Record<string, unknown>;
  botUserId: string;
  message: MessageRow;
  recentMessages: MessageRow[];
  addressed: boolean;
  replyEagerness: number;
  reactionEagerness: number;
}): Promise<ReplayDecision> {
  const systemPrompt = buildSystemPrompt(settings);
  const userPrompt = buildReplyPrompt({
    message: {
      authorName: String(message.author_name || "unknown"),
      content: String(message.content || "")
    },
    imageInputs: [],
    recentMessages,
    relevantMessages: [],
    userFacts: [],
    relevantFacts: [],
    emojiHints: [],
    reactionEmojiOptions: [],
    allowReplySimpleImages: false,
    allowReplyComplexImages: false,
    allowReplyVideos: false,
    allowReplyGifs: false,
    remainingReplyImages: 0,
    remainingReplyVideos: 0,
    remainingReplyGifs: 0,
    replyEagerness,
    reactionEagerness,
    addressing: {
      directlyAddressed: addressed,
      responseRequired: addressed
    },
    webSearch: {
      enabled: false,
      configured: false,
      requested: false,
      used: false,
      query: "",
      results: [],
      blockedByBudget: false,
      budget: { maxPerHour: 0, remaining: 0 }
    },
    memoryLookup: {
      enabled: false,
      requested: false,
      used: false,
      query: "",
      results: [],
      error: null
    },
    imageLookup: {
      enabled: false,
      requested: false,
      used: false,
      query: "",
      candidates: [],
      results: [],
      error: null
    },
    allowWebSearchDirective: false,
    allowMemoryLookupDirective: false,
    allowImageLookupDirective: false,
    allowMemoryDirective: false,
    allowAutomationDirective: false,
    voiceMode: {
      enabled: Boolean((settings as { voice?: { enabled?: boolean } })?.voice?.enabled)
    },
    screenShare: {
      enabled: false,
      status: "disabled",
      publicUrl: ""
    },
    videoContext: {
      requested: false,
      enabled: false,
      used: false,
      blockedByBudget: false,
      error: null,
      errors: [],
      detectedVideos: 0,
      detectedFromRecentMessages: false,
      videos: [],
      frameImages: [],
      budget: { maxPerHour: 0, used: 0, successCount: 0, errorCount: 0, remaining: 0, canLookup: false }
    },
    maxMediaPromptChars: Number((settings as { initiative?: { maxMediaPromptChars?: number } })?.initiative?.maxMediaPromptChars || 900),
    mediaPromptCraftGuidance: ""
  });

  const generation = await llm.generate({
    settings,
    systemPrompt,
    userPrompt,
    trace: {
      guildId: message.guild_id || null,
      channelId: message.channel_id,
      userId: botUserId,
      source: "flooding_replay_actor",
      event: "turn_decision",
      reason: addressed ? "addressed" : "unaddressed",
      messageId: message.message_id
    }
  });

  const parsed = parseStructuredReplyOutput(
    generation.text,
    Number((settings as { initiative?: { maxMediaPromptChars?: number } })?.initiative?.maxMediaPromptChars || 900)
  );
  const text = String(parsed.text || "").trim();
  const voiceIntent = String(parsed.voiceIntent?.intent || "").trim();
  const voiceIntentConfidence = stableNumber(parsed.voiceIntent?.confidence, 0);
  const voiceIntentThreshold = clamp(
    stableNumber((settings as { voice?: { intentConfidenceThreshold?: number } })?.voice?.intentConfidenceThreshold, 0.75),
    0.4,
    0.99
  );

  if (voiceIntent && voiceIntentConfidence >= voiceIntentThreshold) {
    return {
      kind: "voice_intent_detected",
      addressed,
      attempted: true,
      content: "",
      reason: "voice_intent_detected",
      voiceIntent,
      llmProvider: String(generation.provider || ""),
      llmModel: String(generation.model || ""),
      llmCostUsd: stableNumber(generation.costUsd, 0)
    };
  }

  if (!text || text === "[SKIP]") {
    return {
      kind: "reply_skipped",
      addressed,
      attempted: true,
      content: "llm_skip",
      reason: "llm_skip",
      voiceIntent: "",
      llmProvider: String(generation.provider || ""),
      llmModel: String(generation.model || ""),
      llmCostUsd: stableNumber(generation.costUsd, 0)
    };
  }

  return {
    kind: "sent_message",
    addressed,
    attempted: true,
    content: text,
    reason: "llm_send",
    voiceIntent: "",
    llmProvider: String(generation.provider || ""),
    llmModel: String(generation.model || ""),
    llmCostUsd: stableNumber(generation.costUsd, 0)
  };
}

async function runJudge({
  llm,
  settings,
  mode,
  windowTimeline,
  nonInitiativeStats,
  initiativeStats,
  windowStart,
  windowEnd
}: {
  llm: LLMService;
  settings: Record<string, unknown>;
  mode: HarnessMode;
  windowTimeline: ReplayEvent[];
  nonInitiativeStats: ChannelStats;
  initiativeStats: ChannelStats;
  windowStart: string;
  windowEnd: string;
}): Promise<JudgeResult> {
  const summarizedTimeline = windowTimeline
    .slice(0, 220)
    .map((entry) => `${entry.createdAt} | ${entry.role} | ${entry.authorName}: ${entry.content}`)
    .join("\n");

  const systemPrompt = [
    "You are a strict evaluator for Discord flooding behavior.",
    "Judge whether the bot is flooding chat.",
    "Flooding means the bot repeatedly jumps into unaddressed human conversation, dominates turn-taking, or adds low-value interruptions.",
    "In initiative channels, some extra chatter is allowed, but obvious domination still counts as flooding.",
    "Return strict JSON only."
  ].join("\n");

  const userPrompt = [
    `Mode: ${mode}`,
    `Window: ${windowStart || "(not set)"} -> ${windowEnd || "(not set)"}`,
    `Non-initiative stats: unaddressed_sent=${nonInitiativeStats.sentUnaddressed}, unaddressed_turns=${nonInitiativeStats.unaddressedTurns}, sent_turns=${nonInitiativeStats.sentTurns}, user_turns=${nonInitiativeStats.userTurns}`,
    `Initiative stats: unaddressed_sent=${initiativeStats.sentUnaddressed}, unaddressed_turns=${initiativeStats.unaddressedTurns}, sent_turns=${initiativeStats.sentTurns}, user_turns=${initiativeStats.userTurns}`,
    "Conversation timeline:",
    summarizedTimeline || "(no window events)",
    'Output schema: {"isFlooding":true|false,"floodScore":0..100,"confidence":0..1,"summary":"...","signals":["..."]}'
  ].join("\n\n");

  const generation = await llm.generate({
    settings,
    systemPrompt,
    userPrompt,
    trace: {
      guildId: null,
      channelId: null,
      userId: null,
      source: "flooding_replay_judge",
      event: "flooding_verdict"
    }
  });

  const parsed = parseJsonObjectFromText(String(generation.text || "")) || {};
  const rawSignals = Array.isArray(parsed.signals) ? parsed.signals : [];
  const signals = rawSignals
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .slice(0, 10);

  return {
    isFlooding: Boolean(parsed.isFlooding),
    floodScore: clamp(Math.floor(stableNumber(parsed.floodScore, 0)), 0, 100),
    confidence: clamp(stableNumber(parsed.confidence, 0), 0, 1),
    summary: String(parsed.summary || "").trim(),
    signals,
    rawText: String(generation.text || "")
  };
}

function ensureLlmSettings(baseSettings: Record<string, unknown>, providerOverride: string, modelOverride: string) {
  const next = structuredClone(baseSettings) as Record<string, unknown> & { llm?: Record<string, unknown> };
  if (!next.llm || typeof next.llm !== "object") next.llm = {};
  if (providerOverride) next.llm.provider = providerOverride;
  if (modelOverride) next.llm.model = modelOverride;
  return next;
}

function toRecentMessagesDesc(history: MessageRow[], maxItems: number) {
  const bounded = Math.max(1, Math.floor(maxItems) || 1);
  return history.slice(-bounded).slice().reverse();
}

function printStats(label: string, stats: ChannelStats) {
  const unaddressedSendRate = stats.unaddressedTurns > 0 ? (100 * stats.sentUnaddressed) / stats.unaddressedTurns : 0;
  const addressedSendRate = stats.addressedTurns > 0 ? (100 * stats.sentAddressed) / stats.addressedTurns : 0;
  const attemptedRate = stats.userTurns > 0 ? (100 * stats.attemptedTurns) / stats.userTurns : 0;
  console.log(`${label}`);
  console.log(`  userTurns=${stats.userTurns} attemptedTurns=${stats.attemptedTurns} attemptedRate=${attemptedRate.toFixed(1)}%`);
  console.log(`  addressedTurns=${stats.addressedTurns} sent=${stats.sentAddressed} skipped=${stats.skippedAddressed} sendRate=${addressedSendRate.toFixed(1)}%`);
  console.log(`  unaddressedTurns=${stats.unaddressedTurns} sent=${stats.sentUnaddressed} skipped=${stats.skippedUnaddressed} sendRate=${unaddressedSendRate.toFixed(1)}%`);
  console.log(`  voiceIntentTurns=${stats.voiceIntentTurns} noActionTurns=${stats.noActionTurns} errors=${stats.errorTurns}`);
  console.log(`  llmCalls=${stats.llmCalls} llmCostUsd=${stats.llmCostUsd.toFixed(6)}`);
}

function truncateText(value: string, maxChars: number) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 3))}...`;
}

function printTurnSnapshots(snapshots: TurnSnapshot[], limit: number) {
  const boundedLimit = Math.max(0, Math.floor(limit) || 0);
  if (!snapshots.length || boundedLimit === 0) return;
  console.log(`turnSnapshots count=${snapshots.length} showing=${Math.min(boundedLimit, snapshots.length)}`);
  console.log("idx | time | mode | addr | try | decision | user | bot");
  for (const snapshot of snapshots.slice(0, boundedLimit)) {
    const time = String(snapshot.createdAt || "").slice(11, 19);
    const mode = snapshot.channelMode === "initiative" ? "init" : "non-init";
    const addr = snapshot.addressed ? "Y" : "N";
    const attempt = snapshot.attempted ? "Y" : "N";
    const decision = truncateText(snapshot.decisionKind, 14);
    const user = truncateText(`${snapshot.authorName}: ${snapshot.userContent}`, 54);
    const bot = snapshot.botContent ? truncateText(snapshot.botContent, 46) : "-";
    console.log(
      `${String(snapshot.index).padStart(2, "0")} | ${time} | ${mode} | ${addr} | ${attempt} | ${decision} | ${user} | ${bot}`
    );
  }
  if (snapshots.length > boundedLimit) {
    console.log(`... truncated ${snapshots.length - boundedLimit} more turn snapshots`);
  }
}

function formatPct(numerator: number, denominator: number) {
  if (denominator <= 0) return 0;
  return (100 * numerator) / denominator;
}

function evaluateAssertions({
  args,
  nonInitiativeStats,
  initiativeStats
}: {
  args: ReplayArgs;
  nonInitiativeStats: ChannelStats;
  initiativeStats: ChannelStats;
}) {
  const failures: string[] = [];
  const nonAddressedRate = formatPct(nonInitiativeStats.sentAddressed, nonInitiativeStats.addressedTurns);
  const nonUnaddressedRate = formatPct(nonInitiativeStats.sentUnaddressed, nonInitiativeStats.unaddressedTurns);
  const totalErrorTurns = nonInitiativeStats.errorTurns + initiativeStats.errorTurns;
  const totalLlmCalls = nonInitiativeStats.llmCalls + initiativeStats.llmCalls;

  if (args.assertMaxUnaddressedSendRate >= 0 && nonUnaddressedRate > args.assertMaxUnaddressedSendRate) {
    failures.push(
      `assert-max-unaddressed-send-rate failed: actual=${nonUnaddressedRate.toFixed(1)} threshold=${args.assertMaxUnaddressedSendRate}`
    );
  }
  if (args.assertMaxUnaddressedSends >= 0 && nonInitiativeStats.sentUnaddressed > args.assertMaxUnaddressedSends) {
    failures.push(
      `assert-max-unaddressed-sends failed: actual=${nonInitiativeStats.sentUnaddressed} threshold=${args.assertMaxUnaddressedSends}`
    );
  }
  if (args.assertMinAddressedSendRate >= 0 && nonAddressedRate < args.assertMinAddressedSendRate) {
    failures.push(
      `assert-min-addressed-send-rate failed: actual=${nonAddressedRate.toFixed(1)} threshold=${args.assertMinAddressedSendRate}`
    );
  }
  if (args.assertMinAddressedSends >= 0 && nonInitiativeStats.sentAddressed < args.assertMinAddressedSends) {
    failures.push(
      `assert-min-addressed-sends failed: actual=${nonInitiativeStats.sentAddressed} threshold=${args.assertMinAddressedSends}`
    );
  }
  if (args.assertMaxSentTurns >= 0 && nonInitiativeStats.sentTurns > args.assertMaxSentTurns) {
    failures.push(
      `assert-max-sent-turns failed: actual=${nonInitiativeStats.sentTurns} threshold=${args.assertMaxSentTurns}`
    );
  }
  if (args.assertMinLlmCalls >= 0 && totalLlmCalls < args.assertMinLlmCalls) {
    failures.push(`assert-min-llm-calls failed: actual=${totalLlmCalls} threshold=${args.assertMinLlmCalls}`);
  }
  if (args.failOnLlmError && totalErrorTurns > 0) {
    failures.push(`fail-on-llm-error failed: llm_error_turns=${totalErrorTurns}`);
  }

  return failures;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sinceMs = Date.parse(args.since);
  const lookbackMs = Math.max(0, Math.floor(Number(args.historyLookbackHours) || 0)) * 60 * 60 * 1000;
  const contextSince =
    Number.isFinite(sinceMs) && sinceMs > 0 ? new Date(Math.max(0, sinceMs - lookbackMs)).toISOString() : args.since;
  const db = new DatabaseSync(args.dbPath, { open: true, readOnly: true });

  const settingsRow = db
    .prepare("SELECT value FROM settings WHERE key = 'runtime_settings' LIMIT 1")
    .get() as { value?: string } | undefined;
  if (!settingsRow?.value) {
    throw new Error("runtime_settings not found in DB");
  }

  const runtimeSettings = normalizeSettings(parseJsonSafe(String(settingsRow.value || "")) || {});
  const actorSettings = ensureLlmSettings(runtimeSettings, args.actorProvider, args.actorModel);
  const judgeSettings = ensureLlmSettings(
    runtimeSettings,
    args.judgeProvider || args.actorProvider,
    args.judgeModel || args.actorModel
  );
  judgeSettings.llm = {
    ...(judgeSettings.llm || {}),
    temperature: 0,
    maxOutputTokens: 420
  };

  const messages = queryRows<MessageRow>(
    db,
    `
      SELECT
        message_id,
        created_at,
        guild_id,
        channel_id,
        author_id,
        author_name,
        is_bot,
        content,
        referenced_message_id
      FROM messages
      WHERE created_at >= ?
        AND (? = '' OR created_at <= ?)
        AND (? = '' OR channel_id = ?)
      ORDER BY created_at ASC
    `,
    [contextSince, args.until, args.until, args.channelId, args.channelId]
  );

  const maxTurnLimit = Math.max(0, args.maxTurns);
  const candidateMessages = messages.filter(
    (row) => Number(row.is_bot) !== 1 && String(row.created_at || "") >= args.since
  );
  const replayMessages = maxTurnLimit > 0 ? candidateMessages.slice(0, maxTurnLimit) : candidateMessages;

  const recordedDecisionRows = queryRows<ActionRow>(
    db,
    `
      SELECT id, created_at, channel_id, kind, content, metadata
      FROM actions
      WHERE created_at >= ?
        AND (? = '' OR created_at <= ?)
        AND (? = '' OR channel_id = ?)
        AND kind IN ('sent_reply','sent_message','reply_skipped')
        AND COALESCE(json_extract(metadata, '$.source'), '') LIKE 'message_event%'
      ORDER BY id ASC
    `,
    [contextSince, args.until, args.until, args.channelId, args.channelId]
  );

  const voiceIntentRows = queryRows<ActionRow>(
    db,
    `
      SELECT id, created_at, channel_id, kind, content, metadata, message_id
      FROM actions
      WHERE created_at >= ?
        AND (? = '' OR created_at <= ?)
        AND (? = '' OR channel_id = ?)
        AND kind = 'voice_intent_detected'
      ORDER BY id ASC
    `,
    [contextSince, args.until, args.until, args.channelId, args.channelId]
  );
  db.close();

  const botCounts = new Map<string, number>();
  for (const row of messages) {
    const authorId = String(row.author_id || "").trim();
    if (!authorId) continue;
    const current = botCounts.get(authorId) || 0;
    botCounts.set(authorId, current + (Number(row.is_bot) === 1 ? 1 : 0));
  }
  const sortedBotCandidates = [...botCounts.entries()].sort((a, b) => b[1] - a[1]);
  const botUserId = sortedBotCandidates[0]?.[0] || "";
  if (!botUserId) {
    throw new Error("could not resolve bot user id from messages table");
  }

  const initiativeChannelIds = new Set(
    Array.isArray(runtimeSettings?.permissions?.initiativeChannelIds)
      ? runtimeSettings.permissions.initiativeChannelIds.map((value: unknown) => String(value))
      : []
  );

  const decisionByTrigger = new Map<string, ActionRow>();
  for (const row of recordedDecisionRows) {
    const metadata = parseMetadataObject(row);
    const trigger = String(metadata.triggerMessageId || "").trim();
    if (!trigger) continue;
    decisionByTrigger.set(trigger, row);
  }

  const voiceIntentByMessage = new Map<string, ActionRow>();
  for (const row of voiceIntentRows) {
    const messageId = String(row.message_id || "");
    const metadata = parseMetadataObject(row);
    const inferredMessageId = String(metadata.messageId || "").trim();
    const key = messageId || inferredMessageId;
    if (!key) continue;
    voiceIntentByMessage.set(key, row);
  }

  const llmService = createLlmService();
  const historyByChannel = new Map<string, MessageRow[]>();
  const historyByMessageId = new Map<string, MessageRow>();
  const timeline: ReplayEvent[] = [];
  const turnSnapshots: TurnSnapshot[] = [];

  const initiativeStats = buildChannelStats("initiative");
  const nonInitiativeStats = buildChannelStats("non_initiative");

  for (const row of messages) {
    if (String(row.created_at || "") >= args.since) continue;
    const channelId = String(row.channel_id || "");
    if (!channelId) continue;
    const history = historyByChannel.get(channelId) || [];
    history.push(row);
    historyByChannel.set(channelId, history);
    historyByMessageId.set(String(row.message_id), row);
  }

  let syntheticBotCounter = 0;
  let processedTurns = 0;

  for (const message of replayMessages) {
    const channelId = String(message.channel_id || "");
    const createdAt = String(message.created_at || "");
    const channelMode = initiativeChannelIds.has(channelId) ? "initiative" : "non_initiative";
    const stats = channelMode === "initiative" ? initiativeStats : nonInitiativeStats;

    const history = historyByChannel.get(channelId) || [];
    history.push(message);
    historyByChannel.set(channelId, history);
    historyByMessageId.set(String(message.message_id), message);
    processedTurns += 1;

    stats.userTurns += 1;
    timeline.push({
      createdAt,
      channelId,
      role: "USER",
      authorName: String(message.author_name || "user"),
      content: String(message.content || "")
    });

    const addressSignal = buildAddressSignal({
      botUserId,
      botName: String(runtimeSettings.botName || "clanker conk"),
      message,
      recentById: historyByMessageId
    });
    const addressed = Boolean(addressSignal.triggered);
    if (addressed) stats.addressedTurns += 1;
    else stats.unaddressedTurns += 1;

    const recentMessages = toRecentMessagesDesc(history, Number(runtimeSettings?.memory?.maxRecentMessages) || 35);
    const attempted = shouldAttemptReplyDecision({
      botUserId,
      settings: runtimeSettings,
      recentMessages,
      addressSignal,
      forceRespond: false,
      triggerMessageId: message.message_id,
      windowSize: 5
    });

    if (attempted) {
      stats.attemptedTurns += 1;
      if (addressed) stats.attemptedAddressed += 1;
      else stats.attemptedUnaddressed += 1;
    }

    let decision: ReplayDecision;
    if (!attempted && args.mode === "live") {
      decision = {
        kind: "no_action",
        addressed,
        attempted: false,
        content: "",
        reason: "admission_not_attempted",
        voiceIntent: "",
        llmProvider: "",
        llmModel: "",
        llmCostUsd: 0
      };
    } else {
      if (args.mode === "recorded") {
        const recorded = decisionByTrigger.get(String(message.message_id));
        if (recorded) {
          if (recorded.kind === "reply_skipped") {
            decision = {
              kind: "reply_skipped",
              addressed,
              attempted: true,
              content: "llm_skip",
              reason: "recorded_reply_skipped",
              voiceIntent: "",
              llmProvider: "",
              llmModel: "",
              llmCostUsd: 0
            };
          } else {
            decision = {
              kind: recorded.kind === "sent_reply" ? "sent_reply" : "sent_message",
              addressed,
              attempted: true,
              content: String(recorded.content || ""),
              reason: "recorded_sent",
              voiceIntent: "",
              llmProvider: "",
              llmModel: "",
              llmCostUsd: 0
            };
          }
        } else {
          const voiceIntent = voiceIntentByMessage.get(String(message.message_id));
          if (voiceIntent) {
            decision = {
              kind: "voice_intent_detected",
              addressed,
              attempted: true,
              content: "",
              reason: "recorded_voice_intent",
              voiceIntent: String(voiceIntent.content || ""),
              llmProvider: "",
              llmModel: "",
              llmCostUsd: 0
            };
          } else {
            decision = {
              kind: "no_action",
              addressed,
              attempted: true,
              content: "",
              reason: "recorded_no_action",
              voiceIntent: "",
              llmProvider: "",
              llmModel: "",
              llmCostUsd: 0
            };
          }
        }
      } else {
        const replyEagerness = clamp(
          stableNumber(
            channelMode === "initiative"
              ? (runtimeSettings as { activity?: { replyLevelInitiative?: number } })?.activity?.replyLevelInitiative
              : (runtimeSettings as { activity?: { replyLevelNonInitiative?: number } })?.activity?.replyLevelNonInitiative,
            0
          ),
          0,
          100
        );
        const reactionEagerness = clamp(
          stableNumber((runtimeSettings as { activity?: { reactionLevel?: number } })?.activity?.reactionLevel, 20),
          0,
          100
        );

        try {
          decision = await runLiveActorDecision({
            llm: llmService,
            settings: actorSettings,
            botUserId,
            message,
            recentMessages,
            addressed,
            replyEagerness,
            reactionEagerness
          });
          stats.llmCalls += 1;
          stats.llmCostUsd += decision.llmCostUsd;
        } catch (error) {
          decision = {
            kind: "no_action",
            addressed,
            attempted: true,
            content: "",
            reason: `actor_error:${String((error as Error)?.message || error)}`,
            voiceIntent: "",
            llmProvider: "",
            llmModel: "",
            llmCostUsd: 0
          };
          stats.errorTurns += 1;
        }
      }
    }

    const snapshot: TurnSnapshot = {
      index: processedTurns,
      messageId: String(message.message_id || ""),
      createdAt,
      channelId,
      channelMode,
      authorName: String(message.author_name || "user"),
      userContent: String(message.content || ""),
      addressed,
      attempted: Boolean(decision.attempted),
      decisionKind: decision.kind,
      decisionReason: String(decision.reason || ""),
      botContent: "",
      llmProvider: String(decision.llmProvider || ""),
      llmModel: String(decision.llmModel || ""),
      llmCostUsd: stableNumber(decision.llmCostUsd, 0)
    };
    turnSnapshots.push(snapshot);

    if (decision.kind === "voice_intent_detected") {
      stats.voiceIntentTurns += 1;
      timeline.push({
        createdAt,
        channelId,
        role: "BOT_ACTION",
        authorName: String(runtimeSettings.botName || "clanker conk"),
        content: `[voice_intent:${decision.voiceIntent || "detected"}]`
      });
      continue;
    }

    if (decision.kind === "reply_skipped") {
      stats.skippedTurns += 1;
      if (addressed) stats.skippedAddressed += 1;
      else stats.skippedUnaddressed += 1;
      continue;
    }

    if (decision.kind === "no_action") {
      stats.noActionTurns += 1;
      continue;
    }

    stats.sentTurns += 1;
    if (addressed) stats.sentAddressed += 1;
    else stats.sentUnaddressed += 1;
    const botMessage: MessageRow = {
      message_id: `sim-bot-${++syntheticBotCounter}`,
      created_at: createdAt,
      guild_id: message.guild_id,
      channel_id: message.channel_id,
      author_id: botUserId,
      author_name: String(runtimeSettings.botName || "clanker conk"),
      is_bot: 1,
      content: String(decision.content || ""),
      referenced_message_id: null
    };
    history.push(botMessage);
    historyByChannel.set(channelId, history);
    historyByMessageId.set(botMessage.message_id, botMessage);
    snapshot.botContent = botMessage.content;
    timeline.push({
      createdAt,
      channelId,
      role: "BOT",
      authorName: String(runtimeSettings.botName || "clanker conk"),
      content: botMessage.content
    });
  }

  const windowTimeline = timeline.filter((event) => {
    if (!isoInWindow(event.createdAt, args.windowStart, args.windowEnd)) return false;
    if (args.channelId && event.channelId !== args.channelId) return false;
    return true;
  });
  const windowTurnSnapshots = turnSnapshots.filter((snapshot) => {
    if (!isoInWindow(snapshot.createdAt, args.windowStart, args.windowEnd)) return false;
    if (args.channelId && snapshot.channelId !== args.channelId) return false;
    return true;
  });

  let judgeResult: JudgeResult | null = null;
  if (args.mode === "live" && args.judge && args.windowStart && args.windowEnd) {
    try {
      judgeResult = await runJudge({
        llm: llmService,
        settings: judgeSettings,
        mode: args.mode,
        windowTimeline,
        nonInitiativeStats,
        initiativeStats,
        windowStart: args.windowStart,
        windowEnd: args.windowEnd
      });
    } catch (error) {
      judgeResult = {
        isFlooding: false,
        floodScore: 0,
        confidence: 0,
        summary: `judge_error: ${String((error as Error)?.message || error)}`,
        signals: [],
        rawText: ""
      };
    }
  }

  console.log("Flooding Replay Harness");
  console.log(`mode=${args.mode}`);
  console.log(`db=${args.dbPath}`);
  console.log(`contextSince=${contextSince}`);
  console.log(`since=${args.since}`);
  if (args.until) console.log(`until=${args.until}`);
  if (args.channelId) console.log(`channelId=${args.channelId}`);
  console.log(`processedUserTurns=${processedTurns}`);
  console.log(`botUserId=${botUserId}`);
  console.log(`initiativeChannelIds=[${[...initiativeChannelIds].join(", ")}]`);
  console.log("");

  printStats("initiative", initiativeStats);
  console.log("");
  printStats("non_initiative", nonInitiativeStats);
  console.log("");

  if (windowTimeline.length) {
    console.log(`windowTimeline events=${windowTimeline.length} (${args.windowStart} -> ${args.windowEnd})`);
    for (const event of windowTimeline.slice(0, 32)) {
      console.log(`${event.createdAt} | ${event.channelId} | ${event.role} | ${event.authorName}: ${event.content}`);
    }
    if (windowTimeline.length > 32) {
      console.log(`... truncated ${windowTimeline.length - 32} more window events`);
    }
    console.log("");
  }

  if (windowTurnSnapshots.length) {
    printTurnSnapshots(windowTurnSnapshots, args.snapshotsLimit);
    console.log("");
  }

  if (judgeResult) {
    console.log("judge verdict");
    console.log(`  isFlooding=${judgeResult.isFlooding}`);
    console.log(`  floodScore=${judgeResult.floodScore}`);
    console.log(`  confidence=${judgeResult.confidence.toFixed(2)}`);
    if (judgeResult.summary) console.log(`  summary=${judgeResult.summary}`);
    if (judgeResult.signals.length) {
      for (const signal of judgeResult.signals) {
        console.log(`  signal=${signal}`);
      }
    }
    console.log("");
  }

  const assertionFailures = evaluateAssertions({
    args,
    nonInitiativeStats,
    initiativeStats
  });
  if (assertionFailures.length) {
    console.log("assertions failed");
    for (const failure of assertionFailures) {
      console.log(`  ${failure}`);
    }
    console.log("");
  } else {
    console.log("assertions passed");
    console.log("");
  }

  if (args.outJsonPath) {
    const fs = await import("node:fs/promises");
    const payload = {
      args,
      processedUserTurns: processedTurns,
      botUserId,
      initiativeChannelIds: [...initiativeChannelIds],
      stats: {
        initiative: initiativeStats,
        nonInitiative: nonInitiativeStats
      },
      windowTimeline,
      windowTurnSnapshots,
      judge: judgeResult
      ,
      assertions: {
        passed: assertionFailures.length === 0,
        failures: assertionFailures
      }
    };
    await fs.writeFile(args.outJsonPath, JSON.stringify(payload, null, 2), "utf8");
    console.log(`wrote json report -> ${args.outJsonPath}`);
  }

  if (assertionFailures.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("flooding replay harness failed:", error);
  process.exit(1);
});
