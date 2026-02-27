import { clamp, sleep } from "../utils.ts";

const REPLY_QUEUE_RATE_LIMIT_WAIT_MS = 15_000;
const REPLY_QUEUE_SEND_RETRY_BASE_MS = 2_500;
const REPLY_QUEUE_SEND_MAX_RETRIES = 2;
const GATEWAY_STALE_MS = 2 * 60_000;
const GATEWAY_RECONNECT_BASE_DELAY_MS = 5_000;
const GATEWAY_RECONNECT_MAX_DELAY_MS = 60_000;

export function getReplyQueueWaitMs(bot, settings) {
  const cooldownMs = settings.activity.minSecondsBetweenMessages * 1000;
  const elapsed = Date.now() - bot.lastBotMessageAt;
  const cooldownWaitMs = Math.max(0, cooldownMs - elapsed);
  if (cooldownWaitMs > 0) return cooldownWaitMs;
  if (!bot.canSendMessage(settings.permissions.maxMessagesPerHour)) {
    return REPLY_QUEUE_RATE_LIMIT_WAIT_MS;
  }
  return 0;
}

export function getReplyCoalesceWindowMs(settings) {
  const seconds = clamp(Number(settings.activity?.replyCoalesceWindowSeconds) || 0, 0, 20);
  return Math.floor(seconds * 1000);
}

export function getReplyCoalesceMaxMessages(settings) {
  return clamp(Number(settings.activity?.replyCoalesceMaxMessages) || 1, 1, 20);
}

export function getReplyCoalesceWaitMs(settings, message) {
  const windowMs = getReplyCoalesceWindowMs(settings);
  if (windowMs <= 0) return 0;
  const createdAtRaw = Number(message?.createdTimestamp);
  const createdAt = Number.isFinite(createdAtRaw) && createdAtRaw > 0 ? createdAtRaw : Date.now();
  const ageMs = Date.now() - createdAt;
  return Math.max(0, windowMs - ageMs);
}

export function dequeueReplyJob(bot, channelId) {
  const queue = bot.replyQueues.get(channelId);
  if (!queue?.length) return null;

  const job = queue.shift();
  if (job?.message?.id) {
    bot.replyQueuedMessageIds.delete(String(job.message.id));
  }

  if (!queue.length) {
    bot.replyQueues.delete(channelId);
  }

  return job;
}

export function dequeueReplyBurst(bot, channelId, settings) {
  const firstJob = dequeueReplyJob(bot, channelId);
  if (!firstJob) return [];

  const burst = [firstJob];
  const windowMs = getReplyCoalesceWindowMs(settings);
  const maxMessages = getReplyCoalesceMaxMessages(settings);
  if (windowMs <= 0 || maxMessages <= 1) return burst;

  const firstMessage = firstJob.message;
  const firstAuthorId = String(firstMessage?.author?.id || "").trim();
  if (!firstAuthorId) return burst;

  const firstCreatedAtRaw = Number(firstMessage?.createdTimestamp);
  const firstCreatedAt = Number.isFinite(firstCreatedAtRaw) && firstCreatedAtRaw > 0
    ? firstCreatedAtRaw
    : Date.now();

  while (burst.length < maxMessages) {
    const queue = bot.replyQueues.get(channelId);
    const candidate = queue?.[0];
    if (!candidate) break;

    const candidateMessage = candidate.message;
    if (!candidateMessage?.id) {
      dequeueReplyJob(bot, channelId);
      continue;
    }

    const candidateAuthorId = String(candidateMessage.author?.id || "").trim();
    if (candidateAuthorId !== firstAuthorId) break;

    const candidateCreatedAtRaw = Number(candidateMessage.createdTimestamp);
    const candidateCreatedAt = Number.isFinite(candidateCreatedAtRaw) && candidateCreatedAtRaw > 0
      ? candidateCreatedAtRaw
      : firstCreatedAt;
    if (Math.abs(candidateCreatedAt - firstCreatedAt) > windowMs) break;

    const nextJob = dequeueReplyJob(bot, channelId);
    if (!nextJob) break;
    burst.push(nextJob);
  }

  return burst;
}

export function requeueReplyJobs(bot, channelId, jobs) {
  const validJobs = (jobs || []).filter((job) => job?.message?.id);
  if (!validJobs.length) return;

  const queue = bot.replyQueues.get(channelId) || [];
  queue.unshift(...validJobs);
  bot.replyQueues.set(channelId, queue);
  for (const job of validJobs) {
    bot.replyQueuedMessageIds.add(String(job.message.id));
  }
}

