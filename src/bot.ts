import {
  Client,
  GatewayIntentBits,
  Partials
} from "discord.js";
import {
  buildAutomationPrompt,
  buildInitiativePrompt,
  buildReplyPrompt,
  buildSystemPrompt
} from "./prompts.ts";
import { getMediaPromptCraftGuidance } from "./promptCore.ts";
import {
  MAX_GIF_QUERY_LEN,
  MAX_IMAGE_LOOKUP_QUERY_LEN,
  MAX_VIDEO_FALLBACK_MESSAGES,
  MAX_VIDEO_TARGET_SCAN,
  collectMemoryFactHints,
  composeInitiativeImagePrompt,
  composeInitiativeVideoPrompt,
  composeReplyImagePrompt,
  composeReplyVideoPrompt,
  embedWebSearchSources,
  emptyMentionResolution,
  extractRecentVideoTargets,
  extractUrlsFromText,
  formatReactionSummary,
  isWebSearchOptOutText,
  looksLikeVideoFollowupMessage,
  normalizeDirectiveText,
  normalizeReactionEmojiToken,
  normalizeSkipSentinel,
  parseInitiativeMediaDirective,
  parseStructuredReplyOutput,
  pickInitiativeMediaDirective,
  pickReplyMediaDirective,
  resolveMaxMediaPromptLen
} from "./botHelpers.ts";
import {
  getLocalTimeZoneLabel,
  resolveFollowingNextRunAt
} from "./automation.ts";
import { normalizeDiscoveryUrl } from "./discovery.ts";
import { chance, clamp, sanitizeBotText, sleep } from "./utils.ts";
import {
  applyAutomationControlAction,
  composeAutomationControlReply,
  formatAutomationListLine,
  resolveAutomationTargetsForControl
} from "./bot/automationControl.ts";
import {
  createAutomationControlRuntime,
  createMentionResolutionRuntime,
  createReplyAdmissionRuntime,
  createReplyFollowupRuntime,
  createStartupCatchupRuntime,
  createVoiceReplyRuntime
} from "./bot/runtimeContexts.ts";
import {
  buildMentionAliasIndex as buildMentionAliasIndexForMentions,
  lookupGuildMembersByExactName as lookupGuildMembersByExactNameForMentions,
  resolveDeterministicMentions as resolveDeterministicMentionsForMentions
} from "./bot/mentions.ts";
import {
  maybeRegenerateWithMemoryLookup as maybeRegenerateWithMemoryLookupForReplyFollowup,
  resolveReplyFollowupGenerationSettings as resolveReplyFollowupGenerationSettingsForReplyFollowup,
  runModelRequestedMemoryLookup as runModelRequestedMemoryLookupForReplyFollowup,
  runModelRequestedWebSearch as runModelRequestedWebSearchForReplyFollowup
} from "./bot/replyFollowup.ts";
import {
  getReplyAddressSignal as getReplyAddressSignalForReplyAdmission,
  hasBotMessageInRecentWindow as hasBotMessageInRecentWindowForReplyAdmission,
  hasStartupFollowupAfterMessage as hasStartupFollowupAfterMessageForReplyAdmission,
  shouldAttemptReplyDecision as shouldAttemptReplyDecisionForReplyAdmission
} from "./bot/replyAdmission.ts";
import { runStartupCatchup as runStartupCatchupForStartupCatchup } from "./bot/startupCatchup.ts";
import {
  composeVoiceOperationalMessage,
  generateVoiceTurnReply
} from "./bot/voiceReplies.ts";
import {
  dequeueReplyBurst,
  dequeueReplyJob,
  ensureGatewayHealthy,
  getReplyCoalesceMaxMessages,
  getReplyCoalesceWaitMs,
  getReplyCoalesceWindowMs,
  getReplyQueueWaitMs,
  processReplyQueue,
  reconnectGateway,
  requeueReplyJobs,
  scheduleReconnect
} from "./bot/queueGateway.ts";
import {
  evaluateInitiativeSchedule,
  evaluateSpontaneousInitiativeSchedule,
  getInitiativeAverageIntervalMs,
  getInitiativeMinGapMs,
  getInitiativePacingMode,
  getInitiativePostingIntervalMs,
  pickInitiativeChannel
} from "./bot/initiativeSchedule.ts";
import { VoiceSessionManager } from "./voice/voiceSessionManager.ts";

const UNICODE_REACTIONS = ["🔥", "💀", "😂", "👀", "🤝", "🫡", "😮", "🧠", "💯", "😭"];
const REPLY_QUEUE_MAX_PER_CHANNEL = 60;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i;
const MAX_IMAGE_INPUTS = 3;
const STARTUP_TASK_DELAY_MS = 4500;
const INITIATIVE_TICK_MS = 60_000;
const AUTOMATION_TICK_MS = 30_000;
const GATEWAY_WATCHDOG_TICK_MS = 30_000;
const MAX_MODEL_IMAGE_INPUTS = 8;
const MAX_HISTORY_IMAGE_CANDIDATES = 24;
const MAX_HISTORY_IMAGE_LOOKUP_RESULTS = 6;
const MAX_IMAGE_LOOKUP_QUERY_TOKENS = 7;
const UNSOLICITED_REPLY_CONTEXT_WINDOW = 5;
const MAX_AUTOMATION_RUNS_PER_TICK = 4;
const SCREEN_SHARE_MESSAGE_MAX_CHARS = 420;
const SCREEN_SHARE_INTENT_THRESHOLD = 0.66;
const REPLY_PERFORMANCE_VERSION = 1;
const IS_NODE_TEST_PROCESS = Boolean(process.env.NODE_TEST_CONTEXT) ||
  process.execArgv.includes("--test") ||
  process.argv.includes("--test");
const SCREEN_SHARE_EXPLICIT_REQUEST_RE =
  /\b(?:screen\s*share|share\s*(?:my|the)?\s*screen|watch\s*(?:my|the)?\s*screen|see\s*(?:my|the)?\s*screen|look\s*at\s*(?:my|the)?\s*screen|look\s*at\s*(?:my|the)?\s*stream|watch\s*(?:my|the)?\s*stream)\b/i;

export class ClankerBot {
  appConfig;
  store;
  llm;
  memory;
  discovery;
  search;
  gifs;
  video;
  lastBotMessageAt;
  memoryTimer;
  initiativeTimer;
  automationTimer;
  gatewayWatchdogTimer;
  reconnectTimeout;
  startupTasksRan;
  startupTimeout;
  initiativePosting;
  automationCycleRunning;
  reconnectInFlight;
  isStopping;
  hasConnectedAtLeastOnce;
  lastGatewayEventAt;
  reconnectAttempts;
  replyQueues;
  replyQueueWorkers;
  replyQueuedMessageIds;
  screenShareSessionManager;
  client;
  voiceSessionManager;

