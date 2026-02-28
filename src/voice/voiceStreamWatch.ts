import { clamp } from "../utils.ts";
import { getPromptBotName } from "../promptCore.ts";
import { buildRealtimeTextUtterancePrompt, isRealtimeMode, normalizeVoiceText } from "./voiceSessionHelpers.ts";

const STREAM_WATCH_AUDIO_QUIET_WINDOW_MS = 2200;
const STREAM_WATCH_COMMENTARY_PROMPT_MAX_CHARS = 220;
const STREAM_WATCH_COMMENTARY_LINE_MAX_CHARS = 160;
const STREAM_WATCH_VISION_MAX_OUTPUT_TOKENS = 72;

async function sendStreamWatchOfflineMessage(manager, { message, settings, guildId, requesterId }) {
  await manager.sendOperationalMessage({
    channel: message.channel,
    settings,
    guildId,
    channelId: message.channelId,
    userId: requesterId,
    messageId: message.id,
    event: "voice_stream_watch_request",
    reason: "offline",
    details: {}
  });
}

async function resolveStreamWatchRequestContext(manager, { message, settings }) {
  if (!message?.guild || !message?.channel) return null;
  const guildId = String(message.guild.id);
  const requesterId = String(message.author?.id || "").trim() || null;
  const session = manager.sessions.get(guildId);
  if (!session) {
    await sendStreamWatchOfflineMessage(manager, {
      message,
      settings,
      guildId,
      requesterId
    });
    return {
      handled: true
    };
  }
  return {
    handled: false,
    guildId,
    requesterId,
    session
  };
}

export async function requestWatchStream(manager, { message, settings, targetUserId = null }) {
  const context = await resolveStreamWatchRequestContext(manager, { message, settings });
  if (!context) return false;
  if (context.handled) return true;
  const { guildId, session, requesterId } = context;

  if (String(message.member?.voice?.channelId || "") !== String(session.voiceChannelId || "")) {
    await manager.sendOperationalMessage({
      channel: message.channel,
      settings,
      guildId,
      channelId: message.channelId,
      userId: requesterId,
      messageId: message.id,
      event: "voice_stream_watch_request",
      reason: "requester_not_in_same_vc",
      details: {
        voiceChannelId: session.voiceChannelId
      }
    });
    return true;
  }

  const streamWatchSettings = settings?.voice?.streamWatch || {};
  if (!streamWatchSettings.enabled) {
    await manager.sendOperationalMessage({
      channel: message.channel,
      settings,
      guildId,
      channelId: message.channelId,
      userId: requesterId,
      messageId: message.id,
      event: "voice_stream_watch_request",
      reason: "stream_watch_disabled",
      details: {}
    });
    return true;
  }

  if (!supportsStreamWatchCommentary(manager, session, settings)) {
    await manager.sendOperationalMessage({
      channel: message.channel,
      settings,
      guildId,
      channelId: message.channelId,
      userId: requesterId,
      messageId: message.id,
      event: "voice_stream_watch_request",
      reason: "stream_watch_provider_unavailable",
      details: {
        mode: session.mode,
        realtimeProvider: session.realtimeProvider
      }
    });
    return true;
  }

  initializeStreamWatchState(manager, {
    session,
    requesterUserId: requesterId,
    targetUserId: String(targetUserId || requesterId || "").trim() || null
  });

  await manager.sendOperationalMessage({
    channel: message.channel,
    settings,
    guildId,
    channelId: message.channelId,
    userId: requesterId,
    messageId: message.id,
    event: "voice_stream_watch_request",
    reason: "watching_started",
    details: {
      targetUserId: session.streamWatch.targetUserId
    },
    mustNotify: false
  });
  return true;
}

export function initializeStreamWatchState(manager, { session, requesterUserId, targetUserId = null }) {
  if (!session) return;
  session.streamWatch = session.streamWatch || {};
  session.streamWatch.active = true;
  session.streamWatch.targetUserId = String(targetUserId || requesterUserId || "").trim() || null;
  session.streamWatch.requestedByUserId = String(requesterUserId || "").trim() || null;
  session.streamWatch.lastFrameAt = 0;
  session.streamWatch.lastCommentaryAt = 0;
  session.streamWatch.ingestedFrameCount = 0;
  session.streamWatch.acceptedFrameCountInWindow = 0;
  session.streamWatch.frameWindowStartedAt = 0;
  session.streamWatch.latestFrameMimeType = null;
  session.streamWatch.latestFrameDataBase64 = "";
  session.streamWatch.latestFrameAt = 0;
}