export async function processReplyQueue(bot, channelId) {
  if (bot.replyQueueWorkers.has(channelId)) return;
  bot.replyQueueWorkers.add(channelId);

  try {
    while (!bot.isStopping) {
      const queue = bot.replyQueues.get(channelId);
      if (!queue?.length) break;

      const head = queue[0];
      const headMessage = head?.message;
      if (!headMessage?.id) {
        dequeueReplyJob(bot, channelId);
        continue;
      }

      const settings = bot.store.getSettings();

      if (!settings.permissions.allowReplies) {
        dequeueReplyJob(bot, channelId);
        continue;
      }
      if (!headMessage.author || String(headMessage.author.id || "") === String(bot.client.user?.id || "")) {
        dequeueReplyJob(bot, channelId);
        continue;
      }
      if (!headMessage.guild || !headMessage.channel) {
        dequeueReplyJob(bot, channelId);
        continue;
      }
      if (!bot.isChannelAllowed(settings, headMessage.channelId)) {
        dequeueReplyJob(bot, channelId);
        continue;
      }
      if (bot.isUserBlocked(settings, headMessage.author.id)) {
        dequeueReplyJob(bot, channelId);
        continue;
      }
      if (bot.store.hasTriggeredResponse(headMessage.id)) {
        dequeueReplyJob(bot, channelId);
        continue;
      }

      const coalesceWaitMs = getReplyCoalesceWaitMs(settings, headMessage);
      if (coalesceWaitMs > 0) {
        await sleep(Math.min(coalesceWaitMs, REPLY_QUEUE_RATE_LIMIT_WAIT_MS));
        continue;
      }

      const waitMs = getReplyQueueWaitMs(bot, settings);
      if (waitMs > 0) {
        await sleep(Math.min(waitMs, REPLY_QUEUE_RATE_LIMIT_WAIT_MS));
        continue;
      }

      const burstJobs = dequeueReplyBurst(bot, channelId, settings);
      if (!burstJobs.length) continue;

      const latestJob = burstJobs[burstJobs.length - 1];
      const message = latestJob?.message;
      if (!message?.id) continue;

      const triggerMessageIds = [
        ...new Set(burstJobs.map((job) => String(job?.message?.id || "").trim()).filter(Boolean))
      ];

      const recentMessages = bot.store.getRecentMessages(
        message.channelId,
        settings.memory.maxRecentMessages
      );
      const addressSignal = {
        ...(latestJob.addressSignal || bot.getReplyAddressSignal(settings, message, recentMessages))
      };
      addressSignal.direct = Boolean(addressSignal.direct);
      addressSignal.inferred = Boolean(addressSignal.inferred);
      addressSignal.triggered = Boolean(addressSignal.triggered);
      addressSignal.reason = String(addressSignal.reason || "llm_decides");

      for (const burstJob of burstJobs) {
        const burstMessage = burstJob?.message;
        if (!burstMessage?.id) continue;
        const signal = burstJob.addressSignal || bot.getReplyAddressSignal(settings, burstMessage, recentMessages);
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
        const sent = await bot.maybeReplyToMessage(message, settings, {
          forceRespond,
          source,
          addressSignal,
          recentMessages,
          triggerMessageIds
        });

        if (!sent && forceRespond && !bot.isStopping && !bot.store.hasTriggeredResponse(message.id)) {
          const latestSettings = bot.store.getSettings();
          if (
            latestSettings.permissions.allowReplies &&
            bot.isChannelAllowed(latestSettings, message.channelId) &&
            !bot.isUserBlocked(latestSettings, message.author.id)
          ) {
            const retryWaitMs = getReplyQueueWaitMs(bot, latestSettings);
            if (retryWaitMs > 0) {
              requeueReplyJobs(bot, channelId, burstJobs);
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
        if (maxAttempts < REPLY_QUEUE_SEND_MAX_RETRIES && !bot.isStopping) {
          const nextAttempt = maxAttempts + 1;
          for (const job of burstJobs) {
            job.attempts = Math.max(0, Number(job?.attempts) || 0) + 1;
          }
          requeueReplyJobs(bot, channelId, burstJobs);
          await sleep(REPLY_QUEUE_SEND_RETRY_BASE_MS * nextAttempt);
          continue;
        }

        bot.store.logAction({
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
    bot.replyQueueWorkers.delete(channelId);
    if (!bot.isStopping && bot.replyQueues.get(channelId)?.length) {
      processReplyQueue(bot, channelId).catch((error) => {
        bot.store.logAction({
          kind: "bot_error",
          content: `reply_queue_restart: ${String(error?.message || error)}`
        });
      });
    }
  }
}

export async function ensureGatewayHealthy(bot) {
  if (bot.isStopping) return;
  if (bot.reconnectInFlight) return;
  if (!bot.hasConnectedAtLeastOnce) return;

  if (bot.client.isReady()) {
    bot.markGatewayEvent();
    return;
  }

  const elapsed = Date.now() - bot.lastGatewayEventAt;
  if (elapsed < GATEWAY_STALE_MS) return;

  await reconnectGateway(bot, `stale_gateway_${elapsed}ms`);
}

export function scheduleReconnect(bot, reason, delayMs) {
  if (bot.isStopping) return;
  if (bot.reconnectTimeout) return;

  bot.reconnectTimeout = setTimeout(() => {
    bot.reconnectTimeout = null;
    reconnectGateway(bot, reason).catch((error) => {
      bot.store.logAction({
        kind: "bot_error",
        userId: bot.client.user?.id,
        content: `gateway_reconnect_crash: ${String(error?.message || error)}`
      });
    });
  }, delayMs);
}

export async function reconnectGateway(bot, reason) {
  if (bot.isStopping) return;
  if (bot.reconnectInFlight) return;
  bot.reconnectInFlight = true;
  bot.markGatewayEvent();

  bot.store.logAction({
    kind: "bot_error",
    userId: bot.client.user?.id,
    content: `gateway_reconnect_start: ${reason}`
  });

  try {
    try {
      await bot.client.destroy();
    } catch {
      // ignore
    }
    await bot.client.login(bot.appConfig.discordToken);
    bot.markGatewayEvent();
    bot.reconnectAttempts = 0;
  } catch (error) {
    bot.reconnectAttempts += 1;
    const backoffDelay = Math.min(
      GATEWAY_RECONNECT_BASE_DELAY_MS * 2 ** Math.max(bot.reconnectAttempts - 1, 0),
      GATEWAY_RECONNECT_MAX_DELAY_MS
    );

    bot.store.logAction({
      kind: "bot_error",
      userId: bot.client.user?.id,
      content: `gateway_reconnect_failed: ${String(error?.message || error)}`,
      metadata: {
        attempt: bot.reconnectAttempts,
        nextRetryMs: backoffDelay
      }
    });

    scheduleReconnect(bot, "retry_after_reconnect_failure", backoffDelay);
  } finally {
    bot.reconnectInFlight = false;
  }
}