  constructor({ appConfig, store, llm, memory, discovery, search, gifs, video }) {
    this.appConfig = appConfig;
    this.store = store;
    this.llm = llm;
    this.memory = memory;
    this.discovery = discovery;
    this.search = search;
    this.gifs = gifs;
    this.video = video;

    this.lastBotMessageAt = 0;
    this.memoryTimer = null;
    this.initiativeTimer = null;
    this.automationTimer = null;
    this.gatewayWatchdogTimer = null;
    this.reconnectTimeout = null;
    this.startupTasksRan = false;
    this.startupTimeout = null;
    this.initiativePosting = false;
    this.automationCycleRunning = false;
    this.reconnectInFlight = false;
    this.isStopping = false;
    this.hasConnectedAtLeastOnce = false;
    this.lastGatewayEventAt = Date.now();
    this.reconnectAttempts = 0;
    this.replyQueues = new Map();
    this.replyQueueWorkers = new Set();
    this.replyQueuedMessageIds = new Set();
    this.screenShareSessionManager = null;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction]
    });
    this.voiceSessionManager = new VoiceSessionManager({
      client: this.client,
      store: this.store,
      appConfig: this.appConfig,
      llm: this.llm,
      memory: this.memory,
      composeOperationalMessage: (payload) => this.composeVoiceOperationalMessage(payload),
      generateVoiceTurn: (payload) => this.generateVoiceTurnReply(payload)
    });

    this.registerEvents();
  }

  attachScreenShareSessionManager(manager) {
    this.screenShareSessionManager = manager || null;
  }

  registerEvents() {
    this.client.on("clientReady", () => {
      this.hasConnectedAtLeastOnce = true;
      this.reconnectAttempts = 0;
      this.markGatewayEvent();
      console.log(`Logged in as ${this.client.user?.tag || "unknown"}`);
    });

    this.client.on("shardResume", () => {
      this.markGatewayEvent();
    });

    this.client.on("shardDisconnect", (event, shardId) => {
      this.markGatewayEvent();
      this.store.logAction({
        kind: "bot_error",
        userId: this.client.user?.id,
        content: `gateway_shard_disconnect: shard=${shardId} code=${event?.code ?? "unknown"}`
      });
    });

    this.client.on("shardError", (error, shardId) => {
      this.markGatewayEvent();
      this.store.logAction({
        kind: "bot_error",
        userId: this.client.user?.id,
        content: `gateway_shard_error: shard=${shardId} ${String(error?.message || error)}`
      });
    });

    this.client.on("error", (error) => {
      this.markGatewayEvent();
      this.store.logAction({
        kind: "bot_error",
        userId: this.client.user?.id,
        content: `gateway_error: ${String(error?.message || error)}`
      });
    });

    this.client.on("invalidated", () => {
      this.markGatewayEvent();
      this.store.logAction({
        kind: "bot_error",
        userId: this.client.user?.id,
        content: "gateway_session_invalidated"
      });
      this.scheduleReconnect("session_invalidated", 2_000);
    });

    this.client.on("messageCreate", async (message) => {
      try {
        await this.handleMessage(message);
      } catch (error) {
        this.store.logAction({
          kind: "bot_error",
          guildId: message.guildId,
          channelId: message.channelId,
          messageId: message.id,
          userId: message.author?.id,
          content: String(error?.message || error)
        });
      }
    });

    this.client.on("messageReactionAdd", async (reaction) => {
      try {
        await this.syncMessageSnapshotFromReaction(reaction);
      } catch (error) {
        this.store.logAction({
          kind: "bot_error",
          guildId: reaction?.message?.guildId,
          channelId: reaction?.message?.channelId,
          messageId: reaction?.message?.id,
          userId: this.client.user?.id,
          content: `reaction_sync_add: ${String(error?.message || error)}`
        });
      }
    });

    this.client.on("messageReactionRemove", async (reaction) => {
      try {
        await this.syncMessageSnapshotFromReaction(reaction);
      } catch (error) {
        this.store.logAction({
          kind: "bot_error",
          guildId: reaction?.message?.guildId,
          channelId: reaction?.message?.channelId,
          messageId: reaction?.message?.id,
          userId: this.client.user?.id,
          content: `reaction_sync_remove: ${String(error?.message || error)}`
        });
      }
    });

    this.client.on("messageReactionRemoveAll", async (message) => {
      try {
        await this.syncMessageSnapshot(message);
      } catch (error) {
        this.store.logAction({
          kind: "bot_error",
          guildId: message?.guildId,
          channelId: message?.channelId,
          messageId: message?.id,
          userId: this.client.user?.id,
          content: `reaction_sync_remove_all: ${String(error?.message || error)}`
        });
      }
    });

    this.client.on("messageReactionRemoveEmoji", async (reaction) => {
      try {
        await this.syncMessageSnapshotFromReaction(reaction);
      } catch (error) {
        this.store.logAction({
          kind: "bot_error",
          guildId: reaction?.message?.guildId,
          channelId: reaction?.message?.channelId,
          messageId: reaction?.message?.id,
          userId: this.client.user?.id,
          content: `reaction_sync_remove_emoji: ${String(error?.message || error)}`
        });
      }
    });
  }

  async start() {
    this.isStopping = false;
    await this.client.login(this.appConfig.discordToken);
    this.markGatewayEvent();

    this.memoryTimer = setInterval(() => {
      this.memory.refreshMemoryMarkdown().catch(() => undefined);
    }, 5 * 60_000);

    this.initiativeTimer = setInterval(() => {
      this.maybeRunInitiativeCycle().catch((error) => {
        this.store.logAction({
          kind: "bot_error",
          content: `initiative_cycle: ${String(error?.message || error)}`
        });
      });
    }, INITIATIVE_TICK_MS);
    this.automationTimer = setInterval(() => {
      this.maybeRunAutomationCycle().catch((error) => {
        this.store.logAction({
          kind: "bot_error",
          content: `automation_cycle: ${String(error?.message || error)}`
        });
      });
    }, AUTOMATION_TICK_MS);
    this.gatewayWatchdogTimer = setInterval(() => {
      this.ensureGatewayHealthy().catch((error) => {
        this.store.logAction({
          kind: "bot_error",
          userId: this.client.user?.id,
          content: `gateway_watchdog: ${String(error?.message || error)}`
        });
      });
    }, GATEWAY_WATCHDOG_TICK_MS);

    this.startupTimeout = setTimeout(() => {
      if (this.isStopping) return;
      this.runStartupTasks().catch((error) => {
        this.store.logAction({
          kind: "bot_error",
          content: `startup_tasks: ${String(error?.message || error)}`
        });
      });
    }, STARTUP_TASK_DELAY_MS);
  }

  async stop() {
    this.isStopping = true;
    if (this.startupTimeout) clearTimeout(this.startupTimeout);
    if (this.memoryTimer) clearInterval(this.memoryTimer);
    if (this.initiativeTimer) clearInterval(this.initiativeTimer);
    if (this.automationTimer) clearInterval(this.automationTimer);
    if (this.gatewayWatchdogTimer) clearInterval(this.gatewayWatchdogTimer);
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.gatewayWatchdogTimer = null;
    this.automationTimer = null;
    this.reconnectTimeout = null;
    this.startupTimeout = null;
    this.replyQueues.clear();
    this.replyQueueWorkers.clear();
    this.replyQueuedMessageIds.clear();
    if (this.memory?.drainIngestQueue) {
      await this.memory.drainIngestQueue({ timeoutMs: 4000 }).catch(() => undefined);
    }
    await this.voiceSessionManager.dispose("shutdown");
    await this.client.destroy();
  }

  getRuntimeState() {
    return {
      isReady: this.client.isReady(),
      userTag: this.client.user?.tag ?? null,
      guildCount: this.client.guilds.cache.size,
      lastBotMessageAt: this.lastBotMessageAt ? new Date(this.lastBotMessageAt).toISOString() : null,
      replyQueue: {
        channels: this.replyQueues.size,
        pending: this.getReplyQueuePendingCount()
      },
      gateway: {
        hasConnectedAtLeastOnce: this.hasConnectedAtLeastOnce,
        reconnectInFlight: this.reconnectInFlight,
        reconnectAttempts: this.reconnectAttempts,
        lastGatewayEventAt: this.lastGatewayEventAt
          ? new Date(this.lastGatewayEventAt).toISOString()
          : null
      },
      voice: this.voiceSessionManager.getRuntimeState()
    };
  }

  getGuilds() {
    return [...this.client.guilds.cache.values()].map((g) => ({ id: g.id, name: g.name }));
  }

  async applyRuntimeSettings(nextSettings = null) {
    const settings = nextSettings || this.store.getSettings();
    await this.voiceSessionManager.reconcileSettings(settings);
  }

  async ingestVoiceStreamFrame({
    guildId,
    streamerUserId = null,
    mimeType = "image/jpeg",
    dataBase64 = "",
    source = "api_stream_ingest"
  }) {
    const settings = this.store.getSettings();
    return await this.voiceSessionManager.ingestStreamFrame({
      guildId,
      streamerUserId,
      mimeType,
      dataBase64,
      source,
      settings
    });
  }

  markGatewayEvent() {
    this.lastGatewayEventAt = Date.now();
  }

  getReplyQueuePendingCount() {
    let total = 0;
    for (const queue of this.replyQueues.values()) {
      total += queue.length;
    }
    return total;
  }

  enqueueReplyJob({
    message,
    source,
    forceRespond = false,
    addressSignal = null,
    performanceSeed = null
  }) {
    if (!message?.id || !message?.channelId) return false;

    const messageId = String(message.id);
    if (!messageId) return false;
    if (this.replyQueuedMessageIds.has(messageId)) return false;
    if (this.store.hasTriggeredResponse(messageId)) return false;

    const channelId = String(message.channelId);
    const queue = this.replyQueues.get(channelId) || [];
    if (queue.length >= REPLY_QUEUE_MAX_PER_CHANNEL) {
      this.store.logAction({
        kind: "bot_error",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId,
        userId: message.author?.id || null,
        content: `reply_queue_overflow: limit=${REPLY_QUEUE_MAX_PER_CHANNEL}`
      });
      return false;
    }

    queue.push({
      message,
      source: source || "message_event",
      forceRespond: Boolean(forceRespond),
      addressSignal,
      performanceSeed: normalizeReplyPerformanceSeed({
        triggerMessageCreatedAtMs: message?.createdTimestamp,
        queuedAtMs: Date.now(),
        ingestMs: performanceSeed?.ingestMs
      }),
      attempts: 0
    });
    this.replyQueues.set(channelId, queue);
    this.replyQueuedMessageIds.add(messageId);

    this.processReplyQueue(channelId).catch((error) => {
      this.store.logAction({
        kind: "bot_error",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId,
        userId: message.author?.id || null,
        content: `reply_queue_worker: ${String(error?.message || error)}`
      });
    });

    return true;
  }

  getReplyQueueWaitMs(settings) {
    return getReplyQueueWaitMs(this, settings);
  }

  getReplyCoalesceWindowMs(settings) {
    return getReplyCoalesceWindowMs(settings);
  }

  getReplyCoalesceMaxMessages(settings) {
    return getReplyCoalesceMaxMessages(settings);
  }

  getReplyCoalesceWaitMs(settings, message) {
    return getReplyCoalesceWaitMs(settings, message);
  }

  dequeueReplyJob(channelId) {
    return dequeueReplyJob(this, channelId);
  }

  dequeueReplyBurst(channelId, settings) {
    return dequeueReplyBurst(this, channelId, settings);
  }

  requeueReplyJobs(channelId, jobs) {
    return requeueReplyJobs(this, channelId, jobs);
  }

  async processReplyQueue(channelId) {
    return await processReplyQueue(this, channelId);
  }

  async ensureGatewayHealthy() {
    return await ensureGatewayHealthy(this);
  }

  scheduleReconnect(reason, delayMs) {
    return scheduleReconnect(this, reason, delayMs);
  }

  async reconnectGateway(reason) {
    return await reconnectGateway(this, reason);
  }

  async handleMessage(message) {
    if (!message.guild || !message.channel || !message.author) return;

    const settings = this.store.getSettings();

    const text = String(message.content || "").trim();
    const recordedContent = this.composeMessageContentForHistory(message, text);
    this.store.recordMessage({
      messageId: message.id,
      createdAt: message.createdTimestamp,
      guildId: message.guildId,
      channelId: message.channelId,
      authorId: message.author.id,
      authorName: message.member?.displayName || message.author.username,
      isBot: message.author.bot,
      content: recordedContent,
      referencedMessageId: message.reference?.messageId
    });

    if (String(message.author.id) === String(this.client.user?.id || "")) return;
    if (!this.isChannelAllowed(settings, message.channelId)) return;
    if (this.isUserBlocked(settings, message.author.id)) return;

    if (settings.memory.enabled) {
      void this.memory.ingestMessage({
        messageId: message.id,
        authorId: message.author.id,
        authorName: message.member?.displayName || message.author.username,
        content: text,
        settings,
        trace: {
          guildId: message.guildId,
          channelId: message.channelId,
          userId: message.author.id
        }
      }).catch((error) => {
        this.store.logAction({
          kind: "bot_error",
          guildId: message.guildId,
          channelId: message.channelId,
          messageId: message.id,
          userId: message.author.id,
          content: `memory_ingest: ${String(error?.message || error)}`
        });
      });
    }

    const recentMessages = this.store.getRecentMessages(
      message.channelId,
      settings.memory.maxRecentMessages
    );
    const addressSignal = this.getReplyAddressSignal(settings, message, recentMessages);

    const shouldQueueReply = this.shouldAttemptReplyDecision({
      settings,
      recentMessages,
      addressSignal,
      forceRespond: false,
      triggerMessageId: message.id
    });
    if (!shouldQueueReply) return;
    this.enqueueReplyJob({
      source: "message_event",
      message,
      forceRespond: addressSignal.triggered,
      addressSignal
    });
  }

  async composeVoiceOperationalMessage({
    settings,
    guildId = null,
    channelId = null,
    userId = null,
    messageId = null,
    event = "voice_runtime",
    reason = null,
    details = {},
    maxOutputChars = 180,
    allowSkip = false
  }) {
    const runtime = createVoiceReplyRuntime(this);
    return await composeVoiceOperationalMessage(runtime, {
      settings,
      guildId,
      channelId,
      userId,
      messageId,
      event,
      reason,
      details,
      maxOutputChars,
      allowSkip
    });
  }

  async generateVoiceTurnReply({
    settings,
    guildId = null,
    channelId = null,
    userId = null,
    transcript = "",
    contextMessages = [],
    sessionId = null,
    isEagerTurn = false,
    voiceEagerness = 0,
    soundboardCandidates = [],
    onWebLookupStart = null,
    onWebLookupComplete = null,
    webSearchTimeoutMs = null
  }) {
    const runtime = createVoiceReplyRuntime(this);
    return await generateVoiceTurnReply(runtime, {
      settings,
      guildId,
      channelId,
      userId,
      transcript,
      contextMessages,
      sessionId,
      isEagerTurn,
      voiceEagerness,
      soundboardCandidates,
      onWebLookupStart,
      onWebLookupComplete,
      webSearchTimeoutMs
    });
  }

  shouldSendAsReply({ isInitiativeChannel = false, shouldThreadReply = false } = {}) {
    if (!shouldThreadReply) return false;
    if (!isInitiativeChannel) return true;
    return chance(0.65);
  }

  shouldSkipSimulatedTypingDelay() {
    if (this.appConfig?.disableSimulatedTypingDelay === true) return true;
    return IS_NODE_TEST_PROCESS;
  }

  getSimulatedTypingDelayMs(minMs, jitterMs) {
    if (this.shouldSkipSimulatedTypingDelay()) return 0;
    return minMs + Math.floor(Math.random() * jitterMs);
  }

  async maybeReplyToMessage(message, settings, options = {}) {
    if (!settings.permissions.allowReplies) return false;
    if (!this.canSendMessage(settings.permissions.maxMessagesPerHour)) return false;
    if (!this.canTalkNow(settings)) return false;

    const recentMessages = Array.isArray(options.recentMessages)
      ? options.recentMessages
      : this.store.getRecentMessages(message.channelId, settings.memory.maxRecentMessages);
    const addressSignal =
      options.addressSignal || this.getReplyAddressSignal(settings, message, recentMessages);
    const triggerMessageIds = [
      ...new Set(
        [...(Array.isArray(options.triggerMessageIds) ? options.triggerMessageIds : []), message.id]
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      )
    ];
    const addressed = addressSignal.triggered;
    const reactionEagerness = clamp(Number(settings.activity?.reactionLevel) || 0, 0, 100);
    const isInitiativeChannel = this.isInitiativeChannel(settings, message.channelId);
    const replyEagerness = clamp(
      Number(
        isInitiativeChannel
          ? settings.activity?.replyLevelInitiative
          : settings.activity?.replyLevelNonInitiative
      ) || 0,
      0,
      100
    );
    const reactionEmojiOptions = [
      ...new Set([...this.getReactionEmojiOptions(message.guild), ...UNICODE_REACTIONS])
    ];

    const shouldRunDecisionLoop = this.shouldAttemptReplyDecision({
      settings,
      recentMessages,
      addressSignal,
      forceRespond: Boolean(options.forceRespond),
      triggerMessageId: message.id
    });
    if (!shouldRunDecisionLoop) return false;

    const source = String(options.source || "message_event");
    const performance = createReplyPerformanceTracker({
      messageCreatedAtMs: message?.createdTimestamp,
      source,
      seed: options.performanceSeed
    });

    const memorySliceStartedAtMs = Date.now();
    const memorySlice = await this.loadPromptMemorySlice({
      settings,
      userId: message.author.id,
      guildId: message.guildId,
      channelId: message.channelId,
      queryText: message.content,
      trace: {
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id
      },
      source
    });
    performance.memorySliceMs = Math.max(0, Date.now() - memorySliceStartedAtMs);
    const replyMediaMemoryFacts = this.buildMediaMemoryFacts({
      userFacts: memorySlice.userFacts,
      relevantFacts: memorySlice.relevantFacts
    });
    const attachmentImageInputs = this.getImageInputs(message);
    const imageBudget = this.getImageBudgetState(settings);
    const videoBudget = this.getVideoGenerationBudgetState(settings);
    const mediaCapabilities = this.getMediaGenerationCapabilities(settings);
    const simpleImageCapabilityReady = mediaCapabilities.simpleImageReady;
    const complexImageCapabilityReady = mediaCapabilities.complexImageReady;
    const imageCapabilityReady = simpleImageCapabilityReady || complexImageCapabilityReady;
    const videoCapabilityReady = mediaCapabilities.videoReady;
    const gifBudget = this.getGifBudgetState(settings);
    const gifsConfigured = Boolean(this.gifs?.isConfigured?.());
    let webSearch = this.buildWebSearchContext(settings, message.content);
    let memoryLookup = this.buildMemoryLookupContext({ settings });
    const videoContext = await this.buildVideoReplyContext({
      settings,
      message,
      recentMessages,
      trace: {
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        source
      }
    });
    let modelImageInputs = [...attachmentImageInputs, ...(videoContext.frameImages || [])].slice(0, MAX_MODEL_IMAGE_INPUTS);
    let imageLookup = this.buildImageLookupContext({
      recentMessages,
      excludedUrls: modelImageInputs.map((image) => String(image?.url || "").trim())
    });
    const replyTrace = {
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id
    };
    const screenShareCapability = this.screenShareSessionManager?.getLinkCapability?.() || {
      enabled: false,
      status: "disabled",
      publicUrl: ""
    };

    const systemPrompt = buildSystemPrompt(settings);
    const replyPromptBase = {
      message: {
        authorName: message.member?.displayName || message.author.username,
        content: message.content
      },
      recentMessages,
      relevantMessages: memorySlice.relevantMessages,
      userFacts: memorySlice.userFacts,
      relevantFacts: memorySlice.relevantFacts,
      emojiHints: this.getEmojiHints(message.guild),
      reactionEmojiOptions,
      allowReplySimpleImages:
        settings.initiative.allowReplyImages && simpleImageCapabilityReady && imageBudget.canGenerate,
      allowReplyComplexImages:
        settings.initiative.allowReplyImages && complexImageCapabilityReady && imageBudget.canGenerate,
      remainingReplyImages: imageBudget.remaining,
      allowReplyVideos:
        settings.initiative.allowReplyVideos && videoCapabilityReady && videoBudget.canGenerate,
      remainingReplyVideos: videoBudget.remaining,
      allowReplyGifs: settings.initiative.allowReplyGifs && gifsConfigured && gifBudget.canFetch,
      remainingReplyGifs: gifBudget.remaining,
      gifRepliesEnabled: settings.initiative.allowReplyGifs,
      gifsConfigured,
      replyEagerness,
      reactionEagerness,
      addressing: {
        directlyAddressed: addressed,
        responseRequired: Boolean(options.forceRespond)
      },
      allowMemoryDirective: settings.memory.enabled,
      allowAutomationDirective: true,
      automationTimeZoneLabel: getLocalTimeZoneLabel(),
      voiceMode: {
        enabled: Boolean(settings?.voice?.enabled)
      },
      screenShare: screenShareCapability,
      videoContext,
      channelMode: isInitiativeChannel ? "initiative" : "non_initiative",
      maxMediaPromptChars: resolveMaxMediaPromptLen(settings),
      mediaPromptCraftGuidance: getMediaPromptCraftGuidance(settings)
    };
    const initialUserPrompt = buildReplyPrompt({
      ...replyPromptBase,
      imageInputs: modelImageInputs,
      webSearch,
      memoryLookup,
      imageLookup,
      allowWebSearchDirective: true,
      allowMemoryLookupDirective: true,
      allowImageLookupDirective: true
    });

    const llm1StartedAtMs = Date.now();
    let generation = await this.llm.generate({
      settings,
      systemPrompt,
      userPrompt: initialUserPrompt,
      imageInputs: modelImageInputs,
      trace: replyTrace
    });
    performance.llm1Ms = Math.max(0, Date.now() - llm1StartedAtMs);
    let usedWebSearchFollowup = false;
    let usedMemoryLookupFollowup = false;
    let usedImageLookupFollowup = false;
    const followupGenerationSettings = this.resolveReplyFollowupGenerationSettings(settings);
    const mediaPromptLimit = resolveMaxMediaPromptLen(settings);
    let replyDirective = parseStructuredReplyOutput(generation.text, mediaPromptLimit);
    let voiceIntentHandled = await this.maybeHandleStructuredVoiceIntent({
      message,
      settings,
      replyDirective
    });
    if (voiceIntentHandled) return true;

    const automationIntentHandled = await this.maybeHandleStructuredAutomationIntent({
      message,
      settings,
      replyDirective,
      generation,
      source,
      triggerMessageIds,
      addressing: addressSignal,
      performance
    });
    if (automationIntentHandled) return true;

    const followupStartedAtMs = Date.now();
    if (replyDirective.webSearchQuery) {
      usedWebSearchFollowup = true;
      webSearch = await this.runModelRequestedWebSearch({
        settings,
        webSearch,
        query: replyDirective.webSearchQuery,
        trace: {
          ...replyTrace,
          source
        }
      });
    }

    if (usedWebSearchFollowup || replyDirective.memoryLookupQuery || replyDirective.imageLookupQuery) {
      const followup = await this.maybeRegenerateWithMemoryLookup({
        settings,
        followupSettings: followupGenerationSettings,
        systemPrompt,
        generation,
        directive: replyDirective,
        memoryLookup,
        imageLookup,
        guildId: message.guildId,
        channelId: message.channelId,
        trace: {
          ...replyTrace,
          source,
          event: "reply_followup"
        },
        mediaPromptLimit,
        imageInputs: modelImageInputs,
        forceRegenerate: usedWebSearchFollowup,
        buildUserPrompt: ({
          memoryLookup: nextMemoryLookup,
          imageLookup: nextImageLookup,
          imageInputs: nextImageInputs,
          allowMemoryLookupDirective,
          allowImageLookupDirective
        }) =>
          buildReplyPrompt({
            ...replyPromptBase,
            imageInputs: nextImageInputs,
            webSearch,
            memoryLookup: nextMemoryLookup,
            imageLookup: nextImageLookup,
            allowWebSearchDirective: false,
            allowMemoryLookupDirective,
            allowImageLookupDirective
          })
      });
      generation = followup.generation;
      replyDirective = followup.directive;
      memoryLookup = followup.memoryLookup;
      imageLookup = followup.imageLookup;
      modelImageInputs = followup.imageInputs;
      usedMemoryLookupFollowup = followup.usedMemoryLookup;
      usedImageLookupFollowup = followup.usedImageLookup;

      voiceIntentHandled = await this.maybeHandleStructuredVoiceIntent({
        message,
        settings,
        replyDirective
      });
      if (voiceIntentHandled) return true;

      const followupAutomationHandled = await this.maybeHandleStructuredAutomationIntent({
        message,
        settings,
        replyDirective,
        generation,
        source,
        triggerMessageIds,
        addressing: addressSignal,
        performance
      });
      if (followupAutomationHandled) return true;
    }
    if (usedWebSearchFollowup || usedMemoryLookupFollowup || usedImageLookupFollowup) {
      performance.followupMs = Math.max(0, Date.now() - followupStartedAtMs);
    }

    const reaction = await this.maybeApplyReplyReaction({
      message,
      settings,
      emojiOptions: reactionEmojiOptions,
      emojiToken: replyDirective.reactionEmoji,
      generation,
      source,
      triggerMessageId: message.id,
      triggerMessageIds,
      addressing: addressSignal
    });

    const memoryLine = replyDirective.memoryLine;
    const selfMemoryLine = replyDirective.selfMemoryLine;
    let memorySaved = false;
    let selfMemorySaved = false;
    if (settings.memory.enabled && memoryLine) {
      try {
        memorySaved = await this.memory.rememberDirectiveLine({
          line: memoryLine,
          sourceMessageId: message.id,
          userId: message.author.id,
          guildId: message.guildId,
          channelId: message.channelId,
          sourceText: message.content,
          scope: "lore"
        });
      } catch (error) {
        this.store.logAction({
          kind: "bot_error",
          guildId: message.guildId,
          channelId: message.channelId,
          messageId: message.id,
          userId: message.author.id,
          content: `memory_directive: ${String(error?.message || error)}`
        });
      }
    }

    const mediaDirective = pickReplyMediaDirective(replyDirective);
    let finalText = sanitizeBotText(replyDirective.text || "");
    let mentionResolution = emptyMentionResolution();
    finalText = normalizeSkipSentinel(finalText);
    const screenShareOffer = await this.maybeHandleScreenShareOfferIntent({
      message,
      replyDirective,
      source
    });
    if (screenShareOffer.appendText) {
      const textParts = [];
      if (finalText && finalText !== "[SKIP]") textParts.push(finalText);
      textParts.push(screenShareOffer.appendText);
      finalText = sanitizeBotText(textParts.join("\n"), 1700);
    }
    const allowMediaOnlyReply = !finalText && Boolean(mediaDirective);
    const modelProducedSkip = finalText === "[SKIP]";
    const modelProducedEmpty = !finalText;
    if (modelProducedEmpty && !allowMediaOnlyReply) {
      this.store.logAction({
        kind: "bot_error",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: this.client.user?.id || null,
        content: "reply_model_output_empty",
        metadata: {
          source,
          triggerMessageIds,
          addressed: Boolean(addressSignal?.triggered)
        }
      });
    }
    if (finalText === "[SKIP]" || (!finalText && !allowMediaOnlyReply)) {
      this.logSkippedReply({
        message,
        source,
        triggerMessageIds,
        addressSignal,
        generation,
        usedWebSearchFollowup,
        reason: modelProducedSkip ? "llm_skip" : "empty_reply",
        reaction,
        screenShareOffer,
        performance
      });
      return false;
    }

    if (settings.memory.enabled && selfMemoryLine) {
      try {
        selfMemorySaved = await this.memory.rememberDirectiveLine({
          line: selfMemoryLine,
          sourceMessageId: `${message.id}-self`,
          userId: this.client.user?.id || message.author.id,
          guildId: message.guildId,
          channelId: message.channelId,
          sourceText: finalText,
          scope: "self"
        });
      } catch (error) {
        this.store.logAction({
          kind: "bot_error",
          guildId: message.guildId,
          channelId: message.channelId,
          messageId: message.id,
          userId: this.client.user?.id || null,
          content: `memory_self_directive: ${String(error?.message || error)}`
        });
      }
    }

    mentionResolution = await this.resolveDeterministicMentions({
      text: finalText,
      guild: message.guild,
      guildId: message.guildId
    });
    finalText = mentionResolution.text;
    finalText = embedWebSearchSources(finalText, webSearch);

    let payload = { content: finalText };
    let imageUsed = false;
    let imageBudgetBlocked = false;
    let imageCapabilityBlocked = false;
    let imageVariantUsed = null;
    let videoUsed = false;
    let videoBudgetBlocked = false;
    let videoCapabilityBlocked = false;
    let gifUsed = false;
    let gifBudgetBlocked = false;
    let gifConfigBlocked = false;
    const imagePrompt = replyDirective.imagePrompt;
    const complexImagePrompt = replyDirective.complexImagePrompt;
    const videoPrompt = replyDirective.videoPrompt;
    const gifQuery = replyDirective.gifQuery;

    if (mediaDirective?.type === "gif" && gifQuery) {
      const gifResult = await this.maybeAttachReplyGif({
        settings,
        text: finalText,
        query: gifQuery,
        trace: {
          guildId: message.guildId,
          channelId: message.channelId,
          userId: message.author.id,
          source: "reply_message"
        }
      });
      payload = gifResult.payload;
      gifUsed = gifResult.gifUsed;
      gifBudgetBlocked = gifResult.blockedByBudget;
      gifConfigBlocked = gifResult.blockedByConfiguration;
    }

    if (mediaDirective?.type === "image_simple" && settings.initiative.allowReplyImages && imagePrompt) {
      const imageResult = await this.maybeAttachGeneratedImage({
        settings,
        text: finalText,
        prompt: composeReplyImagePrompt(imagePrompt, finalText, mediaPromptLimit, replyMediaMemoryFacts),
        variant: "simple",
        trace: {
          guildId: message.guildId,
          channelId: message.channelId,
          userId: message.author.id,
          source: "reply_message"
        }
      });
      payload = imageResult.payload;
      imageUsed = imageResult.imageUsed;
      imageBudgetBlocked = imageResult.blockedByBudget;
      imageCapabilityBlocked = imageResult.blockedByCapability;
      imageVariantUsed = imageResult.variant || "simple";
    }

    if (mediaDirective?.type === "image_complex" && settings.initiative.allowReplyImages && complexImagePrompt) {
      const imageResult = await this.maybeAttachGeneratedImage({
        settings,
        text: finalText,
        prompt: composeReplyImagePrompt(
          complexImagePrompt,
          finalText,
          mediaPromptLimit,
          replyMediaMemoryFacts
        ),
        variant: "complex",
        trace: {
          guildId: message.guildId,
          channelId: message.channelId,
          userId: message.author.id,
          source: "reply_message"
        }
      });
      payload = imageResult.payload;
      imageUsed = imageResult.imageUsed;
      imageBudgetBlocked = imageResult.blockedByBudget;
      imageCapabilityBlocked = imageResult.blockedByCapability;
      imageVariantUsed = imageResult.variant || "complex";
    }

    if (mediaDirective?.type === "video" && settings.initiative.allowReplyVideos && videoPrompt) {
      const videoResult = await this.maybeAttachGeneratedVideo({
        settings,
        text: finalText,
        prompt: composeReplyVideoPrompt(videoPrompt, finalText, mediaPromptLimit, replyMediaMemoryFacts),
        trace: {
          guildId: message.guildId,
          channelId: message.channelId,
          userId: message.author.id,
          source: "reply_message"
        }
      });
      payload = videoResult.payload;
      videoUsed = videoResult.videoUsed;
      videoBudgetBlocked = videoResult.blockedByBudget;
      videoCapabilityBlocked = videoResult.blockedByCapability;
    }

    if (!finalText && !imageUsed && !videoUsed && !gifUsed) {
      this.store.logAction({
        kind: "bot_error",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: this.client.user?.id || null,
        content: "reply_model_output_empty_after_media",
        metadata: {
          source,
          triggerMessageIds,
          addressed: Boolean(addressSignal?.triggered)
        }
      });
      this.logSkippedReply({
        message,
        source,
        triggerMessageIds,
        addressSignal,
        generation,
        usedWebSearchFollowup,
        reason: "empty_reply_after_media",
        reaction,
        screenShareOffer,
        performance
      });
      return false;
    }

    const typingStartedAtMs = Date.now();
    await message.channel.sendTyping();
    await sleep(this.getSimulatedTypingDelayMs(600, 1800));
    const typingDelayMs = Math.max(0, Date.now() - typingStartedAtMs);

    const shouldThreadReply = addressed || options.forceRespond;
    const canStandalonePost = isInitiativeChannel || !shouldThreadReply;
    const sendAsReply = this.shouldSendAsReply({
      isInitiativeChannel,
      shouldThreadReply
    });
    const sendStartedAtMs = Date.now();
    const sent = sendAsReply
      ? await message.reply({
          ...payload,
          allowedMentions: { repliedUser: false }
        })
      : await message.channel.send(payload);
    const sendMs = Math.max(0, Date.now() - sendStartedAtMs);
    const actionKind = sendAsReply ? "sent_reply" : "sent_message";
    const referencedMessageId = sendAsReply ? message.id : null;

    this.markSpoke();
    this.store.recordMessage({
      messageId: sent.id,
      createdAt: sent.createdTimestamp,
      guildId: sent.guildId,
      channelId: sent.channelId,
      authorId: this.client.user.id,
      authorName: settings.botName,
      isBot: true,
      content: this.composeMessageContentForHistory(sent, finalText),
      referencedMessageId
    });
    this.store.logAction({
      kind: actionKind,
      guildId: sent.guildId,
      channelId: sent.channelId,
      messageId: sent.id,
      userId: this.client.user.id,
      content: finalText,
      metadata: {
        triggerMessageId: message.id,
        triggerMessageIds,
        source,
        addressing: addressSignal,
        sendAsReply,
        canStandalonePost,
        image: {
          requestedByModel: Boolean(imagePrompt || complexImagePrompt),
          requestedSimpleByModel: Boolean(imagePrompt),
          requestedComplexByModel: Boolean(complexImagePrompt),
          selectedVariant: imageVariantUsed,
          used: imageUsed,
          blockedByDailyCap: imageBudgetBlocked,
          blockedByCapability: imageCapabilityBlocked,
          maxPerDay: imageBudget.maxPerDay,
          remainingAtPromptTime: imageBudget.remaining,
          simpleCapabilityReadyAtPromptTime: simpleImageCapabilityReady,
          complexCapabilityReadyAtPromptTime: complexImageCapabilityReady,
          capabilityReadyAtPromptTime: imageCapabilityReady
        },
        videoGeneration: {
          requestedByModel: Boolean(videoPrompt),
          used: videoUsed,
          blockedByDailyCap: videoBudgetBlocked,
          blockedByCapability: videoCapabilityBlocked,
          maxPerDay: videoBudget.maxPerDay,
          remainingAtPromptTime: videoBudget.remaining,
          capabilityReadyAtPromptTime: videoCapabilityReady
        },
        gif: {
          requestedByModel: Boolean(gifQuery),
          used: gifUsed,
          blockedByDailyCap: gifBudgetBlocked,
          blockedByConfiguration: gifConfigBlocked,
          maxPerDay: gifBudget.maxPerDay,
          remainingAtPromptTime: gifBudget.remaining
        },
        memory: {
          requestedByModel: Boolean(memoryLine || selfMemoryLine),
          saved: Boolean(memorySaved || selfMemorySaved),
          loreRequestedByModel: Boolean(memoryLine),
          loreSaved: memorySaved,
          selfRequestedByModel: Boolean(selfMemoryLine),
          selfSaved: selfMemorySaved,
          lookupRequested: memoryLookup.requested,
          lookupUsed: memoryLookup.used,
          lookupQuery: memoryLookup.query,
          lookupResultCount: memoryLookup.results?.length || 0,
          lookupError: memoryLookup.error || null
        },
        imageLookup: {
          requested: imageLookup.requested,
          used: imageLookup.used,
          query: imageLookup.query,
          candidateCount: imageLookup.candidates?.length || 0,
          resultCount: imageLookup.results?.length || 0,
          error: imageLookup.error || null
        },
        mentions: mentionResolution,
        reaction,
        screenShareOffer,
        webSearch: {
          requested: webSearch.requested,
          used: webSearch.used,
          query: webSearch.query,
          resultCount: webSearch.results?.length || 0,
          fetchedPages: webSearch.fetchedPages || 0,
          providerUsed: webSearch.providerUsed || null,
          providerFallbackUsed: Boolean(webSearch.providerFallbackUsed),
          blockedByHourlyCap: webSearch.blockedByBudget,
          maxPerHour: webSearch.budget?.maxPerHour ?? null,
          remainingAtPromptTime: webSearch.budget?.remaining ?? null,
          configured: webSearch.configured,
          optedOutByUser: webSearch.optedOutByUser,
          error: webSearch.error || null
        },
        video: {
          requested: videoContext.requested,
          used: videoContext.used,
          detectedVideos: videoContext.detectedVideos,
          detectedFromRecentMessages: videoContext.detectedFromRecentMessages,
          fetchedVideos: videoContext.videos?.length || 0,
          extractedKeyframes: videoContext.frameImages?.length || 0,
          blockedByHourlyCap: videoContext.blockedByBudget,
          maxPerHour: videoContext.budget?.maxPerHour ?? null,
          remainingAtPromptTime: videoContext.budget?.remaining ?? null,
          enabled: videoContext.enabled,
          errorCount: videoContext.errors?.length || 0
        },
        llm: {
          provider: generation.provider,
          model: generation.model,
          usage: generation.usage,
          costUsd: generation.costUsd,
          usedWebSearchFollowup,
          usedMemoryLookupFollowup,
          usedImageLookupFollowup
        },
        performance: finalizeReplyPerformanceSample({
          performance,
          actionKind,
          typingDelayMs,
          sendMs
        })
      }
    });

    return true;
  }

  async maybeHandleStructuredVoiceIntent({ message, settings, replyDirective }) {
    const voiceSettings = settings?.voice || {};
    if (!voiceSettings.enabled) return false;

    const intent = replyDirective?.voiceIntent;
    if (!intent?.intent) return false;

    const threshold = clamp(Number(voiceSettings.intentConfidenceThreshold) || 0.75, 0.4, 0.99);
    if (intent.confidence < threshold) return false;

    this.store.logAction({
      kind: "voice_intent_detected",
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      userId: message.author?.id || null,
      content: intent.intent,
      metadata: {
        confidence: intent.confidence,
        threshold,
        detector: "reply_llm",
        reason: intent.reason || null
      }
    });

    if (intent.intent === "join") {
      return await this.voiceSessionManager.requestJoin({
        message,
        settings,
        intentConfidence: intent.confidence
      });
    }

    if (intent.intent === "leave") {
      return await this.voiceSessionManager.requestLeave({
        message,
        settings,
        reason: "nl_leave"
      });
    }

    if (intent.intent === "status") {
      return await this.voiceSessionManager.requestStatus({
        message,
        settings
      });
    }

    if (intent.intent === "watch_stream") {
      return await this.voiceSessionManager.requestWatchStream({
        message,
        settings,
        targetUserId: message.author?.id || null
      });
    }

    if (intent.intent === "stop_watching_stream") {
      return await this.voiceSessionManager.requestStopWatchingStream({
        message,
        settings
      });
    }

    if (intent.intent === "stream_status") {
      return await this.voiceSessionManager.requestStreamWatchStatus({
        message,
        settings
      });
    }

    return false;
  }

  async maybeHandleStructuredAutomationIntent({
    message,
    settings,
    replyDirective,
    generation,
    source,
    triggerMessageIds = [],
    addressing = null,
    performance = null
  }) {
    const automationAction = replyDirective?.automationAction;
    const operation = String(automationAction?.operation || "").trim();
    if (!operation) return false;

    const result = await this.applyAutomationControlAction({
      message,
      settings,
      automationAction
    });
    if (!result?.handled) return false;

    const finalText = this.composeAutomationControlReply({
      modelText: replyDirective?.text,
      detailLines: result.detailLines
    });

    if (!finalText || finalText === "[SKIP]") {
      this.store.logAction({
        kind: "bot_error",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: this.client.user?.id || null,
        content: "automation_control_reply_missing",
        metadata: {
          operation,
          source,
          automationControl: result.metadata || null
        }
      });
      return true;
    }

    const typingStartedAtMs = Date.now();
    await message.channel.sendTyping();
    await sleep(this.getSimulatedTypingDelayMs(350, 800));
    const typingDelayMs = Math.max(0, Date.now() - typingStartedAtMs);
    const sendStartedAtMs = Date.now();
    const sent = await message.reply({
      content: finalText,
      allowedMentions: { repliedUser: false }
    });
    const sendMs = Math.max(0, Date.now() - sendStartedAtMs);

    this.markSpoke();
    this.store.recordMessage({
      messageId: sent.id,
      createdAt: sent.createdTimestamp,
      guildId: sent.guildId,
      channelId: sent.channelId,
      authorId: this.client.user.id,
      authorName: settings.botName,
      isBot: true,
      content: this.composeMessageContentForHistory(sent, finalText),
      referencedMessageId: message.id
    });
    this.store.logAction({
      kind: "sent_reply",
      guildId: sent.guildId,
      channelId: sent.channelId,
      messageId: sent.id,
      userId: this.client.user.id,
      content: finalText,
      metadata: {
        triggerMessageId: message.id,
        triggerMessageIds,
        source,
        sendAsReply: true,
        canStandalonePost: this.isInitiativeChannel(settings, message.channelId),
        addressing,
        automationControl: result.metadata || null,
        llm: {
          provider: generation?.provider || null,
          model: generation?.model || null,
          usage: generation?.usage || null,
          costUsd: generation?.costUsd || 0
        },
        performance: finalizeReplyPerformanceSample({
          performance,
          actionKind: "sent_reply",
          typingDelayMs,
          sendMs
        })
      }
    });

    return true;
  }

  async maybeHandleScreenShareOfferIntent({
    message,
    replyDirective,
    source = "message_event"
  }) {
    const empty = {
      offered: false,
      appendText: "",
      linkUrl: null,
      explicitRequest: false,
      intentRequested: false,
      confidence: 0,
      reason: null
    };

    const explicitRequest = SCREEN_SHARE_EXPLICIT_REQUEST_RE.test(String(message?.content || ""));
    const manager = this.screenShareSessionManager;
    const settings = this.store.getSettings();
    if (!message?.guildId || !message?.channelId) return empty;
    if (!manager) {
      if (!explicitRequest) return empty;
      const appendText = await this.composeScreenShareUnavailableMessage({
        message,
        settings,
        reason: "screen_share_manager_unavailable",
        source
      });
      return {
        ...empty,
        explicitRequest: true,
        appendText
      };
    }

    const intent = replyDirective?.screenShareIntent || {};
    const intentRequested = intent?.action === "offer_link";
    const confidence = Number(intent?.confidence || 0);
    const intentAllowed = intentRequested && confidence >= SCREEN_SHARE_INTENT_THRESHOLD;
    if (!explicitRequest && !intentAllowed) return empty;

    const created = await manager.createSession({
      guildId: message.guildId,
      channelId: message.channelId,
      requesterUserId: message.author?.id || null,
      requesterDisplayName: message.member?.displayName || message.author?.username || "",
      targetUserId: message.author?.id || null,
      source
    });

    if (!created?.ok) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: message.author?.id || null,
        content: "screen_share_offer_unavailable",
        metadata: {
          reason: created?.reason || "unknown",
          explicitRequest,
          intentRequested,
          confidence,
          source
        }
      });
      if (!explicitRequest) {
        return {
          ...empty,
          explicitRequest,
          intentRequested,
          confidence,
          reason: created?.reason || "unknown"
        };
      }
      const appendText = await this.composeScreenShareUnavailableMessage({
        message,
        settings,
        reason: created?.reason || "unknown",
        source
      });
      return {
        ...empty,
        explicitRequest,
        intentRequested,
        confidence,
        reason: created?.reason || "unknown",
        appendText
      };
    }

    const linkUrl = String(created.shareUrl || "").trim();
    const expiresInMinutes = Number(created.expiresInMinutes || 0);
    if (!linkUrl) return empty;

    this.store.logAction({
      kind: "voice_runtime",
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      userId: message.author?.id || null,
      content: "screen_share_offer_prepared",
      metadata: {
        explicitRequest,
        intentRequested,
        confidence,
        expiresInMinutes,
        linkHost: safeUrlHost(linkUrl),
        source
      }
    });

    const appendText = await this.composeScreenShareOfferMessage({
      message,
      settings,
      linkUrl,
      expiresInMinutes,
      explicitRequest,
      intentRequested,
      confidence,
      source
    });

    return {
      offered: true,
      appendText,
      linkUrl,
      explicitRequest,
      intentRequested,
      confidence,
      reason: "offered"
    };
  }

  async composeScreenShareOfferMessage({
    message,
    settings,
    linkUrl,
    expiresInMinutes,
    explicitRequest = false,
    intentRequested = false,
    confidence = 0,
    source = "message_event"
  }) {
    const composed = await this.composeVoiceOperationalMessage({
      settings,
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author?.id || null,
      messageId: message.id,
      event: "voice_screen_share_offer",
      reason: explicitRequest ? "explicit_request" : "proactive_offer",
      details: {
        linkUrl,
        expiresInMinutes,
        explicitRequest: Boolean(explicitRequest),
        intentRequested: Boolean(intentRequested),
        confidence: Number(confidence || 0),
        source: String(source || "message_event")
      },
      maxOutputChars: SCREEN_SHARE_MESSAGE_MAX_CHARS
    });

    const normalized = sanitizeBotText(
      normalizeSkipSentinel(String(composed || "")),
      SCREEN_SHARE_MESSAGE_MAX_CHARS
    );
    if (!normalized || normalized === "[SKIP]") {
      this.store.logAction({
        kind: "voice_error",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: message.author?.id || null,
        content: "screen_share_offer_message_empty",
        metadata: {
          explicitRequest: Boolean(explicitRequest),
          intentRequested: Boolean(intentRequested),
          confidence: Number(confidence || 0),
          source: String(source || "message_event")
        }
      });
      return "";
    }
    if (!String(normalized).includes(linkUrl)) {
      this.store.logAction({
        kind: "voice_error",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: message.author?.id || null,
        content: "screen_share_offer_message_missing_link",
        metadata: {
          explicitRequest: Boolean(explicitRequest),
          intentRequested: Boolean(intentRequested),
          confidence: Number(confidence || 0),
          source: String(source || "message_event")
        }
      });
      return "";
    }
    return normalized;
  }

  async composeScreenShareUnavailableMessage({
    message,
    settings,
    reason = "unavailable",
    source = "message_event"
  }) {
    const composed = await this.composeVoiceOperationalMessage({
      settings,
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author?.id || null,
      messageId: message.id,
      event: "voice_screen_share_offer",
      reason: String(reason || "unavailable"),
      details: {
        source: String(source || "message_event"),
        unavailable: true
      },
      maxOutputChars: SCREEN_SHARE_MESSAGE_MAX_CHARS
    });

    const normalized = sanitizeBotText(
      normalizeSkipSentinel(String(composed || "")),
      SCREEN_SHARE_MESSAGE_MAX_CHARS
    );
    if (!normalized || normalized === "[SKIP]") {
      this.store.logAction({
        kind: "voice_error",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: message.author?.id || null,
        content: "screen_share_unavailable_message_empty",
        metadata: {
          reason: String(reason || "unavailable"),
          source: String(source || "message_event")
        }
      });
      return "";
    }
    return normalized;
  }

  composeAutomationControlReply({ modelText, detailLines = [] }) {
    return composeAutomationControlReply({
      modelText,
      detailLines
    });
  }

  async applyAutomationControlAction({ message, settings, automationAction }) {
    const runtime = createAutomationControlRuntime(this);
    return await applyAutomationControlAction(runtime, {
      message,
      settings,
      automationAction
    });
  }

  resolveAutomationTargetsForControl({ guildId, channelId, operation, automationId = null, targetQuery = "" }) {
    const runtime = createAutomationControlRuntime(this);
    return resolveAutomationTargetsForControl(runtime, {
      guildId,
      channelId,
      operation,
      automationId,
      targetQuery
    });
  }

  formatAutomationListLine(row) {
    return formatAutomationListLine(row);
  }

  async maybeApplyReplyReaction({
    message,
    settings,
    emojiOptions,
    emojiToken,
    generation,
    source,
    triggerMessageId,
    triggerMessageIds = [],
    addressing
  }) {
    const result = {
      requestedByModel: Boolean(emojiToken),
      used: false,
      emoji: null,
      blockedByPermission: false,
      blockedByHourlyCap: false,
      blockedByAllowedSet: false
    };
    const normalized = normalizeReactionEmojiToken(emojiToken);
    if (!normalized) return result;

    if (!settings.permissions.allowReactions) {
      return {
        ...result,
        blockedByPermission: true
      };
    }

    if (!this.canTakeAction("reacted", settings.permissions.maxReactionsPerHour)) {
      return {
        ...result,
        blockedByHourlyCap: true
      };
    }

    if (!emojiOptions.includes(normalized)) {
      return {
        ...result,
        blockedByAllowedSet: true,
        emoji: normalized
      };
    }

    try {
      await message.react(normalized);
      this.store.logAction({
        kind: "reacted",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: this.client.user.id,
        content: normalized,
        metadata: {
          source,
          triggerMessageId,
          triggerMessageIds,
          addressing,
          reason: "reply_directive",
          llm: {
            provider: generation.provider,
            model: generation.model,
            usage: generation.usage,
            costUsd: generation.costUsd
          }
        }
      });
      return {
        ...result,
        used: true,
        emoji: normalized
      };
    } catch {
      return {
        ...result,
        emoji: normalized
      };
    }
  }

  logSkippedReply({
    message,
    source,
    triggerMessageIds = [],
    addressSignal,
    generation = null,
    usedWebSearchFollowup = false,
    reason,
    reaction,
    screenShareOffer = null,
    performance = null,
    extraMetadata = null
  }) {
    const llmMetadata = generation
      ? {
          provider: generation.provider,
          model: generation.model,
          usage: generation.usage,
          costUsd: generation.costUsd,
          usedWebSearchFollowup
        }
      : null;
    this.store.logAction({
      kind: "reply_skipped",
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      userId: this.client.user.id,
      content: reason,
      metadata: {
        triggerMessageId: message.id,
        triggerMessageIds,
        source,
        addressing: addressSignal,
        reaction,
        screenShareOffer,
        llm: llmMetadata,
        performance: finalizeReplyPerformanceSample({
          performance,
          actionKind: "reply_skipped"
        }),
        ...(extraMetadata && typeof extraMetadata === "object" ? extraMetadata : {})
      }
    });
  }

  canTalkNow(settings) {
    const elapsed = Date.now() - this.lastBotMessageAt;
    return elapsed >= settings.activity.minSecondsBetweenMessages * 1000;
  }

  markSpoke() {
    this.lastBotMessageAt = Date.now();
  }

  canTakeAction(kind, maxPerHour) {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const count = this.store.countActionsSince(kind, since);
    return count < maxPerHour;
  }

  canSendMessage(maxPerHour) {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const sentReplies = this.store.countActionsSince("sent_reply", since);
    const sentMessages = this.store.countActionsSince("sent_message", since);
    const initiativePosts = this.store.countActionsSince("initiative_post", since);
    return sentReplies + sentMessages + initiativePosts < maxPerHour;
  }

  getImageBudgetState(settings) {
    const maxPerDay = clamp(Number(settings.initiative?.maxImagesPerDay) || 0, 0, 200);
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const used = this.store.countActionsSince("image_call", since24h);
    const remaining = Math.max(0, maxPerDay - used);

    return {
      maxPerDay,
      used,
      remaining,
      canGenerate: maxPerDay > 0 && remaining > 0
    };
  }

  getVideoGenerationBudgetState(settings) {
    const maxPerDay = clamp(Number(settings.initiative?.maxVideosPerDay) || 0, 0, 120);
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const used = this.store.countActionsSince("video_call", since24h);
    const remaining = Math.max(0, maxPerDay - used);

    return {
      maxPerDay,
      used,
      remaining,
      canGenerate: maxPerDay > 0 && remaining > 0
    };
  }

  getGifBudgetState(settings) {
    const maxPerDay = clamp(Number(settings.initiative?.maxGifsPerDay) || 0, 0, 300);
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const used = this.store.countActionsSince("gif_call", since24h);
    const remaining = Math.max(0, maxPerDay - used);

    return {
      maxPerDay,
      used,
      remaining,
      canFetch: maxPerDay > 0 && remaining > 0
    };
  }

  getMediaGenerationCapabilities(settings) {
    if (!this.llm?.getMediaGenerationCapabilities) {
      return {
        simpleImageReady: false,
        complexImageReady: false,
        videoReady: false,
        simpleImageModel: null,
        complexImageModel: null,
        videoModel: null
      };
    }

    return this.llm.getMediaGenerationCapabilities(settings);
  }

  isImageGenerationReady(settings, variant = "any") {
    return Boolean(this.llm?.isImageGenerationReady?.(settings, variant));
  }

  isVideoGenerationReady(settings) {
    return Boolean(this.llm?.isVideoGenerationReady?.(settings));
  }

  getWebSearchBudgetState(settings) {
    const maxPerHour = clamp(Number(settings.webSearch?.maxSearchesPerHour) || 0, 0, 120);
    const since1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const successCount = this.store.countActionsSince("search_call", since1h);
    const errorCount = this.store.countActionsSince("search_error", since1h);
    const used = successCount + errorCount;
    const remaining = Math.max(0, maxPerHour - used);

    return {
      maxPerHour,
      used,
      successCount,
      errorCount,
      remaining,
      canSearch: maxPerHour > 0 && remaining > 0
    };
  }

  getVideoContextBudgetState(settings) {
    const maxPerHour = clamp(Number(settings.videoContext?.maxLookupsPerHour) || 0, 0, 120);
    const since1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const successCount = this.store.countActionsSince("video_context_call", since1h);
    const errorCount = this.store.countActionsSince("video_context_error", since1h);
    const used = successCount + errorCount;
    const remaining = Math.max(0, maxPerHour - used);

    return {
      maxPerHour,
      used,
      successCount,
      errorCount,
      remaining,
      canLookup: maxPerHour > 0 && remaining > 0
    };
  }

  async buildVideoReplyContext({ settings, message, recentMessages = [], trace = {} }) {
    const messageText = String(message?.content || "");
    const enabled = Boolean(settings.videoContext?.enabled);
    const budget = this.getVideoContextBudgetState(settings);
    const maxVideosPerMessage = clamp(Number(settings.videoContext?.maxVideosPerMessage) || 0, 0, 6);
    const maxTranscriptChars = clamp(Number(settings.videoContext?.maxTranscriptChars) || 1200, 200, 4000);
    const keyframeIntervalSeconds = clamp(Number(settings.videoContext?.keyframeIntervalSeconds) || 0, 0, 120);
    const maxKeyframesPerVideo = clamp(Number(settings.videoContext?.maxKeyframesPerVideo) || 0, 0, 8);
    const allowAsrFallback = Boolean(settings.videoContext?.allowAsrFallback);
    const maxAsrSeconds = clamp(Number(settings.videoContext?.maxAsrSeconds) || 120, 15, 600);

    const base = {
      requested: false,
      enabled,
      used: false,
      blockedByBudget: false,
      error: null,
      errors: [],
      detectedVideos: 0,
      detectedFromRecentMessages: false,
      videos: [],
      frameImages: [],
      budget
    };

    if (!this.video) {
      return base;
    }

    const directTargets = this.video.extractMessageTargets(message, MAX_VIDEO_TARGET_SCAN);
    const fallbackTargets =
      !directTargets.length && looksLikeVideoFollowupMessage(messageText)
        ? extractRecentVideoTargets({
            videoService: this.video,
            recentMessages,
            maxMessages: MAX_VIDEO_FALLBACK_MESSAGES,
            maxTargets: MAX_VIDEO_TARGET_SCAN
          })
        : [];
    const detectedTargets = directTargets.length ? directTargets : fallbackTargets;
    if (!detectedTargets.length) return base;
    const detectedFromRecentMessages = directTargets.length === 0 && fallbackTargets.length > 0;

    if (maxVideosPerMessage <= 0) {
      return {
        ...base,
        requested: true,
        detectedVideos: detectedTargets.length,
        detectedFromRecentMessages
      };
    }

    const targets = detectedTargets.slice(0, maxVideosPerMessage);
    if (!targets.length) {
      return {
        ...base,
        requested: true,
        detectedVideos: detectedTargets.length,
        detectedFromRecentMessages
      };
    }

    if (!enabled) {
      return {
        ...base,
        requested: true,
        detectedVideos: detectedTargets.length,
        detectedFromRecentMessages
      };
    }

    if (!budget.canLookup) {
      return {
        ...base,
        requested: true,
        detectedVideos: detectedTargets.length,
        detectedFromRecentMessages,
        blockedByBudget: true
      };
    }

    const allowedCount = Math.min(targets.length, budget.remaining);
    if (allowedCount <= 0) {
      return {
        ...base,
        requested: true,
        detectedVideos: detectedTargets.length,
        detectedFromRecentMessages,
        blockedByBudget: true
      };
    }

    const selectedTargets = targets.slice(0, allowedCount);
    const blockedByBudget = selectedTargets.length < targets.length;

    try {
      const result = await this.video.fetchContexts({
        targets: selectedTargets,
        maxTranscriptChars,
        keyframeIntervalSeconds,
        maxKeyframesPerVideo,
        allowAsrFallback,
        maxAsrSeconds,
        trace
      });
      const firstError = result.errors?.[0]?.error || null;
      const videos = (result.videos || []).map((item) => {
        const { frameImages: _frameImages, ...rest } = item || {};
        return rest;
      });
      const frameImages = (result.videos || []).flatMap((item) => item?.frameImages || []);
      return {
        ...base,
        requested: true,
        used: Boolean(videos.length),
        blockedByBudget,
        error: firstError,
        errors: result.errors || [],
        detectedVideos: detectedTargets.length,
        detectedFromRecentMessages,
        videos,
        frameImages
      };
    } catch (error) {
      return {
        ...base,
        requested: true,
        detectedVideos: detectedTargets.length,
        detectedFromRecentMessages,
        blockedByBudget,
        error: String(error?.message || error),
        errors: [
          {
            videoId: null,
            url: null,
            error: String(error?.message || error)
          }
        ]
      };
    }
  }

  buildWebSearchContext(settings, messageText) {
    const text = String(messageText || "");
    const configured = Boolean(this.search?.isConfigured?.());
    const enabled = Boolean(settings.webSearch?.enabled);
    const budget = this.getWebSearchBudgetState(settings);

    return {
      requested: false,
      configured,
      enabled,
      used: false,
      blockedByBudget: false,
      optedOutByUser: isWebSearchOptOutText(text),
      error: null,
      query: "",
      results: [],
      fetchedPages: 0,
      providerUsed: null,
      providerFallbackUsed: false,
      budget
    };
  }

  buildMemoryLookupContext({ settings }) {
    const enabled = Boolean(settings?.memory?.enabled && this.memory?.searchDurableFacts);
    return {
      enabled,
      requested: false,
      used: false,
      query: "",
      results: [],
      error: null
    };
  }

  buildImageLookupContext({ recentMessages = [], excludedUrls = [] } = {}) {
    const excluded = new Set(
      (Array.isArray(excludedUrls) ? excludedUrls : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    );
    const candidates = this.extractHistoryImageCandidates({
      recentMessages,
      excluded
    });
    return {
      enabled: true,
      requested: false,
      used: false,
      query: "",
      candidates,
      results: [],
      selectedImageInputs: [],
      error: null
    };
  }

  extractHistoryImageCandidates({ recentMessages = [], excluded = new Set() } = {}) {
    const rows = Array.isArray(recentMessages) ? recentMessages : [];
    const seen = excluded instanceof Set ? new Set(excluded) : new Set();
    const candidates = [];

    for (const row of rows) {
      if (candidates.length >= MAX_HISTORY_IMAGE_CANDIDATES) break;
      const content = String(row?.content || "");
      if (!content) continue;

      const urls = extractUrlsFromText(content);
      if (!urls.length) continue;

      for (const rawUrl of urls) {
        if (candidates.length >= MAX_HISTORY_IMAGE_CANDIDATES) break;
        const url = String(rawUrl || "").trim();
        if (!url) continue;
        if (!isLikelyImageUrl(url)) continue;
        if (seen.has(url)) continue;
        seen.add(url);

        const parsed = parseHistoryImageReference(url);
        const contentSansUrl = content.replace(url, " ").replace(/\s+/g, " ").trim();
        candidates.push({
          messageId: String(row?.message_id || "").trim() || null,
          authorName: String(row?.author_name || "unknown").trim() || "unknown",
          createdAt: String(row?.created_at || "").trim(),
          url,
          filename: parsed.filename || "(unnamed)",
          contentType: parsed.contentType || "",
          context: contentSansUrl.slice(0, 180),
          recencyRank: candidates.length
        });
      }
    }

    return candidates;
  }

  rankImageLookupCandidates({ candidates = [], query = "" } = {}) {
    const normalizedQuery = String(query || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    const queryTokens = [...new Set(normalizedQuery.match(/[a-z0-9]{3,}/g) || [])].slice(
      0,
      MAX_IMAGE_LOOKUP_QUERY_TOKENS
    );
    const wantsVisualRecall = /\b(?:image|photo|picture|pic|screenshot|meme|earlier|previous|that)\b/i.test(
      normalizedQuery
    );

    const ranked = (Array.isArray(candidates) ? candidates : []).map((candidate, index) => {
      const haystack = [
        candidate?.context,
        candidate?.filename,
        candidate?.authorName
      ]
        .map((value) => String(value || "").toLowerCase())
        .join(" ");
      let score = Math.max(0, 4 - index * 0.3);
      const reasons = [];

      if (normalizedQuery && haystack.includes(normalizedQuery)) {
        score += 9;
        reasons.push("phrase match");
      }

      let tokenHits = 0;
      for (const token of queryTokens) {
        if (!token) continue;
        if (haystack.includes(token)) {
          score += 2;
          tokenHits += 1;
        }
      }
      if (tokenHits > 0) {
        reasons.push(`${tokenHits} token hit${tokenHits === 1 ? "" : "s"}`);
      }

      if (wantsVisualRecall) {
        score += 1;
      }

      return {
        ...candidate,
        score,
        matchReason: reasons.join(", ") || "recency fallback"
      };
    });

    ranked.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (a.recencyRank || 0) - (b.recencyRank || 0);
    });

    const matched = ranked.filter((item) => item.score >= 4);
    return matched.length ? matched : ranked;
  }

  async runModelRequestedImageLookup({
    imageLookup,
    query
  }) {
    const normalizedQuery = normalizeDirectiveText(query, MAX_IMAGE_LOOKUP_QUERY_LEN);
    const state = {
      ...imageLookup,
      requested: true,
      used: false,
      query: normalizedQuery,
      results: [],
      selectedImageInputs: [],
      error: null
    };

    if (!state.enabled) {
      return state;
    }
    if (!normalizedQuery) {
      return {
        ...state,
        error: "Missing image lookup query."
      };
    }

    const candidates = Array.isArray(state.candidates) ? state.candidates : [];
    if (!candidates.length) {
      return {
        ...state,
        error: "No recent history images are available for lookup."
      };
    }

    const ranked = this.rankImageLookupCandidates({
      candidates,
      query: normalizedQuery
    });
    const selected = ranked.slice(0, Math.min(MAX_HISTORY_IMAGE_LOOKUP_RESULTS, MAX_MODEL_IMAGE_INPUTS));
    if (!selected.length) {
      return {
        ...state,
        error: "No matching history images were found."
      };
    }

    return {
      ...state,
      used: true,
      results: selected,
      selectedImageInputs: selected.map((item) => ({
        url: item.url,
        filename: item.filename,
        contentType: item.contentType
      }))
    };
  }

  mergeImageInputs({ baseInputs = [], extraInputs = [], maxInputs = MAX_MODEL_IMAGE_INPUTS } = {}) {
    const merged = [];
    const seen = new Set();
    const pushUnique = (input) => {
      if (!input || typeof input !== "object") return;
      const url = String(input?.url || "").trim();
      const mediaType = String(input?.mediaType || input?.contentType || "").trim().toLowerCase();
      const inlineData = String(input?.dataBase64 || "").trim();
      const key = url
        ? `url:${url}`
        : inlineData
          ? `inline:${mediaType}:${inlineData.slice(0, 80)}`
          : "";
      if (!key || seen.has(key)) return;
      seen.add(key);
      merged.push(input);
    };

    for (const input of Array.isArray(baseInputs) ? baseInputs : []) {
      if (merged.length >= maxInputs) break;
      pushUnique(input);
    }
    for (const input of Array.isArray(extraInputs) ? extraInputs : []) {
      if (merged.length >= maxInputs) break;
      pushUnique(input);
    }

    return merged.slice(0, maxInputs);
  }

  async loadPromptMemorySlice({
    settings,
    userId = null,
    guildId,
    channelId = null,
    queryText = "",
    trace = {},
    source = "prompt_memory_slice"
  }) {
    const empty = { userFacts: [], relevantFacts: [], relevantMessages: [] };
    if (!settings?.memory?.enabled || !this.memory?.buildPromptMemorySlice) return empty;

    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId) return empty;
    const normalizedUserId = String(userId || "").trim() || null;
    const normalizedChannelId = String(channelId || "").trim() || null;
    const normalizedQuery = String(queryText || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 420);

    try {
      const slice = await this.memory.buildPromptMemorySlice({
        userId: normalizedUserId,
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        queryText: normalizedQuery,
        settings,
        trace: {
          ...trace,
          source
        }
      });

      return {
        userFacts: Array.isArray(slice?.userFacts) ? slice.userFacts : [],
        relevantFacts: Array.isArray(slice?.relevantFacts) ? slice.relevantFacts : [],
        relevantMessages: Array.isArray(slice?.relevantMessages) ? slice.relevantMessages : []
      };
    } catch (error) {
      this.store.logAction({
        kind: "bot_error",
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        userId: normalizedUserId,
        content: `${source}: ${String(error?.message || error)}`
      });
      return empty;
    }
  }

  buildMediaMemoryFacts({ userFacts = [], relevantFacts = [], maxItems = 5 } = {}) {
    const merged = [
      ...(Array.isArray(userFacts) ? userFacts : []),
      ...(Array.isArray(relevantFacts) ? relevantFacts : [])
    ];
    const max = clamp(Math.floor(Number(maxItems) || 5), 1, 8);
    return collectMemoryFactHints(merged, max);
  }

  getScopedFallbackFacts({ guildId, channelId = null, limit = 8 }) {
    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId || typeof this.store?.getFactsForScope !== "function") return [];

    const boundedLimit = clamp(Math.floor(Number(limit) || 8), 1, 24);
    const candidateLimit = clamp(boundedLimit * 4, boundedLimit, 120);
    const rows = this.store.getFactsForScope({
      guildId: normalizedGuildId,
      limit: candidateLimit
    });
    if (!rows.length) return [];

    const normalizedChannelId = String(channelId || "").trim();
    if (!normalizedChannelId) return rows.slice(0, boundedLimit);

    const sameChannel = [];
    const noChannel = [];
    const otherChannel = [];
    for (const row of rows) {
      const rowChannelId = String(row?.channel_id || "").trim();
      if (rowChannelId && rowChannelId === normalizedChannelId) {
        sameChannel.push(row);
        continue;
      }
      if (!rowChannelId) {
        noChannel.push(row);
        continue;
      }
      otherChannel.push(row);
    }

    return [...sameChannel, ...noChannel, ...otherChannel].slice(0, boundedLimit);
  }

  async loadRelevantMemoryFacts({
    settings,
    guildId,
    channelId = null,
    queryText = "",
    trace = {},
    limit = 8,
    fallbackWhenNoMatch = true
  }) {
    if (!settings?.memory?.enabled || !this.memory?.searchDurableFacts) return [];
    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId) return [];
    const normalizedChannelId = String(channelId || "").trim() || null;
    const boundedLimit = clamp(Math.floor(Number(limit) || 8), 1, 24);
    const normalizedQuery = String(queryText || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 320);
    if (!normalizedQuery) {
      return this.getScopedFallbackFacts({
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        limit: boundedLimit
      });
    }

    try {
      const results = await this.memory.searchDurableFacts({
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        queryText: normalizedQuery,
        settings,
        trace: {
          ...trace,
          source: trace?.source || "memory_context"
        },
        limit: boundedLimit
      });
      if (results.length || !fallbackWhenNoMatch) return results;
      return this.getScopedFallbackFacts({
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        limit: boundedLimit
      });
    } catch (error) {
      this.store.logAction({
        kind: "bot_error",
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        content: `memory_context: ${String(error?.message || error)}`,
        metadata: {
          queryText: normalizedQuery.slice(0, 120),
          source: trace?.source || "memory_context"
        }
      });
      return this.getScopedFallbackFacts({
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        limit: boundedLimit
      });
    }
  }

  async runModelRequestedWebSearch({
    settings,
    webSearch,
    query,
    trace = {}
  }) {
    const runtime = createReplyFollowupRuntime(this);
    return await runModelRequestedWebSearchForReplyFollowup(runtime, {
      settings,
      webSearch,
      query,
      trace
    });
  }

  async runModelRequestedMemoryLookup({
    settings,
    memoryLookup,
    query,
    guildId,
    channelId = null,
    trace = {}
  }) {
    const runtime = createReplyFollowupRuntime(this);
    return await runModelRequestedMemoryLookupForReplyFollowup(runtime, {
      settings,
      memoryLookup,
      query,
      guildId,
      channelId,
      trace
    });
  }

  resolveReplyFollowupGenerationSettings(settings) {
    return resolveReplyFollowupGenerationSettingsForReplyFollowup(settings);
  }

  async maybeRegenerateWithMemoryLookup({
    settings,
    followupSettings = null,
    systemPrompt,
    generation,
    directive,
    memoryLookup,
    imageLookup = null,
    guildId,
    channelId = null,
    trace = {},
    mediaPromptLimit,
    imageInputs = null,
    forceRegenerate = false,
    buildUserPrompt
  }) {
    const runtime = createReplyFollowupRuntime(this);
    return await maybeRegenerateWithMemoryLookupForReplyFollowup(runtime, {
      settings,
      followupSettings,
      systemPrompt,
      generation,
      directive,
      memoryLookup,
      imageLookup,
      guildId,
      channelId,
      trace,
      mediaPromptLimit,
      imageInputs,
      forceRegenerate,
      buildUserPrompt,
      runModelRequestedImageLookup: (payload) => this.runModelRequestedImageLookup(payload),
      mergeImageInputs: (payload) => this.mergeImageInputs(payload),
      maxModelImageInputs: MAX_MODEL_IMAGE_INPUTS
    });
  }

  async maybeAttachGeneratedImage({ settings, text, prompt, variant = "simple", trace }) {
    const payload = { content: text };
    const ready = this.isImageGenerationReady(settings, variant);
    if (!ready) {
      return {
        payload,
        imageUsed: false,
        variant: null,
        blockedByBudget: false,
        blockedByCapability: true,
        budget: this.getImageBudgetState(settings)
      };
    }

    const budget = this.getImageBudgetState(settings);
    if (!budget.canGenerate) {
      return {
        payload,
        imageUsed: false,
        variant: null,
        blockedByBudget: true,
        blockedByCapability: false,
        budget
      };
    }

    try {
      const image = await this.llm.generateImage({
        settings,
        prompt,
        variant,
        trace
      });
      const withImage = this.buildMessagePayloadWithImage(text, image);
      return {
        payload: withImage.payload,
        imageUsed: withImage.imageUsed,
        variant: image.variant || variant,
        blockedByBudget: false,
        blockedByCapability: false,
        budget
      };
    } catch {
      return {
        payload,
        imageUsed: false,
        variant: null,
        blockedByBudget: false,
        blockedByCapability: false,
        budget
      };
    }
  }

  async maybeAttachGeneratedVideo({ settings, text, prompt, trace }) {
    const payload = { content: text };
    const ready = this.isVideoGenerationReady(settings);
    if (!ready) {
      return {
        payload,
        videoUsed: false,
        blockedByBudget: false,
        blockedByCapability: true,
        budget: this.getVideoGenerationBudgetState(settings)
      };
    }

    const budget = this.getVideoGenerationBudgetState(settings);
    if (!budget.canGenerate) {
      return {
        payload,
        videoUsed: false,
        blockedByBudget: true,
        blockedByCapability: false,
        budget
      };
    }

    try {
      const video = await this.llm.generateVideo({
        settings,
        prompt,
        trace
      });
      const withVideo = this.buildMessagePayloadWithVideo(text, video);
      return {
        payload: withVideo.payload,
        videoUsed: withVideo.videoUsed,
        blockedByBudget: false,
        blockedByCapability: false,
        budget
      };
    } catch {
      return {
        payload,
        videoUsed: false,
        blockedByBudget: false,
        blockedByCapability: false,
        budget
      };
    }
  }

  async maybeAttachReplyGif({ settings, text, query, trace }) {
    const payload = { content: text };
    const budget = this.getGifBudgetState(settings);
    const normalizedQuery = normalizeDirectiveText(query, MAX_GIF_QUERY_LEN);

    if (!settings.initiative.allowReplyGifs) {
      return {
        payload,
        gifUsed: false,
        blockedByBudget: false,
        blockedByConfiguration: true,
        budget
      };
    }

    if (!normalizedQuery) {
      return {
        payload,
        gifUsed: false,
        blockedByBudget: false,
        blockedByConfiguration: false,
        budget
      };
    }

    if (!this.gifs?.isConfigured?.()) {
      return {
        payload,
        gifUsed: false,
        blockedByBudget: false,
        blockedByConfiguration: true,
        budget
      };
    }

    if (!budget.canFetch) {
      return {
        payload,
        gifUsed: false,
        blockedByBudget: true,
        blockedByConfiguration: false,
        budget
      };
    }

    try {
      const gif = await this.gifs.pickGif({
        query: normalizedQuery,
        trace
      });
      if (!gif?.url) {
        return {
          payload,
          gifUsed: false,
          blockedByBudget: false,
          blockedByConfiguration: false,
          budget
        };
      }

      const withGif = this.buildMessagePayloadWithGif(text, gif.url);
      return {
        payload: withGif.payload,
        gifUsed: withGif.gifUsed,
        blockedByBudget: false,
        blockedByConfiguration: false,
        budget
      };
    } catch {
      return {
        payload,
        gifUsed: false,
        blockedByBudget: false,
        blockedByConfiguration: false,
        budget
      };
    }
  }

  buildMessagePayloadWithImage(text, image) {
    if (image.imageBuffer) {
      return {
        payload: {
          content: text,
          files: [{ attachment: image.imageBuffer, name: `clanker-${Date.now()}.png` }]
        },
        imageUsed: true
      };
    }

    if (image.imageUrl) {
      const normalizedUrl = String(image.imageUrl || "").trim();
      const trimmedText = String(text || "").trim();
      const content = trimmedText ? `${trimmedText}\n${normalizedUrl}` : normalizedUrl;
      return {
        payload: { content },
        imageUsed: true
      };
    }

    return {
      payload: { content: text },
      imageUsed: false
    };
  }

  buildMessagePayloadWithVideo(text, video) {
    const videoUrl = String(video?.videoUrl || "").trim();
    if (!videoUrl) {
      return {
        payload: { content: text },
        videoUsed: false
      };
    }

    const trimmedText = String(text || "").trim();
    const content = trimmedText ? `${trimmedText}\n${videoUrl}` : videoUrl;
    return {
      payload: { content },
      videoUsed: true
    };
  }

  buildMessagePayloadWithGif(text, gifUrl) {
    const normalizedUrl = String(gifUrl || "").trim();
    if (!normalizedUrl) {
      return {
        payload: { content: text },
        gifUsed: false
      };
    }

    const trimmedText = String(text || "").trim();
    const content = trimmedText ? `${trimmedText}\n${normalizedUrl}` : normalizedUrl;
    return {
      payload: { content },
      gifUsed: true
    };
  }

  isUserBlocked(settings, userId) {
    return settings.permissions.blockedUserIds.includes(String(userId));
  }

  isChannelAllowed(settings, channelId) {
    const id = String(channelId);

    if (settings.permissions.blockedChannelIds.includes(id)) {
      return false;
    }

    const allowList = settings.permissions.allowedChannelIds;
    if (allowList.length === 0) return true;

    return allowList.includes(id);
  }

  isInitiativeChannel(settings, channelId) {
    const id = String(channelId);
    return settings.permissions.initiativeChannelIds.includes(id);
  }

  isDirectlyAddressed(_settings, message) {
    const mentioned = message.mentions?.users?.has(this.client.user.id);
    const isReplyToBot = message.mentions?.repliedUser?.id === this.client.user.id;
    return Boolean(mentioned || isReplyToBot);
  }

  async resolveDeterministicMentions({ text, guild, guildId }) {
    const runtime = createMentionResolutionRuntime(this);
    return await resolveDeterministicMentionsForMentions(runtime, {
      text,
      guild,
      guildId
    });
  }

  buildMentionAliasIndex({ guild, guildId }) {
    const runtime = createMentionResolutionRuntime(this);
    return buildMentionAliasIndexForMentions(runtime, { guild, guildId });
  }

  async lookupGuildMembersByExactName(guild, lookupKey) {
    return await lookupGuildMembersByExactNameForMentions({ guild, lookupKey });
  }

  hasBotMessageInRecentWindow({
    recentMessages,
    windowSize = UNSOLICITED_REPLY_CONTEXT_WINDOW,
    triggerMessageId = null
  }) {
    return hasBotMessageInRecentWindowForReplyAdmission({
      botUserId: this.client.user?.id,
      recentMessages,
      windowSize,
      triggerMessageId
    });
  }

  hasStartupFollowupAfterMessage({
    messages,
    messageIndex,
    triggerMessageId,
    windowSize = UNSOLICITED_REPLY_CONTEXT_WINDOW
  }) {
    return hasStartupFollowupAfterMessageForReplyAdmission({
      botUserId: this.client.user?.id,
      messages,
      messageIndex,
      triggerMessageId,
      windowSize
    });
  }

  shouldAttemptReplyDecision({
    settings,
    recentMessages,
    addressSignal,
    forceRespond = false,
    triggerMessageId = null
  }) {
    return shouldAttemptReplyDecisionForReplyAdmission({
      botUserId: this.client.user?.id,
      settings,
      recentMessages,
      addressSignal,
      forceRespond,
      triggerMessageId,
      windowSize: UNSOLICITED_REPLY_CONTEXT_WINDOW
    });
  }

  getReplyAddressSignal(settings, message, recentMessages = []) {
    const runtime = createReplyAdmissionRuntime(this);
    return getReplyAddressSignalForReplyAdmission(runtime, settings, message, recentMessages);
  }

  async runStartupTasks() {
    if (this.isStopping) return;
    if (this.startupTasksRan) return;
    this.startupTasksRan = true;

    const settings = this.store.getSettings();
    await this.runStartupCatchup(settings);
    await this.maybeRunInitiativeCycle({ startup: true });
    await this.maybeRunAutomationCycle();
  }

  async runStartupCatchup(settings) {
    const runtime = createStartupCatchupRuntime(this);
    return await runStartupCatchupForStartupCatchup(runtime, settings);
  }

  async maybeRunAutomationCycle() {
    if (this.automationCycleRunning) return;
    this.automationCycleRunning = true;

    try {
      const dueRows = this.store.claimDueAutomations({
        now: new Date().toISOString(),
        limit: MAX_AUTOMATION_RUNS_PER_TICK
      });
      if (!dueRows.length) return;

      for (const row of dueRows) {
        await this.runAutomationJob(row);
      }
    } finally {
      this.automationCycleRunning = false;
    }
  }

  async runAutomationJob(automation) {
    const startedAt = new Date().toISOString();
    const guildId = String(automation?.guild_id || "").trim();
    const channelId = String(automation?.channel_id || "").trim();
    const automationId = Number(automation?.id || 0);
    if (!guildId || !channelId || !Number.isInteger(automationId) || automationId <= 0) return;

    const settings = this.store.getSettings();
    let status = "active";
    let nextRunAt = null;
    let runStatus = "ok";
    let summary = "";
    let errorText = "";
    let sentMessageId = null;
    let retrySoon = false;

    try {
      if (!this.isChannelAllowed(settings, channelId)) {
        runStatus = "error";
        errorText = "channel blocked by current settings";
      } else if (!this.canSendMessage(settings.permissions.maxMessagesPerHour)) {
        runStatus = "skipped";
        summary = "hourly message cap hit; retrying soon";
        retrySoon = true;
      } else if (!this.canTalkNow(settings)) {
        runStatus = "skipped";
        summary = "message cooldown active; retrying soon";
        retrySoon = true;
      } else {
        const channel = this.client.channels.cache.get(channelId);
        if (!channel || !channel.isTextBased?.() || typeof channel.send !== "function") {
          runStatus = "error";
          errorText = "channel unavailable";
        } else {
          const generationResult = await this.generateAutomationPayload({
            automation,
            settings,
            channel
          });

          if (generationResult.skip) {
            runStatus = "skipped";
            summary = generationResult.summary || "model skipped this run";
          } else {
            await channel.sendTyping();
            await sleep(this.getSimulatedTypingDelayMs(350, 1100));
            const sent = await channel.send(generationResult.payload);
            sentMessageId = sent.id;
            summary = generationResult.summary || "posted";
            this.markSpoke();
            this.store.recordMessage({
              messageId: sent.id,
              createdAt: sent.createdTimestamp,
              guildId: sent.guildId,
              channelId: sent.channelId,
              authorId: this.client.user.id,
              authorName: settings.botName,
              isBot: true,
              content: this.composeMessageContentForHistory(sent, generationResult.text),
              referencedMessageId: null
            });
            this.store.logAction({
              kind: "automation_post",
              guildId: sent.guildId,
              channelId: sent.channelId,
              messageId: sent.id,
              userId: this.client.user.id,
              content: generationResult.text,
              metadata: {
                automationId,
                media: generationResult.media || null,
                llm: generationResult.llm || null
              }
            });
          }
        }
      }
    } catch (error) {
      runStatus = "error";
      errorText = String(error?.message || error);
    }

    if (runStatus === "error") {
      status = "paused";
      nextRunAt = null;
    } else if (retrySoon) {
      nextRunAt = new Date(Date.now() + 5 * 60_000).toISOString();
    } else {
      nextRunAt = resolveFollowingNextRunAt({
        schedule: automation.schedule,
        previousNextRunAt: automation.next_run_at,
        runFinishedMs: Date.now()
      });
      if (!nextRunAt) {
        status = "paused";
      }
    }

    const finishedAt = new Date().toISOString();
    const finalized = this.store.finalizeAutomationRun({
      automationId,
      guildId,
      status,
      nextRunAt,
      lastRunAt: finishedAt,
      lastError: errorText || null,
      lastResult: summary || (runStatus === "error" ? "error" : runStatus)
    });
    this.store.recordAutomationRun({
      automationId,
      startedAt,
      finishedAt,
      status: runStatus,
      summary: summary || null,
      error: errorText || null,
      messageId: sentMessageId,
      metadata: {
        nextRunAt,
        statusAfterRun: finalized?.status || status
      }
    });

    this.store.logAction({
      kind: runStatus === "error" ? "automation_error" : "automation_run",
      guildId,
      channelId,
      messageId: sentMessageId,
      userId: this.client.user?.id || null,
      content:
        runStatus === "error"
          ? `automation #${automationId}: ${errorText || "run failed"}`
          : `automation #${automationId}: ${summary || runStatus}`,
      metadata: {
        automationId,
        runStatus,
        statusAfterRun: finalized?.status || status,
        nextRunAt
      }
    });
  }

  async generateAutomationPayload({ automation, settings, channel }) {
    if (!this.llm?.generate) {
      const fallback = sanitizeBotText(String(automation?.instruction || "scheduled task"), 1200);
      return {
        skip: false,
        summary: fallback.slice(0, 220),
        text: fallback,
        payload: { content: fallback },
        media: null,
        llm: null
      };
    }

    const recentMessages = this.store.getRecentMessages(channel.id, settings.memory.maxRecentMessages);
    const automationOwnerId = String(automation?.created_by_user_id || "").trim() || null;
    const automationQuery = `${String(automation?.title || "")} ${String(automation?.instruction || "")}`
      .replace(/\s+/g, " ")
      .trim();
    const memorySlice = await this.loadPromptMemorySlice({
      settings,
      userId: automationOwnerId,
      guildId: automation.guild_id,
      channelId: automation.channel_id,
      queryText: automationQuery,
      trace: {
        guildId: automation.guild_id,
        channelId: automation.channel_id,
        userId: automationOwnerId
      },
      source: "automation_run"
    });

    const imageBudget = this.getImageBudgetState(settings);
    const videoBudget = this.getVideoGenerationBudgetState(settings);
    const gifBudget = this.getGifBudgetState(settings);
    const mediaCapabilities = this.getMediaGenerationCapabilities(settings);
    const mediaPromptLimit = resolveMaxMediaPromptLen(settings);
    const automationMediaMemoryFacts = this.buildMediaMemoryFacts({
      userFacts: memorySlice.userFacts,
      relevantFacts: memorySlice.relevantFacts
    });
    let memoryLookup = this.buildMemoryLookupContext({ settings });
    const promptBase = {
      instruction: automation.instruction,
      channelName: channel.name || "channel",
      recentMessages,
      relevantMessages: memorySlice.relevantMessages,
      userFacts: memorySlice.userFacts,
      relevantFacts: memorySlice.relevantFacts,
      allowSimpleImagePosts:
        settings.initiative.allowImagePosts && mediaCapabilities.simpleImageReady && imageBudget.canGenerate,
      allowComplexImagePosts:
        settings.initiative.allowImagePosts && mediaCapabilities.complexImageReady && imageBudget.canGenerate,
      allowVideoPosts:
        settings.initiative.allowVideoPosts && mediaCapabilities.videoReady && videoBudget.canGenerate,
      allowGifs: settings.initiative.allowReplyGifs && this.gifs?.isConfigured?.() && gifBudget.canFetch,
      remainingImages: imageBudget.remaining,
      remainingVideos: videoBudget.remaining,
      remainingGifs: gifBudget.remaining,
      maxMediaPromptChars: mediaPromptLimit,
      mediaPromptCraftGuidance: getMediaPromptCraftGuidance(settings)
    };
    const userPrompt = buildAutomationPrompt({
      ...promptBase,
      memoryLookup,
      allowMemoryLookupDirective: true
    });
    const automationSystemPrompt = buildSystemPrompt(settings);
    let generation = await this.llm.generate({
      settings,
      systemPrompt: automationSystemPrompt,
      userPrompt,
      trace: {
        guildId: automation.guild_id,
        channelId: automation.channel_id,
        userId: this.client.user?.id || null,
        source: "automation_run",
        event: `automation:${automation.id}`
      }
    });
    let directive = parseStructuredReplyOutput(generation.text, mediaPromptLimit);
    const followupGenerationSettings = this.resolveReplyFollowupGenerationSettings(settings);
    const followup = await this.maybeRegenerateWithMemoryLookup({
      settings,
      followupSettings: followupGenerationSettings,
      systemPrompt: automationSystemPrompt,
      generation,
      directive,
      memoryLookup,
      guildId: automation.guild_id,
      channelId: automation.channel_id,
      trace: {
        guildId: automation.guild_id,
        channelId: automation.channel_id,
        userId: this.client.user?.id || null,
        source: "automation_run",
        event: `automation:${automation.id}`
      },
      mediaPromptLimit,
      forceRegenerate: false,
      buildUserPrompt: ({ memoryLookup: nextMemoryLookup, allowMemoryLookupDirective }) =>
        buildAutomationPrompt({
          ...promptBase,
          memoryLookup: nextMemoryLookup,
          allowMemoryLookupDirective
        })
    });
    generation = followup.generation;
    directive = followup.directive;
    memoryLookup = followup.memoryLookup;

    let finalText = sanitizeBotText(normalizeSkipSentinel(directive.text || ""), 1200);
    if (!finalText) {
      finalText = sanitizeBotText(String(automation.instruction || "scheduled task"), 1200);
    }

    if (finalText === "[SKIP]") {
      return {
        skip: true,
        summary: "model skipped run",
        text: "",
        payload: null,
        media: null,
        llm: {
          provider: generation.provider,
          model: generation.model,
          usage: generation.usage,
          costUsd: generation.costUsd
        }
      };
    }

    const mediaDirective = pickReplyMediaDirective(directive);
    let payload = { content: finalText };
    let media = null;

    if (mediaDirective?.type === "gif" && directive.gifQuery) {
      const gifResult = await this.maybeAttachReplyGif({
        settings,
        text: finalText,
        query: directive.gifQuery,
        trace: {
          guildId: automation.guild_id,
          channelId: automation.channel_id,
          userId: this.client.user?.id || null,
          source: "automation_run"
        }
      });
      payload = gifResult.payload;
      if (gifResult.gifUsed) media = { type: "gif" };
    }

    if (mediaDirective?.type === "image_simple" && directive.imagePrompt) {
      const imageResult = await this.maybeAttachGeneratedImage({
        settings,
        text: finalText,
        prompt: composeReplyImagePrompt(
          directive.imagePrompt,
          finalText,
          mediaPromptLimit,
          automationMediaMemoryFacts
        ),
        variant: "simple",
        trace: {
          guildId: automation.guild_id,
          channelId: automation.channel_id,
          userId: this.client.user?.id || null,
          source: "automation_run"
        }
      });
      payload = imageResult.payload;
      if (imageResult.imageUsed) media = { type: "image_simple" };
    }

    if (mediaDirective?.type === "image_complex" && directive.complexImagePrompt) {
      const imageResult = await this.maybeAttachGeneratedImage({
        settings,
        text: finalText,
        prompt: composeReplyImagePrompt(
          directive.complexImagePrompt,
          finalText,
          mediaPromptLimit,
          automationMediaMemoryFacts
        ),
        variant: "complex",
        trace: {
          guildId: automation.guild_id,
          channelId: automation.channel_id,
          userId: this.client.user?.id || null,
          source: "automation_run"
        }
      });
      payload = imageResult.payload;
      if (imageResult.imageUsed) media = { type: "image_complex" };
    }

    if (mediaDirective?.type === "video" && directive.videoPrompt) {
      const videoResult = await this.maybeAttachGeneratedVideo({
        settings,
        text: finalText,
        prompt: composeReplyVideoPrompt(
          directive.videoPrompt,
          finalText,
          mediaPromptLimit,
          automationMediaMemoryFacts
        ),
        trace: {
          guildId: automation.guild_id,
          channelId: automation.channel_id,
          userId: this.client.user?.id || null,
          source: "automation_run"
        }
      });
      payload = videoResult.payload;
      if (videoResult.videoUsed) media = { type: "video" };
    }

    return {
      skip: false,
      summary: finalText.slice(0, 220),
      text: finalText,
      payload,
      media,
      llm: {
        provider: generation.provider,
        model: generation.model,
        usage: generation.usage,
        costUsd: generation.costUsd
      }
    };
  }

  getStartupScanChannels(settings) {
    const channels = [];
    const seen = new Set();

    const explicit = [
      ...settings.permissions.initiativeChannelIds,
      ...settings.permissions.allowedChannelIds
    ];

    for (const id of explicit) {
      const channel = this.client.channels.cache.get(String(id));
      if (!channel || !channel.isTextBased?.() || typeof channel.send !== "function") continue;
      if (seen.has(channel.id)) continue;
      seen.add(channel.id);
      channels.push(channel);
    }

    if (channels.length) return channels;

    for (const guild of this.client.guilds.cache.values()) {
      const guildChannels = guild.channels.cache
        .filter((channel) => channel.isTextBased?.() && typeof channel.send === "function")
        .first(8);

      for (const channel of guildChannels) {
        if (seen.has(channel.id)) continue;
        if (!this.isChannelAllowed(settings, channel.id)) continue;
        seen.add(channel.id);
        channels.push(channel);
      }
    }

    return channels;
  }

  async hydrateRecentMessages(channel, limit) {
    try {
      const fetched = await channel.messages.fetch({ limit });
      const sorted = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

      for (const message of sorted) {
        this.store.recordMessage({
          messageId: message.id,
          createdAt: message.createdTimestamp,
          guildId: message.guildId,
          channelId: message.channelId,
          authorId: message.author?.id || "unknown",
          authorName: message.member?.displayName || message.author?.username || "unknown",
          isBot: Boolean(message.author?.bot),
          content: this.composeMessageContentForHistory(message, String(message.content || "").trim()),
          referencedMessageId: message.reference?.messageId
        });
      }

      return sorted;
    } catch {
      return [];
    }
  }

  async maybeRunInitiativeCycle({ startup = false } = {}) {
    if (this.initiativePosting) return;
    this.initiativePosting = true;

    try {
      const settings = this.store.getSettings();
      if (!settings.initiative?.enabled) return;
      if (!settings.permissions.initiativeChannelIds.length) return;
      if (settings.initiative.maxPostsPerDay <= 0) return;
      if (!this.canSendMessage(settings.permissions.maxMessagesPerHour)) return;
      if (!this.canTalkNow(settings)) return;

      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const posts24h = this.store.countInitiativePostsSince(since24h);
      if (posts24h >= settings.initiative.maxPostsPerDay) return;

      const lastPostAt = this.store.getLastActionTime("initiative_post");
      const lastPostTs = lastPostAt ? new Date(lastPostAt).getTime() : 0;
      const nowTs = Date.now();
      const elapsedMs = lastPostTs ? nowTs - lastPostTs : null;
      const scheduleDecision = this.evaluateInitiativeSchedule({
        settings,
        startup,
        lastPostTs,
        elapsedMs,
        posts24h
      });
      if (!scheduleDecision.shouldPost) return;

      const channel = this.pickInitiativeChannel(settings);
      if (!channel) return;

      const recent = await this.hydrateRecentMessages(channel, settings.memory.maxRecentMessages);
      const recentMessages = recent.length
        ? recent
            .slice()
            .reverse()
            .slice(0, settings.memory.maxRecentMessages)
            .map((msg) => ({
              author_name: msg.member?.displayName || msg.author?.username || "unknown",
              content: String(msg.content || "").trim()
            }))
        : this.store.getRecentMessages(channel.id, settings.memory.maxRecentMessages);
      const initiativeMemoryQuery = recentMessages
        .slice(0, 6)
        .map((row) => String(row?.content || "").trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 320);
      const initiativeRelevantFacts = await this.loadRelevantMemoryFacts({
        settings,
        guildId: channel.guildId,
        channelId: channel.id,
        queryText: initiativeMemoryQuery,
        trace: {
          guildId: channel.guildId,
          channelId: channel.id,
          userId: this.client.user.id,
          source: "initiative_prompt"
        },
        limit: 8
      });
      const initiativeMediaMemoryFacts = this.buildMediaMemoryFacts({
        userFacts: [],
        relevantFacts: initiativeRelevantFacts
      });

      const discoveryResult = await this.collectDiscoveryForInitiative({
        settings,
        channel,
        recentMessages
      });
      const requireDiscoveryLink =
        discoveryResult.enabled &&
        discoveryResult.candidates.length > 0 &&
        chance((settings.initiative?.discovery?.linkChancePercent || 0) / 100);
      const initiativeImageBudget = this.getImageBudgetState(settings);
      const initiativeVideoBudget = this.getVideoGenerationBudgetState(settings);
      const initiativeMediaCapabilities = this.getMediaGenerationCapabilities(settings);
      const initiativeSimpleImageCapabilityReady = initiativeMediaCapabilities.simpleImageReady;
      const initiativeComplexImageCapabilityReady = initiativeMediaCapabilities.complexImageReady;
      const initiativeImageCapabilityReady =
        initiativeSimpleImageCapabilityReady || initiativeComplexImageCapabilityReady;
      const initiativeVideoCapabilityReady = initiativeMediaCapabilities.videoReady;

      const systemPrompt = buildSystemPrompt(settings);
      const userPrompt = buildInitiativePrompt({
        channelName: channel.name || "channel",
        recentMessages,
        relevantFacts: initiativeRelevantFacts,
        emojiHints: this.getEmojiHints(channel.guild),
        allowSimpleImagePosts:
          settings.initiative.allowImagePosts &&
          initiativeSimpleImageCapabilityReady &&
          initiativeImageBudget.canGenerate,
        allowComplexImagePosts:
          settings.initiative.allowImagePosts &&
          initiativeComplexImageCapabilityReady &&
          initiativeImageBudget.canGenerate,
        remainingInitiativeImages: initiativeImageBudget.remaining,
        allowVideoPosts:
          settings.initiative.allowVideoPosts &&
          initiativeVideoCapabilityReady &&
          initiativeVideoBudget.canGenerate,
        remainingInitiativeVideos: initiativeVideoBudget.remaining,
        discoveryFindings: discoveryResult.candidates,
        maxLinksPerPost: settings.initiative?.discovery?.maxLinksPerPost || 2,
        requireDiscoveryLink,
        maxMediaPromptChars: resolveMaxMediaPromptLen(settings),
        mediaPromptCraftGuidance: getMediaPromptCraftGuidance(settings)
      });

      const generation = await this.llm.generate({
        settings,
        systemPrompt,
        userPrompt,
        trace: {
          guildId: channel.guildId,
          channelId: channel.id,
          userId: this.client.user.id
        }
      });

      const initiativeMediaPromptLimit = resolveMaxMediaPromptLen(settings);
      const initiativeDirective = parseInitiativeMediaDirective(generation.text, initiativeMediaPromptLimit);
      const imagePrompt = initiativeDirective.imagePrompt;
      const complexImagePrompt = initiativeDirective.complexImagePrompt;
      const videoPrompt = initiativeDirective.videoPrompt;
      const mediaDirective = pickInitiativeMediaDirective(initiativeDirective);
      let finalText = sanitizeBotText(initiativeDirective.text || (mediaDirective ? "" : generation.text));
      finalText = normalizeSkipSentinel(finalText);
      const allowMediaOnlyInitiative = !finalText && Boolean(mediaDirective);
      if (finalText === "[SKIP]") return;
      if (!finalText && !allowMediaOnlyInitiative) {
        this.store.logAction({
          kind: "bot_error",
          guildId: channel.guildId,
          channelId: channel.id,
          userId: this.client.user?.id || null,
          content: "initiative_model_output_empty",
          metadata: {
            source: startup ? "initiative_startup" : "initiative_scheduler"
          }
        });
        return;
      }
      const linkPolicy = this.applyDiscoveryLinkPolicy({
        text: finalText,
        candidates: discoveryResult.candidates,
        selected: discoveryResult.selected,
        requireDiscoveryLink
      });
      finalText = normalizeSkipSentinel(linkPolicy.text);
      const allowMediaOnlyAfterLinkPolicy = !finalText && Boolean(mediaDirective);
      if (finalText === "[SKIP]") return;
      if (!finalText && !allowMediaOnlyAfterLinkPolicy) {
        this.store.logAction({
          kind: "bot_error",
          guildId: channel.guildId,
          channelId: channel.id,
          userId: this.client.user?.id || null,
          content: "initiative_model_output_empty_after_link_policy",
          metadata: {
            source: startup ? "initiative_startup" : "initiative_scheduler",
            forcedLink: Boolean(linkPolicy.forcedLink)
          }
        });
        return;
      }
      const mentionResolution = await this.resolveDeterministicMentions({
        text: finalText,
        guild: channel.guild,
        guildId: channel.guildId
      });
      finalText = mentionResolution.text;

      let payload = { content: finalText };
      let imageUsed = false;
      let imageBudgetBlocked = false;
      let imageCapabilityBlocked = false;
      let imageVariantUsed = null;
      let videoUsed = false;
      let videoBudgetBlocked = false;
      let videoCapabilityBlocked = false;
      if (mediaDirective?.type === "image_simple" && settings.initiative.allowImagePosts && imagePrompt) {
        const imageResult = await this.maybeAttachGeneratedImage({
          settings,
          text: finalText,
          prompt: composeInitiativeImagePrompt(
            imagePrompt,
            finalText,
            initiativeMediaPromptLimit,
            initiativeMediaMemoryFacts
          ),
          variant: "simple",
          trace: {
            guildId: channel.guildId,
            channelId: channel.id,
            userId: this.client.user.id,
            source: "initiative_post"
          }
        });
        payload = imageResult.payload;
        imageUsed = imageResult.imageUsed;
        imageBudgetBlocked = imageResult.blockedByBudget;
        imageCapabilityBlocked = imageResult.blockedByCapability;
        imageVariantUsed = imageResult.variant || "simple";
      }

      if (
        mediaDirective?.type === "image_complex" &&
        settings.initiative.allowImagePosts &&
        complexImagePrompt
      ) {
        const imageResult = await this.maybeAttachGeneratedImage({
          settings,
          text: finalText,
          prompt: composeInitiativeImagePrompt(
            complexImagePrompt,
            finalText,
            initiativeMediaPromptLimit,
            initiativeMediaMemoryFacts
          ),
          variant: "complex",
          trace: {
            guildId: channel.guildId,
            channelId: channel.id,
            userId: this.client.user.id,
            source: "initiative_post"
          }
        });
        payload = imageResult.payload;
        imageUsed = imageResult.imageUsed;
        imageBudgetBlocked = imageResult.blockedByBudget;
        imageCapabilityBlocked = imageResult.blockedByCapability;
        imageVariantUsed = imageResult.variant || "complex";
      }

      if (mediaDirective?.type === "video" && settings.initiative.allowVideoPosts && videoPrompt) {
        const videoResult = await this.maybeAttachGeneratedVideo({
          settings,
          text: finalText,
          prompt: composeInitiativeVideoPrompt(
            videoPrompt,
            finalText,
            initiativeMediaPromptLimit,
            initiativeMediaMemoryFacts
          ),
          trace: {
            guildId: channel.guildId,
            channelId: channel.id,
            userId: this.client.user.id,
            source: "initiative_post"
          }
        });
        payload = videoResult.payload;
        videoUsed = videoResult.videoUsed;
        videoBudgetBlocked = videoResult.blockedByBudget;
        videoCapabilityBlocked = videoResult.blockedByCapability;
      }

      if (!finalText && !imageUsed && !videoUsed) {
        this.store.logAction({
          kind: "bot_error",
          guildId: channel.guildId,
          channelId: channel.id,
          userId: this.client.user?.id || null,
          content: "initiative_model_output_empty_after_media",
          metadata: {
            source: startup ? "initiative_startup" : "initiative_scheduler"
          }
        });
        return;
      }

      await channel.sendTyping();
      await sleep(this.getSimulatedTypingDelayMs(500, 1200));

      const sent = await channel.send(payload);

      this.markSpoke();
      this.store.recordMessage({
        messageId: sent.id,
        createdAt: sent.createdTimestamp,
        guildId: sent.guildId,
        channelId: sent.channelId,
        authorId: this.client.user.id,
        authorName: settings.botName,
        isBot: true,
        content: this.composeMessageContentForHistory(sent, finalText),
        referencedMessageId: null
      });
      for (const sharedLink of linkPolicy.usedLinks) {
        this.store.recordSharedLink({
          url: sharedLink.url,
          source: sharedLink.source
        });
      }

      this.store.logAction({
        kind: "initiative_post",
        guildId: sent.guildId,
        channelId: sent.channelId,
        messageId: sent.id,
        userId: this.client.user.id,
        content: finalText,
        metadata: {
          source: startup ? "initiative_startup" : "initiative_scheduler",
          pacing: {
            mode: scheduleDecision.mode,
            trigger: scheduleDecision.trigger,
            chance: scheduleDecision.chance ?? null,
            roll: scheduleDecision.roll ?? null,
            elapsedMs: scheduleDecision.elapsedMs ?? null,
            requiredIntervalMs: scheduleDecision.requiredIntervalMs ?? null
          },
          discovery: {
            enabled: discoveryResult.enabled,
            requiredLink: requireDiscoveryLink,
            topics: discoveryResult.topics,
            candidateCount: discoveryResult.candidates.length,
            selectedCount: discoveryResult.selected.length,
            usedLinks: linkPolicy.usedLinks,
            forcedLink: linkPolicy.forcedLink,
            reports: discoveryResult.reports,
            errors: discoveryResult.errors
          },
          mentions: mentionResolution,
          imageRequestedByModel: Boolean(imagePrompt || complexImagePrompt),
          imageRequestedSimpleByModel: Boolean(imagePrompt),
          imageRequestedComplexByModel: Boolean(complexImagePrompt),
          imageUsed,
          imageVariantUsed,
          imageBudgetBlocked,
          imageCapabilityBlocked,
          imageSimpleCapabilityReadyAtPromptTime: initiativeSimpleImageCapabilityReady,
          imageComplexCapabilityReadyAtPromptTime: initiativeComplexImageCapabilityReady,
          imageCapabilityReadyAtPromptTime: initiativeImageCapabilityReady,
          videoRequestedByModel: Boolean(videoPrompt),
          videoUsed,
          videoBudgetBlocked,
          videoCapabilityBlocked,
          videoCapabilityReadyAtPromptTime: initiativeVideoCapabilityReady,
          llm: {
            provider: generation.provider,
            model: generation.model,
            usage: generation.usage,
            costUsd: generation.costUsd
          }
        }
      });
    } finally {
      this.initiativePosting = false;
    }
  }

  async collectDiscoveryForInitiative({ settings, channel, recentMessages }) {
    if (!this.discovery || !settings.initiative?.discovery?.enabled) {
      return {
        enabled: false,
        topics: [],
        candidates: [],
        selected: [],
        reports: [],
        errors: []
      };
    }

    try {
      return await this.discovery.collect({
        settings,
        guildId: channel.guildId,
        channelId: channel.id,
        channelName: channel.name || "channel",
        recentMessages
      });
    } catch (error) {
      this.store.logAction({
        kind: "bot_error",
        guildId: channel.guildId,
        channelId: channel.id,
        userId: this.client.user?.id || null,
        content: `initiative_discovery: ${String(error?.message || error)}`
      });

      return {
        enabled: true,
        topics: [],
        candidates: [],
        selected: [],
        reports: [],
        errors: [String(error?.message || error)]
      };
    }
  }

  applyDiscoveryLinkPolicy({ text, candidates, selected, requireDiscoveryLink }) {
    const cleanText = sanitizeBotText(text);
    const candidateMap = new Map(
      (candidates || []).map((item) => [normalizeDiscoveryUrl(item.url), item]).filter((entry) => Boolean(entry[0]))
    );
    const mentionedUrls = extractUrlsFromText(cleanText);
    const matchedLinks = mentionedUrls
      .map((url) => normalizeDiscoveryUrl(url))
      .filter(Boolean)
      .filter((url, index, arr) => arr.indexOf(url) === index)
      .map((url) => ({
        url,
        source: candidateMap.get(url)?.source || "initiative"
      }));

    if (matchedLinks.length || !requireDiscoveryLink) {
      return {
        text: cleanText,
        usedLinks: matchedLinks,
        forcedLink: false
      };
    }

    const fallbackPool = [...(selected || []), ...(candidates || [])];
    const fallback = fallbackPool.find((item) => normalizeDiscoveryUrl(item.url));
    if (!fallback) {
      return {
        text: "[SKIP]",
        usedLinks: [],
        forcedLink: false
      };
    }

    const fallbackUrl = normalizeDiscoveryUrl(fallback.url);
    const withForcedLink = sanitizeBotText(`${cleanText}\n${fallbackUrl}`);
    return {
      text: withForcedLink,
      usedLinks: [
        {
          url: fallbackUrl,
          source: fallback.source || "initiative"
        }
      ],
      forcedLink: true
    };
  }

  getInitiativePostingIntervalMs(settings) {
    return getInitiativePostingIntervalMs(settings);
  }

  getInitiativeAverageIntervalMs(settings) {
    return getInitiativeAverageIntervalMs(settings);
  }

  getInitiativePacingMode(settings) {
    return getInitiativePacingMode(settings);
  }

  getInitiativeMinGapMs(settings) {
    return getInitiativeMinGapMs(settings);
  }

  evaluateInitiativeSchedule({ settings, startup, lastPostTs, elapsedMs, posts24h }) {
    return evaluateInitiativeSchedule({
      settings,
      startup,
      lastPostTs,
      elapsedMs,
      posts24h
    });
  }

  evaluateSpontaneousInitiativeSchedule({ settings, lastPostTs, elapsedMs, posts24h, minGapMs }) {
    return evaluateSpontaneousInitiativeSchedule({
      settings,
      lastPostTs,
      elapsedMs,
      posts24h,
      minGapMs
    });
  }

  pickInitiativeChannel(settings) {
    return pickInitiativeChannel({
      settings,
      client: this.client,
      isChannelAllowed: (resolvedSettings, channelId) => this.isChannelAllowed(resolvedSettings, channelId)
    });
  }

  getEmojiHints(guild) {
    const custom = guild.emojis.cache
      .map((emoji) => (emoji.animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`))
      .slice(0, 24);

    return custom;
  }

  getReactionEmojiOptions(guild) {
    return guild.emojis.cache.map((emoji) => emoji.identifier).slice(0, 24);
  }

  getImageInputs(message) {
    const images = [];

    for (const attachment of message.attachments.values()) {
      if (images.length >= MAX_IMAGE_INPUTS) break;

      const url = String(attachment.url || attachment.proxyURL || "").trim();
      if (!url) continue;

      const filename = String(attachment.name || "").trim();
      const contentType = String(attachment.contentType || "").toLowerCase();
      const urlPath = url.split("?")[0];
      const isImage = contentType.startsWith("image/") || IMAGE_EXT_RE.test(filename) || IMAGE_EXT_RE.test(urlPath);
      if (!isImage) continue;

      images.push({ url, filename, contentType });
    }

    return images;
  }

  async syncMessageSnapshotFromReaction(reaction) {
    if (!reaction) return;

    let resolved = reaction;
    if (resolved.partial && typeof resolved.fetch === "function") {
      try {
        resolved = await resolved.fetch();
      } catch {
        return;
      }
    }

    await this.syncMessageSnapshot(resolved?.message);
  }

  async syncMessageSnapshot(message) {
    if (!message) return;

    let resolved = message;
    if (resolved.partial && typeof resolved.fetch === "function") {
      try {
        resolved = await resolved.fetch();
      } catch {
        return;
      }
    }

    if (!resolved?.guildId || !resolved?.channelId || !resolved?.id || !resolved?.author?.id) return;

    this.store.recordMessage({
      messageId: resolved.id,
      createdAt: resolved.createdTimestamp,
      guildId: resolved.guildId,
      channelId: resolved.channelId,
      authorId: resolved.author.id,
      authorName: resolved.member?.displayName || resolved.author.username || "unknown",
      isBot: Boolean(resolved.author.bot),
      content: this.composeMessageContentForHistory(resolved, String(resolved.content || "").trim()),
      referencedMessageId: resolved.reference?.messageId
    });
  }

  composeMessageContentForHistory(message, baseText = "") {
    const parts = [];
    const text = String(baseText || "").trim();
    if (text) parts.push(text);

    if (message?.attachments?.size) {
      for (const attachment of message.attachments.values()) {
        const url = String(attachment.url || attachment.proxyURL || "").trim();
        if (!url) continue;
        parts.push(url);
      }
    }

    if (Array.isArray(message?.embeds) && message.embeds.length) {
      for (const embed of message.embeds) {
        const videoUrl = String(embed?.video?.url || embed?.video?.proxyURL || "").trim();
        const embedUrl = String(embed?.url || "").trim();
        if (videoUrl) parts.push(videoUrl);
        if (embedUrl) parts.push(embedUrl);
      }
    }

    const reactionSummary = formatReactionSummary(message);
    if (reactionSummary) {
      parts.push(`[reactions: ${reactionSummary}]`);
    }

    return parts.join(" ").replace(/\s+/g, " ").trim();
  }
}

function safeUrlHost(rawUrl) {
  const text = String(rawUrl || "").trim();
  if (!text) return "";
  try {
    return String(new URL(text).host || "").trim().slice(0, 160);
  } catch {
    return "";
  }
}

function isLikelyImageUrl(rawUrl) {
  const text = String(rawUrl || "").trim();
  if (!text) return false;
  try {
    const parsed = new URL(text);
    const pathname = String(parsed.pathname || "").toLowerCase();
    if (IMAGE_EXT_RE.test(pathname) || pathname.endsWith(".avif")) return true;
    const formatParam = String(parsed.searchParams.get("format") || "").trim().toLowerCase();
    if (formatParam && /^(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/.test(formatParam)) return true;
    return false;
  } catch {
    return false;
  }
}

function parseHistoryImageReference(rawUrl) {
  const text = String(rawUrl || "").trim();
  if (!text) return { filename: "(unnamed)", contentType: "" };
  try {
    const parsed = new URL(text);
    const pathname = String(parsed.pathname || "");
    const segment = pathname.split("/").pop() || "";
    const decoded = decodeURIComponent(segment || "");
    const fallback = decoded || segment || "(unnamed)";
    const ext = fallback.includes(".") ? fallback.split(".").pop() : "";
    let contentType = normalizeImageContentTypeFromExt(ext);
    if (!contentType) {
      const formatParam = String(parsed.searchParams.get("format") || "").trim().toLowerCase();
      contentType = normalizeImageContentTypeFromExt(formatParam);
    }
    return {
      filename: fallback,
      contentType
    };
  } catch {
    return { filename: "(unnamed)", contentType: "" };
  }
}

function normalizeImageContentTypeFromExt(rawExt) {
  const ext = String(rawExt || "").trim().toLowerCase().replace(/^\./, "");
  if (!ext) return "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "bmp") return "image/bmp";
  if (ext === "heic") return "image/heic";
  if (ext === "heif") return "image/heif";
  if (ext === "avif") return "image/avif";
  return "";
}

function normalizeNonNegativeMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0) return null;
  return Math.floor(parsed);
}

function normalizeReplyPerformanceSeed(seed = {}) {
  const triggerMessageCreatedAtMs = normalizeNonNegativeMs(seed?.triggerMessageCreatedAtMs);
  const queuedAtMs = normalizeNonNegativeMs(seed?.queuedAtMs);
  const ingestMs = normalizeNonNegativeMs(seed?.ingestMs);
  if (triggerMessageCreatedAtMs === null && queuedAtMs === null && ingestMs === null) return null;

  return {
    triggerMessageCreatedAtMs,
    queuedAtMs,
    ingestMs
  };
}

function createReplyPerformanceTracker({ messageCreatedAtMs, source = "message_event", seed = null } = {}) {
  const normalizedSeed = normalizeReplyPerformanceSeed({
    triggerMessageCreatedAtMs: seed?.triggerMessageCreatedAtMs ?? messageCreatedAtMs,
    queuedAtMs: seed?.queuedAtMs,
    ingestMs: seed?.ingestMs
  });
  const startedAtMs = Date.now();

  return {
    source: String(source || "message_event"),
    startedAtMs,
    triggerMessageCreatedAtMs: normalizedSeed?.triggerMessageCreatedAtMs ?? normalizeNonNegativeMs(messageCreatedAtMs),
    queuedAtMs: normalizedSeed?.queuedAtMs ?? null,
    ingestMs: normalizedSeed?.ingestMs ?? null,
    memorySliceMs: null,
    llm1Ms: null,
    followupMs: null
  };
}

function finalizeReplyPerformanceSample({
  performance,
  actionKind,
  typingDelayMs = null,
  sendMs = null
} = {}) {
  if (!performance || typeof performance !== "object") return null;

  const finishedAtMs = Date.now();
  const triggerMessageCreatedAtMs = normalizeNonNegativeMs(performance.triggerMessageCreatedAtMs);
  const startedAtMs = normalizeNonNegativeMs(performance.startedAtMs);
  const queuedAtMs = normalizeNonNegativeMs(performance.queuedAtMs);
  const normalizedSendMs = normalizeNonNegativeMs(sendMs);
  const normalizedTypingDelayMs = normalizeNonNegativeMs(typingDelayMs);
  const triggerToFinishMs =
    triggerMessageCreatedAtMs !== null ? Math.max(0, finishedAtMs - triggerMessageCreatedAtMs) : null;
  const hasReasonableTriggerBaseline =
    triggerToFinishMs !== null && triggerToFinishMs <= 15 * 60 * 1000;
  const totalMs = hasReasonableTriggerBaseline
    ? triggerToFinishMs
    : queuedAtMs !== null
      ? Math.max(0, finishedAtMs - queuedAtMs)
      : startedAtMs !== null
        ? Math.max(0, finishedAtMs - startedAtMs)
        : null;
  const processingMs = startedAtMs !== null ? Math.max(0, finishedAtMs - startedAtMs) : null;
  const queueMs = startedAtMs !== null && queuedAtMs !== null ? Math.max(0, startedAtMs - queuedAtMs) : null;

  const sample = {
    version: REPLY_PERFORMANCE_VERSION,
    source: String(performance.source || "message_event"),
    actionKind: String(actionKind || "unknown"),
    totalMs: normalizeNonNegativeMs(totalMs),
    queueMs: normalizeNonNegativeMs(queueMs),
    processingMs: normalizeNonNegativeMs(processingMs),
    ingestMs: normalizeNonNegativeMs(performance.ingestMs),
    memorySliceMs: normalizeNonNegativeMs(performance.memorySliceMs),
    llm1Ms: normalizeNonNegativeMs(performance.llm1Ms),
    followupMs: normalizeNonNegativeMs(performance.followupMs),
    typingDelayMs: normalizedTypingDelayMs,
    sendMs: normalizedSendMs
  };

  const hasAnyTiming = [
    sample.totalMs,
    sample.queueMs,
    sample.processingMs,
    sample.ingestMs,
    sample.memorySliceMs,
    sample.llm1Ms,
    sample.followupMs,
    sample.typingDelayMs,
    sample.sendMs
  ].some((value) => typeof value === "number");
  return hasAnyTiming ? sample : null;
}
