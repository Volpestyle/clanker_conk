import {
  Client,
  GatewayIntentBits,
  Partials
} from "discord.js";
import {
  buildInitiativePrompt,
  buildReplyPrompt,
  buildSystemPrompt,
  buildVoiceTurnPrompt
} from "./prompts.ts";
import {
  buildHardLimitsSection,
  getPromptBotName,
  getPromptStyle,
  PROMPT_CAPABILITY_HONESTY_LINE
} from "./promptCore.ts";
import {
  MAX_GIF_QUERY_LEN,
  MAX_MENTION_CANDIDATES,
  MAX_VIDEO_FALLBACK_MESSAGES,
  MAX_VIDEO_TARGET_SCAN,
  MAX_WEB_QUERY_LEN,
  collectMemberLookupKeys,
  composeInitiativeImagePrompt,
  composeInitiativeVideoPrompt,
  composeReplyImagePrompt,
  composeReplyVideoPrompt,
  embedWebSearchSources,
  emptyMentionResolution,
  extractMentionCandidates,
  extractRecentVideoTargets,
  formatReactionSummary,
  isWebSearchOptOutText,
  looksLikeVideoFollowupMessage,
  normalizeDirectiveText,
  normalizeReactionEmojiToken,
  normalizeSkipSentinel,
  parseInitiativeMediaDirective,
  parseReplyDirectives,
  parseStructuredReplyOutput,
  pickInitiativeMediaDirective,
  pickReplyMediaDirective,
  resolveMaxMediaPromptLen,
  serializeForPrompt
} from "./botHelpers.ts";
import { normalizeDiscoveryUrl } from "./discovery.ts";
import { chance, clamp, hasBotKeyword, sanitizeBotText, sleep } from "./utils.ts";
import { VoiceSessionManager } from "./voice/voiceSessionManager.ts";

const UNICODE_REACTIONS = ["🔥", "💀", "😂", "👀", "🤝", "🫡", "😮", "🧠", "💯", "😭"];
const REPLY_QUEUE_MAX_PER_CHANNEL = 60;
const REPLY_QUEUE_RATE_LIMIT_WAIT_MS = 15_000;
const REPLY_QUEUE_SEND_RETRY_BASE_MS = 2_500;
const REPLY_QUEUE_SEND_MAX_RETRIES = 2;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i;
const MAX_IMAGE_INPUTS = 3;
const STARTUP_TASK_DELAY_MS = 4500;
const INITIATIVE_TICK_MS = 60_000;
const GATEWAY_WATCHDOG_TICK_MS = 30_000;
const GATEWAY_STALE_MS = 2 * 60_000;
const GATEWAY_RECONNECT_BASE_DELAY_MS = 5_000;
const GATEWAY_RECONNECT_MAX_DELAY_MS = 60_000;
const MAX_MODEL_IMAGE_INPUTS = 8;
const UNSOLICITED_REPLY_CONTEXT_WINDOW = 5;
const MENTION_GUILD_HISTORY_LOOKBACK = 500;
const MENTION_SEARCH_RESULT_LIMIT = 10;

export class ClankerBot {
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
    this.gatewayWatchdogTimer = null;
    this.reconnectTimeout = null;
    this.startupTasksRan = false;
    this.initiativePosting = false;
    this.reconnectInFlight = false;
    this.isStopping = false;
    this.hasConnectedAtLeastOnce = false;
    this.lastGatewayEventAt = Date.now();
    this.reconnectAttempts = 0;
    this.replyQueues = new Map();
    this.replyQueueWorkers = new Set();
    this.replyQueuedMessageIds = new Set();

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