export function supportsStreamWatchCommentary(manager, session, settings = null) {
  if (!session || session.ending) return false;
  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();
  if (!isRealtimeMode(session.mode)) return false;
  const realtimeClient = session.realtimeClient;
  const hasNativeVideoCommentary = Boolean(
    realtimeClient &&
      typeof realtimeClient.appendInputVideoFrame === "function" &&
      typeof realtimeClient.requestVideoCommentary === "function"
  );
  if (hasNativeVideoCommentary) return true;
  return supportsVisionFallbackStreamWatchCommentary(manager, { session, settings: resolvedSettings });
}

export function supportsVisionFallbackStreamWatchCommentary(manager, { session = null, settings = null } = {}) {
  if (!session || session.ending) return false;
  if (session.mode !== "voice_agent") return false;
  const realtimeClient = session.realtimeClient;
  if (!realtimeClient || typeof realtimeClient.requestTextUtterance !== "function") return false;
  if (!manager.llm || typeof manager.llm.generate !== "function") return false;
  return Boolean(resolveStreamWatchVisionProviderSettings(manager, settings));
}

export function resolveStreamWatchVisionProviderSettings(manager, settings = null) {
  const llmSettings = settings?.llm && typeof settings.llm === "object" ? settings.llm : {};
  const candidates = [
    {
      provider: "anthropic",
      model: "claude-haiku-4-5"
    },
    {
      provider: "xai",
      model: "grok-2-vision-latest"
    },
    {
      provider: "claude-code",
      model: "sonnet"
    }
  ];

  for (const candidate of candidates) {
    const configured = manager.llm?.isProviderConfigured?.(candidate.provider);
    if (!configured) continue;
    return {
      ...llmSettings,
      provider: candidate.provider,
      model: candidate.model,
      temperature: 0.3,
      maxOutputTokens: STREAM_WATCH_VISION_MAX_OUTPUT_TOKENS
    };
  }

  return null;
}

export async function generateVisionFallbackStreamWatchCommentary(manager, {
  session,
  settings,
  streamerUserId = null,
  frameMimeType = "image/jpeg",
  frameDataBase64 = ""
}) {
  if (!session || session.ending) return null;
  if (!manager.llm || typeof manager.llm.generate !== "function") return null;
  const normalizedFrame = String(frameDataBase64 || "").trim();
  if (!normalizedFrame) return null;

  const providerSettings = resolveStreamWatchVisionProviderSettings(manager, settings);
  if (!providerSettings) return null;
  const speakerName = manager.resolveVoiceSpeakerName(session, streamerUserId) || "the streamer";
  const systemPrompt = [
    `You are ${getPromptBotName(settings)} in Discord VC.`,
    "You are looking at one still frame from a live stream.",
    "Return exactly one short spoken commentary line (max 12 words).",
    "No lists, no quotes, no stage directions."
  ].join(" ");
  const userPrompt = [
    `Latest frame from ${speakerName}'s stream.`,
    "Comment on only what is visible in this frame.",
    "If uncertain, say so briefly."
  ].join(" ");

  const generated = await manager.llm.generate({
    settings: {
      ...(settings || {}),
      llm: providerSettings
    },
    systemPrompt,
    userPrompt,
    imageInputs: [
      {
        mediaType: String(frameMimeType || "image/jpeg"),
        dataBase64: normalizedFrame
      }
    ],
    trace: {
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: manager.client.user?.id || null,
      source: "voice_stream_watch_vision_fallback"
    }
  });

  const rawText = String(generated?.text || "").trim();
  const oneLine = rawText.split(/\r?\n/)[0] || "";
  const text = normalizeVoiceText(oneLine, STREAM_WATCH_COMMENTARY_LINE_MAX_CHARS);
  if (!text) return null;
  return {
    text,
    provider: generated?.provider || providerSettings.provider || null,
    model: generated?.model || providerSettings.model || null
  };
}

export function isUserInSessionVoiceChannel(manager, { session, userId }) {
  const normalizedUserId = String(userId || "").trim();
  if (!session || !normalizedUserId) return false;
  const guild = manager.client.guilds.cache.get(String(session.guildId || "")) || null;
  const voiceChannel = guild?.channels?.cache?.get(String(session.voiceChannelId || "")) || null;
  return Boolean(voiceChannel?.members?.has?.(normalizedUserId));
}

