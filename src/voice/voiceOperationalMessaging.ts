export async function sendOperationalMessage(manager, {
  channel,
  settings = null,
  guildId = null,
  channelId = null,
  userId = null,
  messageId = null,
  event = "voice_runtime",
  reason = null,
  details = {},
  mustNotify = true
}) {
  const resolvedSettings =
    settings || (typeof manager.store?.getSettings === "function" ? manager.store.getSettings() : null);
  const detailsPayload =
    details && typeof details === "object" && !Array.isArray(details)
      ? details
      : { detail: String(details || "") };

  const resolvedChannel = await resolveOperationalChannel(manager, channel, channelId, {
    guildId,
    userId,
    messageId,
    event,
    reason
  });
  if (!resolvedChannel) {
    manager.store.logAction({
      kind: "voice_error",
      guildId: guildId || null,
      channelId: channelId || channel?.id || null,
      messageId: messageId || null,
      userId: userId || manager.client.user?.id || null,
      content: "voice_message_channel_unavailable",
      metadata: {
        event,
        reason
      }
    });
    return false;
  }

  let composedText = "";
  if (!manager.composeOperationalMessage || !resolvedSettings) {
    manager.store.logAction({
      kind: "voice_error",
      guildId: guildId || null,
      channelId: channelId || channel?.id || null,
      messageId: messageId || null,
      userId: userId || manager.client.user?.id || null,
      content: "voice_message_compose_unavailable",
      metadata: {
        event,
        reason,
        hasComposeOperationalMessage: Boolean(manager.composeOperationalMessage),
        hasResolvedSettings: Boolean(resolvedSettings)
      }
    });
    return false;
  }

  try {
    composedText = String(
      (await manager.composeOperationalMessage({
        settings: resolvedSettings,
        guildId: guildId || null,
        channelId: channelId || channel?.id || null,
        userId: userId || null,
        messageId: messageId || null,
        event: String(event || "voice_runtime"),
        reason: reason ? String(reason) : null,
        details: detailsPayload,
        allowSkip: !mustNotify
      })) || ""
    ).trim();
  } catch (error) {
    manager.store.logAction({
      kind: "voice_error",
      guildId: guildId || null,
      channelId: channelId || channel?.id || null,
      messageId: messageId || null,
      userId: userId || manager.client.user?.id || null,
      content: `voice_message_compose_failed: ${String(error?.message || error)}`,
      metadata: {
        event,
        reason
      }
    });
    return false;
  }

  const normalizedComposedText = String(composedText || "").trim();
  const skipRequested = /^\[SKIP\]$/i.test(normalizedComposedText);
  if (!mustNotify) {
    if (skipRequested) return true;
    if (!normalizedComposedText) {
      manager.store.logAction({
        kind: "voice_error",
        guildId: guildId || null,
        channelId: channelId || resolvedChannel?.id || channel?.id || null,
        messageId: messageId || null,
        userId: userId || manager.client.user?.id || null,
        content: "voice_message_model_empty",
        metadata: {
          event,
          reason
        }
      });
      return false;
    }
    return await sendToChannel(manager, resolvedChannel, normalizedComposedText, {
      guildId,
      channelId: channelId || resolvedChannel?.id || null,
      userId,
      messageId,
      event,
      reason
    });
  }

  if (skipRequested) {
    return true;
  }

  if (!normalizedComposedText) {
    manager.store.logAction({
      kind: "voice_error",
      guildId: guildId || null,
      channelId: channelId || resolvedChannel?.id || channel?.id || null,
      messageId: messageId || null,
      userId: userId || manager.client.user?.id || null,
      content: "voice_message_model_empty",
      metadata: {
        event,
        reason
      }
    });
    return false;
  }

  return await sendToChannel(manager, resolvedChannel, normalizedComposedText, {
    guildId,
    channelId: channelId || resolvedChannel?.id || null,
    userId,
    messageId,
    event,
    reason
  });
}

export async function resolveOperationalChannel(
  manager,
  channel,
  channelId,
  { guildId = null, userId = null, messageId = null, event = null, reason = null } = {}
) {
  if (channel && typeof channel.send === "function") return channel;

  const resolvedChannelId = String(channelId || channel?.id || "").trim();
  if (!resolvedChannelId) return null;

  try {
    const fetched = await manager.client.channels.fetch(resolvedChannelId);
    if (fetched && typeof fetched.send === "function") return fetched;
    return null;
  } catch (error) {
    manager.store.logAction({
      kind: "voice_error",
      guildId: guildId || null,
      channelId: resolvedChannelId || null,
      messageId: messageId || null,
      userId: userId || manager.client.user?.id || null,
      content: `voice_message_channel_fetch_failed: ${String(error?.message || error)}`,
      metadata: {
        event,
        reason
      }
    });
    return null;
  }
}

export async function sendToChannel(
  manager,
  channel,
  text,
  { guildId = null, channelId = null, userId = null, messageId = null, event = null, reason = null } = {}
) {
  if (!channel || typeof channel.send !== "function") return false;
  const content = String(text || "").trim();
  if (!content) return false;

  try {
    await channel.send(content);
    return true;
  } catch (error) {
    manager.store.logAction({
      kind: "voice_error",
      guildId: guildId || null,
      channelId: channelId || channel?.id || null,
      messageId: messageId || null,
      userId: userId || manager.client.user?.id || null,
      content: `voice_message_send_failed: ${String(error?.message || error)}`,
      metadata: {
        event,
        reason
      }
    });
    return false;
  }
}