  registerEvents() {
    this.client.on("ready", () => {
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
    this.gatewayWatchdogTimer = setInterval(() => {
      this.ensureGatewayHealthy().catch((error) => {
        this.store.logAction({
          kind: "bot_error",
          userId: this.client.user?.id,
          content: `gateway_watchdog: ${String(error?.message || error)}`
        });
      });
    }, GATEWAY_WATCHDOG_TICK_MS);

    setTimeout(() => {
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
    if (this.memoryTimer) clearInterval(this.memoryTimer);
    if (this.initiativeTimer) clearInterval(this.initiativeTimer);
    if (this.gatewayWatchdogTimer) clearInterval(this.gatewayWatchdogTimer);
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.gatewayWatchdogTimer = null;
    this.reconnectTimeout = null;
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

  async applyRuntimeSettings(nextSettings = null) {
    const settings = nextSettings || this.store.getSettings();
    await this.voiceSessionManager.reconcileSettings(settings);
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

  enqueueReplyJob({ message, source, forceRespond = false, addressSignal = null }) {
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
    const cooldownMs = settings.activity.minSecondsBetweenMessages * 1000;
    const elapsed = Date.now() - this.lastBotMessageAt;
    const cooldownWaitMs = Math.max(0, cooldownMs - elapsed);
    if (cooldownWaitMs > 0) return cooldownWaitMs;
    if (!this.canSendMessage(settings.permissions.maxMessagesPerHour)) {
      return REPLY_QUEUE_RATE_LIMIT_WAIT_MS;
    }
    return 0;
  }

  getReplyCoalesceWindowMs(settings) {
    const seconds = clamp(Number(settings.activity?.replyCoalesceWindowSeconds) || 0, 0, 20);
    return Math.floor(seconds * 1000);
  }

  getReplyCoalesceMaxMessages(settings) {
    return clamp(Number(settings.activity?.replyCoalesceMaxMessages) || 1, 1, 20);
  }

  getReplyCoalesceWaitMs(settings, message) {
    const windowMs = this.getReplyCoalesceWindowMs(settings);
    if (windowMs <= 0) return 0;
    const createdAtRaw = Number(message?.createdTimestamp);
    const createdAt = Number.isFinite(createdAtRaw) && createdAtRaw > 0 ? createdAtRaw : Date.now();
    const ageMs = Date.now() - createdAt;
    return Math.max(0, windowMs - ageMs);
  }

  dequeueReplyJob(channelId) {
    const queue = this.replyQueues.get(channelId);
    if (!queue?.length) return null;

    const job = queue.shift();
    if (job?.message?.id) {
      this.replyQueuedMessageIds.delete(String(job.message.id));
    }

    if (!queue.length) {
      this.replyQueues.delete(channelId);
    }

    return job;
  }

  dequeueReplyBurst(channelId, settings) {
    const firstJob = this.dequeueReplyJob(channelId);
    if (!firstJob) return [];

    const burst = [firstJob];
    const windowMs = this.getReplyCoalesceWindowMs(settings);
    const maxMessages = this.getReplyCoalesceMaxMessages(settings);
    if (windowMs <= 0 || maxMessages <= 1) return burst;

    const firstMessage = firstJob.message;
    const firstAuthorId = String(firstMessage?.author?.id || "").trim();
    if (!firstAuthorId) return burst;

    const firstCreatedAtRaw = Number(firstMessage?.createdTimestamp);
    const firstCreatedAt = Number.isFinite(firstCreatedAtRaw) && firstCreatedAtRaw > 0
      ? firstCreatedAtRaw
      : Date.now();

    while (burst.length < maxMessages) {
      const queue = this.replyQueues.get(channelId);
      const candidate = queue?.[0];
      if (!candidate) break;

      const candidateMessage = candidate.message;
      if (!candidateMessage?.id) {
        this.dequeueReplyJob(channelId);
        continue;
      }

      const candidateAuthorId = String(candidateMessage.author?.id || "").trim();
      if (candidateAuthorId !== firstAuthorId) break;

      const candidateCreatedAtRaw = Number(candidateMessage.createdTimestamp);
      const candidateCreatedAt = Number.isFinite(candidateCreatedAtRaw) && candidateCreatedAtRaw > 0
        ? candidateCreatedAtRaw
        : firstCreatedAt;
      if (Math.abs(candidateCreatedAt - firstCreatedAt) > windowMs) break;

      const nextJob = this.dequeueReplyJob(channelId);
      if (!nextJob) break;
      burst.push(nextJob);
    }

    return burst;
  }

  requeueReplyJobs(channelId, jobs) {
    const validJobs = (jobs || []).filter((job) => job?.message?.id);
    if (!validJobs.length) return;

    const queue = this.replyQueues.get(channelId) || [];
    queue.unshift(...validJobs);
    this.replyQueues.set(channelId, queue);
    for (const job of validJobs) {
      this.replyQueuedMessageIds.add(String(job.message.id));
    }
  }

  async processReplyQueue(channelId) {
    if (this.replyQueueWorkers.has(channelId)) return;
    this.replyQueueWorkers.add(channelId);

    try {
      while (!this.isStopping) {
        const queue = this.replyQueues.get(channelId);
        if (!queue?.length) break;

        const head = queue[0];
        const headMessage = head?.message;
        if (!headMessage?.id) {
          this.dequeueReplyJob(channelId);
          continue;
        }

        const settings = this.store.getSettings();

        if (!settings.permissions.allowReplies) {
          this.dequeueReplyJob(channelId);
          continue;
        }
        if (
          !headMessage.author ||
          String(headMessage.author.id || "") === String(this.client.user?.id || "")
        ) {
          this.dequeueReplyJob(channelId);
          continue;
        }
        if (!headMessage.guild || !headMessage.channel) {
          this.dequeueReplyJob(channelId);
          continue;
        }
        if (!this.isChannelAllowed(settings, headMessage.channelId)) {
          this.dequeueReplyJob(channelId);
          continue;
        }
        if (this.isUserBlocked(settings, headMessage.author.id)) {
          this.dequeueReplyJob(channelId);
          continue;
        }
        if (this.store.hasTriggeredResponse(headMessage.id)) {
          this.dequeueReplyJob(channelId);
          continue;
        }

        const coalesceWaitMs = this.getReplyCoalesceWaitMs(settings, headMessage);
        if (coalesceWaitMs > 0) {
          await sleep(Math.min(coalesceWaitMs, REPLY_QUEUE_RATE_LIMIT_WAIT_MS));
          continue;
        }

        const waitMs = this.getReplyQueueWaitMs(settings);
        if (waitMs > 0) {
          await sleep(Math.min(waitMs, REPLY_QUEUE_RATE_LIMIT_WAIT_MS));
          continue;
        }

        const burstJobs = this.dequeueReplyBurst(channelId, settings);
        if (!burstJobs.length) continue;

        const latestJob = burstJobs[burstJobs.length - 1];
        const message = latestJob?.message;
        if (!message?.id) continue;

        const triggerMessageIds = [
          ...new Set(burstJobs.map((job) => String(job?.message?.id || "").trim()).filter(Boolean))
        ];

        const recentMessages = this.store.getRecentMessages(
          message.channelId,
          settings.memory.maxRecentMessages
        );
        const addressSignal = {
          ...(latestJob.addressSignal || this.getReplyAddressSignal(settings, message, recentMessages))
        };
        addressSignal.direct = Boolean(addressSignal.direct);
        addressSignal.inferred = Boolean(addressSignal.inferred);
        addressSignal.triggered = Boolean(addressSignal.triggered);
        addressSignal.reason = String(addressSignal.reason || "llm_decides");

        for (const burstJob of burstJobs) {
          const burstMessage = burstJob?.message;
          if (!burstMessage?.id) continue;
          const signal =
            burstJob.addressSignal || this.getReplyAddressSignal(settings, burstMessage, recentMessages);
          if (!signal) continue;
          if (signal.direct) addressSignal.direct = true;
          if (signal.inferred) addressSignal.inferred = true;
          if (signal.triggered && !addressSignal.triggered) {
            addressSignal.triggered = true;
            addressSignal.reason = String(signal.reason || "direct");
          }
        }
        const forceRespond = burstJobs.some((job) => Boolean(job?.forceRespond || job?.addressSignal?.triggered));
        if (forceRespond && !addressSignal.triggered) {
          addressSignal.triggered = true;
          addressSignal.reason = "direct";
        }
        const source = burstJobs.length > 1
          ? `${latestJob.source || "message_event"}_coalesced`
          : latestJob.source || "message_event";

        try {
          const sent = await this.maybeReplyToMessage(message, settings, {
            forceRespond,
            source,
            addressSignal,
            recentMessages,
            triggerMessageIds
          });

          if (!sent && forceRespond && !this.isStopping && !this.store.hasTriggeredResponse(message.id)) {
            const latestSettings = this.store.getSettings();
            if (
              latestSettings.permissions.allowReplies &&
              this.isChannelAllowed(latestSettings, message.channelId) &&
              !this.isUserBlocked(latestSettings, message.author.id)
            ) {
              const retryWaitMs = this.getReplyQueueWaitMs(latestSettings);
              if (retryWaitMs > 0) {
                this.requeueReplyJobs(channelId, burstJobs);
                await sleep(Math.min(retryWaitMs, REPLY_QUEUE_RATE_LIMIT_WAIT_MS));
                continue;
              }
            }
          }
        } catch (error) {
          const maxAttempts = burstJobs.reduce(
            (max, job) => Math.max(max, Math.max(0, Number(job?.attempts) || 0)),
            0
          );
          if (maxAttempts < REPLY_QUEUE_SEND_MAX_RETRIES && !this.isStopping) {
            const nextAttempt = maxAttempts + 1;
            for (const job of burstJobs) {
              job.attempts = Math.max(0, Number(job?.attempts) || 0) + 1;
            }
            this.requeueReplyJobs(channelId, burstJobs);
            await sleep(REPLY_QUEUE_SEND_RETRY_BASE_MS * nextAttempt);
            continue;
          }

          this.store.logAction({
            kind: "bot_error",
            guildId: message.guildId,
            channelId: message.channelId,
            messageId: message.id,
            userId: message.author?.id || null,
            content: `reply_queue_send_failed: ${String(error?.message || error)}`
          });
        }
      }
    } finally {
      this.replyQueueWorkers.delete(channelId);
      if (!this.isStopping && this.replyQueues.get(channelId)?.length) {
        this.processReplyQueue(channelId).catch((error) => {
          this.store.logAction({
            kind: "bot_error",
            content: `reply_queue_restart: ${String(error?.message || error)}`
          });
        });
      }
    }
  }

  async ensureGatewayHealthy() {
    if (this.isStopping) return;
    if (this.reconnectInFlight) return;
    if (!this.hasConnectedAtLeastOnce) return;

    if (this.client.isReady()) {
      this.markGatewayEvent();
      return;
    }

    const elapsed = Date.now() - this.lastGatewayEventAt;
    if (elapsed < GATEWAY_STALE_MS) return;

    await this.reconnectGateway(`stale_gateway_${elapsed}ms`);
  }

  scheduleReconnect(reason, delayMs) {
    if (this.isStopping) return;
    if (this.reconnectTimeout) return;

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.reconnectGateway(reason).catch((error) => {
        this.store.logAction({
          kind: "bot_error",
          userId: this.client.user?.id,
          content: `gateway_reconnect_crash: ${String(error?.message || error)}`
        });
      });
    }, delayMs);
  }

  async reconnectGateway(reason) {
    if (this.isStopping) return;
    if (this.reconnectInFlight) return;
    this.reconnectInFlight = true;
    this.markGatewayEvent();

    this.store.logAction({
      kind: "bot_error",
      userId: this.client.user?.id,
      content: `gateway_reconnect_start: ${reason}`
    });

    try {
      try {
        await this.client.destroy();
      } catch {
        // ignore
      }
      await this.client.login(this.appConfig.discordToken);
      this.markGatewayEvent();
      this.reconnectAttempts = 0;
    } catch (error) {
      this.reconnectAttempts += 1;
      const backoffDelay = Math.min(
        GATEWAY_RECONNECT_BASE_DELAY_MS * 2 ** Math.max(this.reconnectAttempts - 1, 0),
        GATEWAY_RECONNECT_MAX_DELAY_MS
      );

      this.store.logAction({
        kind: "bot_error",
        userId: this.client.user?.id,
        content: `gateway_reconnect_failed: ${String(error?.message || error)}`,
        metadata: {
          attempt: this.reconnectAttempts,
          nextRetryMs: backoffDelay
        }
      });

      this.scheduleReconnect("retry_after_reconnect_failure", backoffDelay);
    } finally {
      this.reconnectInFlight = false;
    }
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
      await this.memory.ingestMessage({
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
      addressSignal,
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
    fallbackText = ""
  }) {
    if (!this.llm?.generate || !settings) return "";
    const normalizedEvent = String(event || "voice_runtime")
      .trim()
      .toLowerCase();
    const isVoiceSessionEnd = normalizedEvent === "voice_session_end";
    const operationalTemperature = isVoiceSessionEnd ? 0.35 : 0.55;
    const operationalMaxOutputTokens = isVoiceSessionEnd ? 60 : 100;

    const tunedSettings = {
      ...settings,
      llm: {
        ...(settings?.llm || {}),
        temperature: clamp(Number(settings?.llm?.temperature) || operationalTemperature, 0, 0.7),
        maxOutputTokens: clamp(Number(settings?.llm?.maxOutputTokens) || operationalMaxOutputTokens, 32, 110)
      }
    };

    const systemPrompt = [
      `You are ${getPromptBotName(settings)}, a Discord regular posting a voice-mode update.`,
      `Style: ${getPromptStyle(settings, "laid-back, concise, low-drama chat tone")}.`,
      "Write exactly one short user-facing message for the text channel.",
      "Keep it chill and simple. No overexplaining.",
      "Clearly state what happened and why, especially when a request is blocked.",
      "If relevant, mention required permissions/settings plainly.",
      "For voice_session_end, keep it to one brief sentence (4-12 words).",
      "Avoid dramatic wording, blame, apology spirals, and long postmortems.",
      PROMPT_CAPABILITY_HONESTY_LINE,
      ...buildHardLimitsSection(settings, { maxItems: 12 }),
      "Do not output JSON, markdown headings, code blocks, labels, directives, or [SKIP].",
      "Do not invent details that are not in the event payload."
    ].join("\n");

    const userPrompt = [
      `Event: ${String(event || "voice_runtime")}`,
      `Reason: ${String(reason || "unknown")}`,
      `Details JSON: ${serializeForPrompt(details, 1400)}`,
      fallbackText ? `Baseline meaning: ${String(fallbackText || "").trim()}` : "",
      isVoiceSessionEnd ? "Constraint: one chill sentence, 4-12 words." : "Constraint: one brief sentence.",
      "Return only the final message text."
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const generation = await this.llm.generate({
        settings: tunedSettings,
        systemPrompt,
        userPrompt,
        trace: {
          guildId,
          channelId,
          messageId,
          userId,
          source: "voice_operational_message",
          event,
          reason
        }
      });

      const parsed = parseReplyDirectives(generation.text, resolveMaxMediaPromptLen(settings));
      const normalized = sanitizeBotText(normalizeSkipSentinel(parsed.text || generation.text || ""), 180);
      if (!normalized || normalized === "[SKIP]") return "";
      return normalized;
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: guildId || null,
        channelId: channelId || null,
        messageId: messageId || null,
        userId: userId || null,
        content: `voice_operational_llm_failed: ${String(error?.message || error)}`,
        metadata: {
          event,
          reason
        }
      });
      return "";
    }
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
    voiceEagerness = 0
  }) {
    if (!this.llm?.generate || !settings) return { text: "" };
    const incomingTranscript = String(transcript || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 700);
    if (!incomingTranscript) return { text: "" };

    const normalizedContextMessages = (Array.isArray(contextMessages) ? contextMessages : [])
      .map((row) => ({
        role: row?.role === "assistant" ? "assistant" : "user",
        content: String(row?.content || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 520)
      }))
      .filter((row) => row.content)
      .slice(-10);

    const guild = this.client.guilds.cache.get(String(guildId || ""));
    const speakerName =
      guild?.members?.cache?.get(String(userId || ""))?.displayName ||
      guild?.members?.cache?.get(String(userId || ""))?.user?.username ||
      this.client.users?.cache?.get(String(userId || ""))?.username ||
      "unknown";

    if (settings.memory?.enabled && this.memory?.ingestMessage && userId) {
      try {
        await this.memory.ingestMessage({
          messageId: `voice-${String(guildId || "guild")}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          authorId: String(userId),
          authorName: String(speakerName || "unknown"),
          content: incomingTranscript,
          settings,
          trace: {
            guildId,
            channelId,
            userId,
            source: "voice_stt_pipeline_ingest"
          }
        });
      } catch (error) {
        this.store.logAction({
          kind: "voice_error",
          guildId,
          channelId,
          userId,
          content: `voice_stt_memory_ingest_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId
          }
        });
      }
    }

    const memorySlice = settings.memory?.enabled && this.memory?.buildPromptMemorySlice
      ? await this.memory.buildPromptMemorySlice({
          userId,
          guildId,
          channelId: null,
          queryText: incomingTranscript,
          settings,
          trace: {
            guildId,
            channelId,
            userId,
            source: "voice_stt_pipeline_generation"
          }
        })
      : { userFacts: [], relevantFacts: [], relevantMessages: [] };

    const tunedSettings = {
      ...settings,
      llm: {
        ...(settings?.llm || {}),
        temperature: clamp(Number(settings?.llm?.temperature) || 0.8, 0, 1.2),
        maxOutputTokens: clamp(Number(settings?.llm?.maxOutputTokens) || 220, 40, 180)
      }
    };

    const systemPrompt = [
      buildSystemPrompt(settings),
      "You are speaking in live Discord voice chat.",
      "Keep replies conversational. Be concise by default but go longer when it makes sense.",
      "Output plain spoken text only.",
      isEagerTurn
        ? "If responding would be an interruption or you have nothing to add, output exactly [SKIP]. Otherwise, output plain spoken text only, no directives or markdown."
        : "Do not output directives like [[...]], [SKIP], or markdown."
    ].join("\n");
    const userPrompt = buildVoiceTurnPrompt({
      speakerName,
      transcript: incomingTranscript,
      userFacts: memorySlice.userFacts,
      relevantFacts: memorySlice.relevantFacts,
      isEagerTurn,
      voiceEagerness
    });

    try {
      const generation = await this.llm.generate({
        settings: tunedSettings,
        systemPrompt,
        userPrompt,
        contextMessages: normalizedContextMessages,
        trace: {
          guildId,
          channelId,
          userId,
          source: "voice_stt_pipeline_generation",
          event: sessionId ? "voice_session" : "voice_turn"
        }
      });

      const parsed = parseReplyDirectives(generation.text, resolveMaxMediaPromptLen(settings));
      let finalText = sanitizeBotText(normalizeSkipSentinel(parsed.text || generation.text || ""), 520);
      if (!finalText || finalText === "[SKIP]") {
        return { text: "" };
      }

      if (settings.memory?.enabled && parsed.memoryLine && this.memory?.rememberLine && userId) {
        await this.memory
          .rememberLine({
            line: parsed.memoryLine,
            sourceMessageId: `voice-${String(guildId || "guild")}-${Date.now()}-memory`,
            userId: String(userId),
            guildId,
            channelId,
            sourceText: incomingTranscript
          })
          .catch(() => undefined);
      }

      return {
        text: finalText
      };
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId,
        channelId,
        userId,
        content: `voice_stt_generation_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId
        }
      });
      return { text: "" };
    }
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
    const replyEagerness = clamp(Number(settings.activity?.replyLevel) || 0, 0, 100);
    const reactionEagerness = clamp(Number(settings.activity?.reactionLevel) || 0, 0, 100);
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

    const memorySlice = settings.memory.enabled
      ? await this.memory.buildPromptMemorySlice({
          userId: message.author.id,
          guildId: message.guildId,
          channelId: message.channelId,
          queryText: message.content,
          settings,
          trace: {
            guildId: message.guildId,
            channelId: message.channelId,
            userId: message.author.id,
            source: options.source || "message_event"
          }
        })
      : { userFacts: [], relevantFacts: [], relevantMessages: [] };
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
        source: options.source || "message_event"
      }
    });
    const imageInputs = [...attachmentImageInputs, ...(videoContext.frameImages || [])].slice(0, MAX_MODEL_IMAGE_INPUTS);
    const replyTrace = {
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id
    };

    const systemPrompt = buildSystemPrompt(settings);
    const replyPromptBase = {
      message: {
        authorName: message.member?.displayName || message.author.username,
        content: message.content
      },
      imageInputs,
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
      voiceMode: {
        enabled: Boolean(settings?.voice?.enabled),
        joinOnTextNL: Boolean(settings?.voice?.joinOnTextNL)
      },
      videoContext,
      maxMediaPromptChars: resolveMaxMediaPromptLen(settings)
    };
    const initialUserPrompt = buildReplyPrompt({
      ...replyPromptBase,
      webSearch,
      memoryLookup,
      allowWebSearchDirective: true,
      allowMemoryLookupDirective: true
    });

    let generation = await this.llm.generate({
      settings,
      systemPrompt,
      userPrompt: initialUserPrompt,
      imageInputs,
      trace: replyTrace
    });
    let usedWebSearchFollowup = false;
    let usedMemoryLookupFollowup = false;
    const mediaPromptLimit = resolveMaxMediaPromptLen(settings);
    let replyDirective = parseStructuredReplyOutput(generation.text, mediaPromptLimit);
    let voiceIntentHandled = await this.maybeHandleStructuredVoiceIntent({
      message,
      settings,
      replyDirective
    });
    if (voiceIntentHandled) return true;

    if (replyDirective.webSearchQuery) {
      usedWebSearchFollowup = true;
      webSearch = await this.runModelRequestedWebSearch({
        settings,
        webSearch,
        query: replyDirective.webSearchQuery,
        trace: {
          ...replyTrace,
          source: options.source || "message_event"
        }
      });
    }

    if (replyDirective.memoryLookupQuery) {
      usedMemoryLookupFollowup = true;
      memoryLookup = await this.runModelRequestedMemoryLookup({
        settings,
        memoryLookup,
        query: replyDirective.memoryLookupQuery,
        guildId: message.guildId,
        channelId: message.channelId,
        trace: {
          ...replyTrace,
          source: options.source || "message_event"
        }
      });
    }

    if (usedWebSearchFollowup || usedMemoryLookupFollowup) {
      const followupUserPrompt = buildReplyPrompt({
        ...replyPromptBase,
        webSearch,
        memoryLookup,
        allowWebSearchDirective: false,
        allowMemoryLookupDirective: false
      });

      generation = await this.llm.generate({
        settings,
        systemPrompt,
        userPrompt: followupUserPrompt,
        imageInputs,
        trace: replyTrace
      });
      replyDirective = parseStructuredReplyOutput(generation.text, mediaPromptLimit);

      voiceIntentHandled = await this.maybeHandleStructuredVoiceIntent({
        message,
        settings,
        replyDirective
      });
      if (voiceIntentHandled) return true;
    }

    const reaction = await this.maybeApplyReplyReaction({
      message,
      settings,
      emojiOptions: reactionEmojiOptions,
      emojiToken: replyDirective.reactionEmoji,
      generation,
      source: options.source || "message_event",
      triggerMessageId: message.id,
      triggerMessageIds,
      addressing: addressSignal
    });

    const memoryLine = replyDirective.memoryLine;
    let memorySaved = false;
    if (settings.memory.enabled && memoryLine) {
      try {
        memorySaved = await this.memory.rememberLine({
          line: memoryLine,
          sourceMessageId: message.id,
          userId: message.author.id,
          guildId: message.guildId,
          channelId: message.channelId,
          sourceText: message.content
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
    let finalText = sanitizeBotText(replyDirective.text || (mediaDirective ? "here you go" : ""));
    let mentionResolution = emptyMentionResolution();
    finalText = normalizeSkipSentinel(finalText);
    if (!finalText || finalText === "[SKIP]") {
      this.logSkippedReply({
        message,
        source: options.source || "message_event",
        triggerMessageIds,
        addressSignal,
        generation,
        usedWebSearchFollowup,
        reason: finalText ? "llm_skip" : "empty_reply",
        reaction
      });
      return false;
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
        prompt: composeReplyImagePrompt(imagePrompt, finalText, mediaPromptLimit),
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
        prompt: composeReplyImagePrompt(complexImagePrompt, finalText, mediaPromptLimit),
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
        prompt: composeReplyVideoPrompt(videoPrompt, finalText, mediaPromptLimit),
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

    await message.channel.sendTyping();
    await sleep(600 + Math.floor(Math.random() * 1800));

    const canStandalonePost = this.isInitiativeChannel(settings, message.channelId);
    const shouldThreadReply = addressed || options.forceRespond;
    const sendAsReply = canStandalonePost ? (shouldThreadReply ? chance(0.65) : false) : true;
    const sent = sendAsReply
      ? await message.reply({
          ...payload,
          allowedMentions: { repliedUser: false }
        })
      : await message.channel.send(payload);
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
        source: options.source || "message_event",
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
          requestedByModel: Boolean(memoryLine),
          saved: memorySaved,
          lookupRequested: memoryLookup.requested,
          lookupUsed: memoryLookup.used,
          lookupQuery: memoryLookup.query,
          lookupResultCount: memoryLookup.results?.length || 0,
          lookupError: memoryLookup.error || null
        },
        mentions: mentionResolution,
        reaction,
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
          usedMemoryLookupFollowup
        }
      }
    });

    return true;
  }

  async maybeHandleStructuredVoiceIntent({ message, settings, replyDirective }) {
    const voiceSettings = settings?.voice || {};
    if (!voiceSettings.enabled || !voiceSettings.joinOnTextNL) return false;

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

    return false;
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
    generation,
    usedWebSearchFollowup,
    reason,
    reaction
  }) {
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
        llm: {
          provider: generation.provider,
          model: generation.model,
          usage: generation.usage,
          costUsd: generation.costUsd,
          usedWebSearchFollowup
        }
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
        const { frameImages, ...rest } = item || {};
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

  async runModelRequestedWebSearch({
    settings,
    webSearch,
    query,
    trace = {}
  }) {
    const normalizedQuery = normalizeDirectiveText(query, MAX_WEB_QUERY_LEN);
    const state = {
      ...webSearch,
      requested: true,
      query: normalizedQuery
    };

    if (!normalizedQuery) {
      return {
        ...state,
        error: "Missing web search query."
      };
    }

    if (state.optedOutByUser || !state.enabled || !state.configured) {
      return state;
    }

    if (!state.budget?.canSearch) {
      return {
        ...state,
        blockedByBudget: true
      };
    }

    try {
      const result = await this.search.searchAndRead({
        settings,
        query: normalizedQuery,
        trace
      });

      return {
        ...state,
        used: result.results.length > 0,
        query: result.query,
        results: result.results,
        fetchedPages: result.fetchedPages || 0,
        providerUsed: result.providerUsed || null,
        providerFallbackUsed: Boolean(result.providerFallbackUsed)
      };
    } catch (error) {
      return {
        ...state,
        error: String(error?.message || error)
      };
    }
  }

  async runModelRequestedMemoryLookup({
    settings,
    memoryLookup,
    query,
    guildId,
    channelId = null,
    trace = {}
  }) {
    const normalizedQuery = normalizeDirectiveText(query, MAX_WEB_QUERY_LEN);
    const state = {
      ...memoryLookup,
      requested: true,
      query: normalizedQuery
    };

    if (!state.enabled || !this.memory?.searchDurableFacts) {
      return state;
    }
    if (!normalizedQuery) {
      return {
        ...state,
        error: "Missing memory lookup query."
      };
    }
    if (!guildId) {
      return {
        ...state,
        error: "Memory lookup requires guild scope."
      };
    }

    try {
      const results = await this.memory.searchDurableFacts({
        guildId: String(guildId),
        channelId: String(channelId || "").trim() || null,
        queryText: normalizedQuery,
        settings,
        trace: {
          ...trace,
          source: "model_memory_lookup"
        },
        limit: 10
      });
      return {
        ...state,
        used: Boolean(results.length),
        results
      };
    } catch (error) {
      return {
        ...state,
        error: String(error?.message || error)
      };
    }
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
      return {
        payload: { content: `${text}\n${image.imageUrl}` },
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

  isDirectlyAddressed(settings, message) {
    const mentioned = message.mentions?.users?.has(this.client.user.id);
    const content = String(message.content || "");
    const namePing =
      content.toLowerCase().includes(settings.botName.toLowerCase()) || hasBotKeyword(content);
    const isReplyToBot = message.mentions?.repliedUser?.id === this.client.user.id;
    return Boolean(mentioned || namePing || isReplyToBot);
  }

  async resolveDeterministicMentions({ text, guild, guildId }) {
    const source = String(text || "");
    if (!source || !source.includes("@")) {
      return {
        text: source,
        attemptedCount: 0,
        resolvedCount: 0,
        ambiguousCount: 0,
        unresolvedCount: 0
      };
    }

    const candidates = extractMentionCandidates(source, MAX_MENTION_CANDIDATES);
    if (!candidates.length) {
      return {
        text: source,
        attemptedCount: 0,
        resolvedCount: 0,
        ambiguousCount: 0,
        unresolvedCount: 0
      };
    }

    const aliasIndex = this.buildMentionAliasIndex({ guild, guildId });
    const keys = [
      ...new Set(
        candidates.flatMap((item) => item.variants.map((variant) => variant.lookupKey))
      )
    ];
    const resolutionByKey = new Map();

    for (const key of keys) {
      const localIds = aliasIndex.get(key) || new Set();
      if (localIds.size === 1) {
        resolutionByKey.set(key, { status: "resolved", id: [...localIds][0] });
        continue;
      }
      if (localIds.size > 1) {
        resolutionByKey.set(key, { status: "ambiguous" });
        continue;
      }

      const guildIds = await this.lookupGuildMembersByExactName(guild, key);
      if (guildIds.size === 1) {
        resolutionByKey.set(key, { status: "resolved", id: [...guildIds][0] });
      } else if (guildIds.size > 1) {
        resolutionByKey.set(key, { status: "ambiguous" });
      } else {
        resolutionByKey.set(key, { status: "unresolved" });
      }
    }

    let output = source;
    let resolvedCount = 0;
    let ambiguousCount = 0;
    let unresolvedCount = 0;
    const sorted = candidates.slice().sort((a, b) => b.start - a.start);

    for (const candidate of sorted) {
      let selectedVariant = null;
      let ambiguous = false;

      for (const variant of candidate.variants) {
        const resolution = resolutionByKey.get(variant.lookupKey);
        if (!resolution) continue;
        if (resolution.status === "resolved") {
          selectedVariant = {
            end: variant.end,
            id: resolution.id
          };
          break;
        }
        if (resolution.status === "ambiguous") {
          ambiguous = true;
        }
      }

      if (selectedVariant) {
        output = `${output.slice(0, candidate.start)}<@${selectedVariant.id}>${output.slice(selectedVariant.end)}`;
        resolvedCount += 1;
      } else if (ambiguous) {
        ambiguousCount += 1;
      } else {
        unresolvedCount += 1;
      }
    }

    return {
      text: output,
      attemptedCount: candidates.length,
      resolvedCount,
      ambiguousCount,
      unresolvedCount
    };
  }

  buildMentionAliasIndex({ guild, guildId }) {
    const aliases = new Map();
    const addAlias = (name, id) => {
      const key = normalizeMentionLookupKey(name);
      const memberId = String(id || "").trim();
      if (!key || !memberId) return;
      if (key === "everyone" || key === "here") return;
      const existing = aliases.get(key) || new Set();
      existing.add(memberId);
      aliases.set(key, existing);
    };

    if (guild?.members?.cache?.size) {
      for (const member of guild.members.cache.values()) {
        addAlias(member?.displayName, member?.id);
        addAlias(member?.nickname, member?.id);
        addAlias(member?.user?.globalName, member?.id);
        addAlias(member?.user?.username, member?.id);
      }
    }

    if (guildId) {
      const rows = this.store.getRecentMessagesAcrossGuild(guildId, MENTION_GUILD_HISTORY_LOOKBACK);
      for (const row of rows) {
        addAlias(row?.author_name, row?.author_id);
      }
    }

    return aliases;
  }

  async lookupGuildMembersByExactName(guild, lookupKey) {
    if (!guild?.members?.search) return new Set();
    const query = String(lookupKey || "").trim();
    if (query.length < 2) return new Set();

    try {
      const matches = await guild.members.search({
        query: query.slice(0, 32),
        limit: MENTION_SEARCH_RESULT_LIMIT
      });
      const ids = new Set();
      for (const member of matches.values()) {
        const keys = collectMemberLookupKeys(member);
        if (keys.has(query)) {
          ids.add(String(member.id));
        }
      }
      return ids;
    } catch {
      return new Set();
    }
  }

  hasBotMessageInRecentWindow({
    recentMessages,
    windowSize = UNSOLICITED_REPLY_CONTEXT_WINDOW,
    triggerMessageId = null
  }) {
    const botId = String(this.client.user?.id || "").trim();
    if (!botId) return false;
    if (!Array.isArray(recentMessages) || !recentMessages.length) return false;

    const excludedMessageId = String(triggerMessageId || "").trim();
    const candidateMessages = excludedMessageId
      ? recentMessages.filter((row) => String(row?.message_id || "").trim() !== excludedMessageId)
      : recentMessages;

    const cappedWindow = clamp(Math.floor(windowSize), 1, 50);
    return candidateMessages
      .slice(0, cappedWindow)
      .some((row) => String(row?.author_id || "").trim() === botId);
  }

  hasStartupFollowupAfterMessage({
    messages,
    messageIndex,
    triggerMessageId,
    windowSize = UNSOLICITED_REPLY_CONTEXT_WINDOW
  }) {
    const botId = String(this.client.user?.id || "").trim();
    if (!botId) return false;
    if (!Array.isArray(messages) || !messages.length) return false;
    if (!Number.isInteger(messageIndex) || messageIndex < 0 || messageIndex >= messages.length) return false;

    const triggerId = String(triggerMessageId || "").trim();
    const startIndex = messageIndex + 1;

    if (triggerId) {
      for (let index = startIndex; index < messages.length; index += 1) {
        const candidate = messages[index];
        if (String(candidate?.author?.id || "").trim() !== botId) continue;

        const referencedId = String(
          candidate?.reference?.messageId || candidate?.referencedMessage?.id || ""
        ).trim();
        if (referencedId && referencedId === triggerId) {
          return true;
        }
      }
    }

    const cappedWindow = clamp(Math.floor(windowSize), 1, 50);
    const endIndex = Math.min(messages.length, startIndex + cappedWindow);
    for (let index = startIndex; index < endIndex; index += 1) {
      if (String(messages[index]?.author?.id || "").trim() === botId) {
        return true;
      }
    }

    return false;
  }

  shouldAttemptReplyDecision({
    settings,
    recentMessages,
    addressSignal,
    forceRespond = false,
    triggerMessageId = null
  }) {
    if (forceRespond || addressSignal?.triggered) return true;
    if (!settings.permissions.allowInitiativeReplies) return false;
    return this.hasBotMessageInRecentWindow({
      recentMessages,
      windowSize: UNSOLICITED_REPLY_CONTEXT_WINDOW,
      triggerMessageId
    });
  }

  getReplyAddressSignal(settings, message, recentMessages = []) {
    const referencedAuthorId = this.resolveReferencedAuthorId(message, recentMessages);
    const direct =
      this.isDirectlyAddressed(settings, message) ||
      (referencedAuthorId && referencedAuthorId === this.client.user?.id);
    return {
      direct: Boolean(direct),
      inferred: false,
      triggered: Boolean(direct),
      reason: direct ? "direct" : "llm_decides"
    };
  }

  resolveReferencedAuthorId(message, recentMessages = []) {
    const referenceId = String(message.reference?.messageId || "").trim();
    if (!referenceId) return null;

    const fromRecent = recentMessages.find((row) => String(row.message_id) === referenceId)?.author_id;
    if (fromRecent) return String(fromRecent);

    const fromResolved =
      message.reference?.resolved?.author?.id ||
      message.reference?.resolvedMessage?.author?.id ||
      message.referencedMessage?.author?.id;

    return fromResolved ? String(fromResolved) : null;
  }

  async runStartupTasks() {
    if (this.startupTasksRan) return;
    this.startupTasksRan = true;

    const settings = this.store.getSettings();
    await this.runStartupCatchup(settings);
    await this.maybeRunInitiativeCycle({ startup: true });
  }

  async runStartupCatchup(settings) {
    if (!settings.startup?.catchupEnabled) return;
    if (!settings.permissions.allowReplies) return;

    const channels = this.getStartupScanChannels(settings);
    const lookbackMs = settings.startup.catchupLookbackHours * 60 * 60_000;
    const maxMessages = settings.startup.catchupMaxMessagesPerChannel;
    const maxRepliesPerChannel = settings.startup.maxCatchupRepliesPerChannel;
    const now = Date.now();

    for (const channel of channels) {
      let repliesSent = 0;

      const messages = await this.hydrateRecentMessages(channel, maxMessages);
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (repliesSent >= maxRepliesPerChannel) break;
        if (
          !message?.author ||
          String(message.author.id || "") === String(this.client.user?.id || "")
        ) continue;
        if (!message.guild || !message.channel) continue;
        if (!this.isChannelAllowed(settings, message.channelId)) continue;
        if (this.isUserBlocked(settings, message.author.id)) continue;
        const recentMessages = this.store.getRecentMessages(
          message.channelId,
          settings.memory.maxRecentMessages
        );
        const addressSignal = this.getReplyAddressSignal(settings, message, recentMessages);
        if (!addressSignal.triggered) continue;
        if (now - message.createdTimestamp > lookbackMs) continue;
        if (this.store.hasTriggeredResponse(message.id)) continue;
        if (
          this.hasStartupFollowupAfterMessage({
            messages,
            messageIndex: index,
            triggerMessageId: message.id
          })
        ) {
          continue;
        }
        const queued = this.enqueueReplyJob({
          message,
          source: "startup_catchup",
          forceRespond: true,
          addressSignal
        });
        if (queued) repliesSent += 1;
      }
    }
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
        maxMediaPromptChars: resolveMaxMediaPromptLen(settings)
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
      let finalText = sanitizeBotText(initiativeDirective.text || (mediaDirective ? "quick drop" : generation.text));
      finalText = normalizeSkipSentinel(finalText);
      if (!finalText || finalText === "[SKIP]") return;
      const linkPolicy = this.applyDiscoveryLinkPolicy({
        text: finalText,
        candidates: discoveryResult.candidates,
        selected: discoveryResult.selected,
        requireDiscoveryLink
      });
      finalText = normalizeSkipSentinel(linkPolicy.text);
      if (!finalText || finalText === "[SKIP]") return;
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
          prompt: composeInitiativeImagePrompt(imagePrompt, finalText, initiativeMediaPromptLimit),
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
          prompt: composeInitiativeImagePrompt(complexImagePrompt, finalText, initiativeMediaPromptLimit),
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
          prompt: composeInitiativeVideoPrompt(videoPrompt, finalText, initiativeMediaPromptLimit),
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

      await channel.sendTyping();
      await sleep(500 + Math.floor(Math.random() * 1200));

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
    const minByGap = settings.initiative.minMinutesBetweenPosts * 60_000;
    const perDay = Math.max(settings.initiative.maxPostsPerDay, 1);
    const evenPacing = Math.floor((24 * 60 * 60 * 1000) / perDay);
    return Math.max(minByGap, evenPacing);
  }

  getInitiativeAverageIntervalMs(settings) {
    const perDay = Math.max(settings.initiative.maxPostsPerDay, 1);
    return Math.floor((24 * 60 * 60 * 1000) / perDay);
  }

  getInitiativePacingMode(settings) {
    return String(settings.initiative?.pacingMode || "even").toLowerCase() === "spontaneous"
      ? "spontaneous"
      : "even";
  }

  getInitiativeMinGapMs(settings) {
    return Math.max(1, Number(settings.initiative?.minMinutesBetweenPosts || 0) * 60_000);
  }

  evaluateInitiativeSchedule({ settings, startup, lastPostTs, elapsedMs, posts24h }) {
    const mode = this.getInitiativePacingMode(settings);
    const minGapMs = this.getInitiativeMinGapMs(settings);

    if (startup && !settings.initiative.postOnStartup) {
      return {
        shouldPost: false,
        mode,
        trigger: "startup_disabled"
      };
    }

    if (!startup && lastPostTs && Number.isFinite(elapsedMs) && elapsedMs < minGapMs) {
      return {
        shouldPost: false,
        mode,
        trigger: "min_gap_block",
        elapsedMs,
        requiredIntervalMs: minGapMs
      };
    }

    if (startup && !lastPostTs) {
      return {
        shouldPost: true,
        mode,
        trigger: "startup_bootstrap"
      };
    }

    if (mode === "even") {
      const requiredIntervalMs = this.getInitiativePostingIntervalMs(settings);
      const due = !lastPostTs || !Number.isFinite(elapsedMs) || elapsedMs >= requiredIntervalMs;
      return {
        shouldPost: due,
        mode,
        trigger: due ? "even_due" : "even_wait",
        elapsedMs,
        requiredIntervalMs
      };
    }

    if (startup && lastPostTs && Number.isFinite(elapsedMs) && elapsedMs < minGapMs) {
      return {
        shouldPost: false,
        mode,
        trigger: "startup_min_gap_block",
        elapsedMs,
        requiredIntervalMs: minGapMs
      };
    }

    return this.evaluateSpontaneousInitiativeSchedule({
      settings,
      lastPostTs,
      elapsedMs,
      posts24h,
      minGapMs
    });
  }

  evaluateSpontaneousInitiativeSchedule({ settings, lastPostTs, elapsedMs, posts24h, minGapMs }) {
    const mode = "spontaneous";
    const spontaneity01 = clamp(Number(settings.initiative?.spontaneity) || 0, 0, 100) / 100;
    const maxPostsPerDay = Math.max(Number(settings.initiative?.maxPostsPerDay) || 1, 1);
    const averageIntervalMs = this.getInitiativeAverageIntervalMs(settings);

    if (!lastPostTs || !Number.isFinite(elapsedMs)) {
      const chanceNow = 0.05 + spontaneity01 * 0.12;
      const roll = Math.random();
      return {
        shouldPost: roll < chanceNow,
        mode,
        trigger: roll < chanceNow ? "spontaneous_seed_post" : "spontaneous_seed_wait",
        chance: Number(chanceNow.toFixed(4)),
        roll: Number(roll.toFixed(4)),
        elapsedMs: null,
        requiredIntervalMs: averageIntervalMs
      };
    }

    const rampWindowMs = Math.max(averageIntervalMs - minGapMs, INITIATIVE_TICK_MS);
    const progress = clamp((elapsedMs - minGapMs) / rampWindowMs, 0, 1);
    const baseChance = 0.015 + spontaneity01 * 0.03;
    const peakChance = 0.1 + spontaneity01 * 0.28;
    const capPressure = clamp(posts24h / maxPostsPerDay, 0, 1);
    const capModifier = 1 - capPressure * 0.6;
    const chanceNow = clamp((baseChance + (peakChance - baseChance) * progress) * capModifier, 0.005, 0.6);
    const forceAfterMs = Math.max(minGapMs, Math.round(averageIntervalMs * (1.6 - spontaneity01 * 0.55)));

    if (elapsedMs >= forceAfterMs) {
      return {
        shouldPost: true,
        mode,
        trigger: "spontaneous_force_due",
        chance: Number(chanceNow.toFixed(4)),
        roll: null,
        elapsedMs,
        requiredIntervalMs: forceAfterMs
      };
    }

    const roll = Math.random();
    const shouldPost = roll < chanceNow;
    return {
      shouldPost,
      mode,
      trigger: shouldPost ? "spontaneous_roll_due" : "spontaneous_roll_wait",
      chance: Number(chanceNow.toFixed(4)),
      roll: Number(roll.toFixed(4)),
      elapsedMs,
      requiredIntervalMs: forceAfterMs
    };
  }

  pickInitiativeChannel(settings) {
    const ids = settings.permissions.initiativeChannelIds
      .map((id) => String(id).trim())
      .filter(Boolean);
    if (!ids.length) return null;

    const shuffled = ids
      .map((id) => ({ id, sortKey: Math.random() }))
      .sort((a, b) => a.sortKey - b.sortKey)
      .map((item) => item.id);

    for (const id of shuffled) {
      const channel = this.client.channels.cache.get(id);
      if (!channel || !channel.isTextBased?.() || typeof channel.send !== "function") continue;
      if (!this.isChannelAllowed(settings, channel.id)) continue;
      return channel;
    }

    return null;
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