export async function enableWatchStreamForUser(manager, {
  guildId,
  requesterUserId,
  targetUserId = null,
  settings = null,
  source = "screen_share_link"
}) {
  const normalizedGuildId = String(guildId || "").trim();
  const normalizedRequesterId = String(requesterUserId || "").trim();
  if (!normalizedGuildId || !normalizedRequesterId) {
    return {
      ok: false,
      reason: "invalid_request"
    };
  }

  const session = manager.sessions.get(normalizedGuildId);
  if (!session) {
    return {
      ok: false,
      reason: "session_not_found"
    };
  }

  if (!isUserInSessionVoiceChannel(manager, { session, userId: normalizedRequesterId })) {
    return {
      ok: false,
      reason: "requester_not_in_same_vc"
    };
  }

  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();
  const streamWatchSettings = resolvedSettings?.voice?.streamWatch || {};
  if (!streamWatchSettings.enabled) {
    return {
      ok: false,
      reason: "stream_watch_disabled"
    };
  }

  if (!supportsStreamWatchCommentary(manager, session, resolvedSettings)) {
    return {
      ok: false,
      reason: "stream_watch_provider_unavailable"
    };
  }

  const resolvedTarget = String(targetUserId || normalizedRequesterId).trim() || normalizedRequesterId;
  initializeStreamWatchState(manager, {
    session,
    requesterUserId: normalizedRequesterId,
    targetUserId: resolvedTarget
  });
  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: normalizedRequesterId,
    content: "stream_watch_enabled_programmatic",
    metadata: {
      sessionId: session.id,
      source: String(source || "screen_share_link"),
      targetUserId: resolvedTarget
    }
  });

  return {
    ok: true,
    reason: "watching_started",
    targetUserId: session.streamWatch?.targetUserId || resolvedTarget
  };
}

export async function requestStopWatchingStream(manager, { message, settings }) {
  const context = await resolveStreamWatchRequestContext(manager, { message, settings });
  if (!context) return false;
  if (context.handled) return true;
  const { guildId, session, requesterId } = context;

  if (!session.streamWatch?.active) {
    await manager.sendOperationalMessage({
      channel: message.channel,
      settings,
      guildId,
      channelId: message.channelId,
      userId: requesterId,
      messageId: message.id,
      event: "voice_stream_watch_request",
      reason: "already_stopped",
      details: {},
      mustNotify: false
    });
    return true;
  }

  session.streamWatch.active = false;
  session.streamWatch.targetUserId = null;
  session.streamWatch.latestFrameMimeType = null;
  session.streamWatch.latestFrameDataBase64 = "";
  session.streamWatch.latestFrameAt = 0;

  await manager.sendOperationalMessage({
    channel: message.channel,
    settings,
    guildId,
    channelId: message.channelId,
    userId: requesterId,
    messageId: message.id,
    event: "voice_stream_watch_request",
    reason: "watching_stopped",
    details: {},
    mustNotify: false
  });
  return true;
}

export async function requestStreamWatchStatus(manager, { message, settings }) {
  const context = await resolveStreamWatchRequestContext(manager, { message, settings });
  if (!context) return false;
  if (context.handled) return true;
  const { guildId, session, requesterId } = context;

  const streamWatch = session.streamWatch || {};
  const lastFrameAgoSec = Number(streamWatch.lastFrameAt || 0)
    ? Math.max(0, Math.floor((Date.now() - Number(streamWatch.lastFrameAt || 0)) / 1000))
    : null;
  const lastCommentaryAgoSec = Number(streamWatch.lastCommentaryAt || 0)
    ? Math.max(0, Math.floor((Date.now() - Number(streamWatch.lastCommentaryAt || 0)) / 1000))
    : null;

  await manager.sendOperationalMessage({
    channel: message.channel,
    settings,
    guildId,
    channelId: message.channelId,
    userId: requesterId,
    messageId: message.id,
    event: "voice_stream_watch_request",
    reason: "status",
    details: {
      active: Boolean(streamWatch.active),
      mode: session.mode,
      targetUserId: streamWatch.targetUserId || null,
      lastFrameAgoSec,
      lastCommentaryAgoSec,
      ingestedFrameCount: Number(streamWatch.ingestedFrameCount || 0)
    }
  });
  return true;
}

export async function ingestStreamFrame(manager, {
  guildId,
  streamerUserId = null,
  mimeType = "image/jpeg",
  dataBase64 = "",
  source = "api_stream_ingest",
  settings = null
}) {
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) {
    return {
      accepted: false,
      reason: "guild_id_required"
    };
  }

  const session = manager.sessions.get(normalizedGuildId);
  if (!session || session.ending) {
    return {
      accepted: false,
      reason: "session_not_found"
    };
  }

  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();
  const streamWatchSettings = resolvedSettings?.voice?.streamWatch || {};
  if (!streamWatchSettings.enabled) {
    return {
      accepted: false,
      reason: "stream_watch_disabled"
    };
  }
  if (!supportsStreamWatchCommentary(manager, session, resolvedSettings)) {
    return {
      accepted: false,
      reason: "provider_video_ingest_unavailable"
    };
  }

  const streamWatch = session.streamWatch || {};
  if (!streamWatch.active) {
    return {
      accepted: false,
      reason: "watch_not_active"
    };
  }

  const normalizedStreamerId = String(streamerUserId || "").trim() || null;
  if (streamWatch.targetUserId && !normalizedStreamerId) {
    return {
      accepted: false,
      reason: "streamer_user_id_required",
      targetUserId: streamWatch.targetUserId
    };
  }

  if (streamWatch.targetUserId && streamWatch.targetUserId !== normalizedStreamerId) {
    return {
      accepted: false,
      reason: "target_user_mismatch",
      targetUserId: streamWatch.targetUserId
    };
  }

  const normalizedMimeType = String(mimeType || "").trim().toLowerCase();
  const allowedMimeType =
    normalizedMimeType === "image/jpeg" ||
    normalizedMimeType === "image/jpg" ||
    normalizedMimeType === "image/png" ||
    normalizedMimeType === "image/webp";
  if (!allowedMimeType) {
    return {
      accepted: false,
      reason: "invalid_mime_type"
    };
  }

  const normalizedFrame = String(dataBase64 || "").trim();
  if (!normalizedFrame) {
    return {
      accepted: false,
      reason: "frame_data_required"
    };
  }

  const maxFrameBytes = clamp(
    Number(streamWatchSettings.maxFrameBytes) || 350000,
    50_000,
    4_000_000
  );
  const approxBytes = Math.floor((normalizedFrame.length * 3) / 4);
  if (approxBytes > maxFrameBytes) {
    return {
      accepted: false,
      reason: "frame_too_large",
      maxFrameBytes
    };
  }

  const maxFramesPerMinute = clamp(
    Number(streamWatchSettings.maxFramesPerMinute) || 180,
    6,
    600
  );
  const now = Date.now();
  if (!streamWatch.frameWindowStartedAt || now - Number(streamWatch.frameWindowStartedAt) >= 60_000) {
    streamWatch.frameWindowStartedAt = now;
    streamWatch.acceptedFrameCountInWindow = 0;
  }
  if (Number(streamWatch.acceptedFrameCountInWindow || 0) >= maxFramesPerMinute) {
    return {
      accepted: false,
      reason: "frame_rate_limited",
      maxFramesPerMinute
    };
  }

  const realtimeClient = session.realtimeClient;
  const resolvedMimeType = normalizedMimeType === "image/jpg" ? "image/jpeg" : normalizedMimeType;
  if (realtimeClient && typeof realtimeClient.appendInputVideoFrame === "function") {
    try {
      realtimeClient.appendInputVideoFrame({
        mimeType: resolvedMimeType,
        dataBase64: normalizedFrame
      });
    } catch (error) {
      manager.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: normalizedStreamerId || manager.client.user?.id || null,
        content: `stream_watch_frame_ingest_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          source: String(source || "api_stream_ingest")
        }
      });
      return {
        accepted: false,
        reason: "frame_ingest_failed"
      };
    }
  } else {
    streamWatch.latestFrameMimeType = resolvedMimeType;
    streamWatch.latestFrameDataBase64 = normalizedFrame;
    streamWatch.latestFrameAt = now;
  }

  streamWatch.lastFrameAt = now;
  streamWatch.ingestedFrameCount = Number(streamWatch.ingestedFrameCount || 0) + 1;
  streamWatch.acceptedFrameCountInWindow = Number(streamWatch.acceptedFrameCountInWindow || 0) + 1;
  manager.touchActivity(session.guildId, resolvedSettings);

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: normalizedStreamerId || manager.client.user?.id || null,
    content: "stream_watch_frame_ingested",
    metadata: {
      sessionId: session.id,
      source: String(source || "api_stream_ingest"),
      mimeType: resolvedMimeType,
      frameBytes: approxBytes,
      totalFrames: streamWatch.ingestedFrameCount
    }
  });

  await maybeTriggerStreamWatchCommentary(manager, {
    session,
    settings: resolvedSettings,
    streamerUserId: normalizedStreamerId,
    source
  });

  return {
    accepted: true,
    reason: "ok",
    targetUserId: streamWatch.targetUserId || null
  };
}

export async function maybeTriggerStreamWatchCommentary(manager, {
  session,
  settings,
  streamerUserId = null,
  source = "api_stream_ingest"
}) {
  if (!session || session.ending) return;
  if (!supportsStreamWatchCommentary(manager, session, settings)) return;
  if (!session.streamWatch?.active) return;
  if (session.userCaptures.size > 0) return;
  if (session.pendingResponse) return;

  const quietWindowMs = STREAM_WATCH_AUDIO_QUIET_WINDOW_MS;
  const sinceLastInboundAudio = Date.now() - Number(session.lastInboundAudioAt || 0);
  if (Number(session.lastInboundAudioAt || 0) > 0 && sinceLastInboundAudio < quietWindowMs) return;

  const streamWatchSettings = settings?.voice?.streamWatch || {};
  const minCommentaryIntervalSeconds = clamp(
    Number(streamWatchSettings.minCommentaryIntervalSeconds) || 8,
    3,
    120
  );
  const now = Date.now();
  if (now - Number(session.streamWatch.lastCommentaryAt || 0) < minCommentaryIntervalSeconds * 1000) return;

  const realtimeClient = session.realtimeClient;
  if (!realtimeClient) return;

  const speakerName = manager.resolveVoiceSpeakerName(session, streamerUserId) || "the streamer";
  const nativePrompt = normalizeVoiceText(
    [
      `You're in Discord VC watching ${speakerName}'s live stream.`,
      "Give one short in-character spoken commentary line about the latest frame.",
      "If unclear, say that briefly without pretending certainty."
    ].join(" "),
    STREAM_WATCH_COMMENTARY_PROMPT_MAX_CHARS
  );

  try {
    let fallbackVisionMeta = null;
    if (typeof realtimeClient.requestVideoCommentary === "function") {
      realtimeClient.requestVideoCommentary(nativePrompt);
    } else if (typeof realtimeClient.requestTextUtterance === "function") {
      const bufferedFrame = String(session.streamWatch?.latestFrameDataBase64 || "").trim();
      if (!bufferedFrame) return;
      const generated = await generateVisionFallbackStreamWatchCommentary(manager, {
        session,
        settings,
        streamerUserId,
        frameMimeType: session.streamWatch?.latestFrameMimeType || "image/jpeg",
        frameDataBase64: bufferedFrame
      });
      const line = normalizeVoiceText(generated?.text || "", STREAM_WATCH_COMMENTARY_LINE_MAX_CHARS);
      if (!line) return;
      const utterancePrompt = buildRealtimeTextUtterancePrompt(line, STREAM_WATCH_COMMENTARY_LINE_MAX_CHARS);
      realtimeClient.requestTextUtterance(utterancePrompt);
      fallbackVisionMeta = {
        provider: generated?.provider || null,
        model: generated?.model || null
      };
    } else {
      return;
    }

    const created = manager.createTrackedAudioResponse({
      session,
      userId: session.streamWatch.targetUserId || streamerUserId || manager.client.user?.id || null,
      source: "stream_watch_commentary",
      resetRetryState: true,
      emitCreateEvent: false
    });
    if (!created) return;
    session.streamWatch.lastCommentaryAt = now;
    manager.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: manager.client.user?.id || null,
      content: "stream_watch_commentary_requested",
      metadata: {
        sessionId: session.id,
        source: String(source || "api_stream_ingest"),
        streamerUserId: streamerUserId || null,
        commentaryPath: fallbackVisionMeta ? "vision_fallback_text_utterance" : "provider_native_video",
        visionProvider: fallbackVisionMeta?.provider || null,
        visionModel: fallbackVisionMeta?.model || null
      }
    });
  } catch (error) {
    manager.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: manager.client.user?.id || null,
      content: `stream_watch_commentary_request_failed: ${String(error?.message || error)}`,
      metadata: {
        sessionId: session.id,
        source: String(source || "api_stream_ingest")
      }
    });
  }
}
