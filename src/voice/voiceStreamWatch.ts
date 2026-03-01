import { clamp } from "../utils.ts";
import { getPromptBotName } from "../promptCore.ts";
import { buildRealtimeTextUtterancePrompt, isRealtimeMode, normalizeVoiceText } from "./voiceSessionHelpers.ts";

const STREAM_WATCH_AUDIO_QUIET_WINDOW_MS = 2200;
const STREAM_WATCH_COMMENTARY_PROMPT_MAX_CHARS = 220;
const STREAM_WATCH_COMMENTARY_LINE_MAX_CHARS = 160;
const STREAM_WATCH_BRAIN_CONTEXT_PROMPT_MAX_CHARS = 420;
const STREAM_WATCH_BRAIN_CONTEXT_LINE_MAX_CHARS = 220;
const STREAM_WATCH_VISION_MAX_OUTPUT_TOKENS = 72;
const STREAM_WATCH_COMMENTARY_PATH_AUTO = "auto";
const STREAM_WATCH_COMMENTARY_PATH_ANTHROPIC_KEYFRAMES = "anthropic_keyframes";
const DEFAULT_STREAM_WATCH_BRAIN_CONTEXT_PROMPT =
  "For each keyframe, classify it as gameplay or non-gameplay, then generate notes that support either play-by-play commentary or observational shout-out commentary.";

function normalizeStreamWatchCommentaryPath(value, fallback = STREAM_WATCH_COMMENTARY_PATH_AUTO) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === STREAM_WATCH_COMMENTARY_PATH_ANTHROPIC_KEYFRAMES) {
    return STREAM_WATCH_COMMENTARY_PATH_ANTHROPIC_KEYFRAMES;
  }
  if (normalized === STREAM_WATCH_COMMENTARY_PATH_AUTO) {
    return STREAM_WATCH_COMMENTARY_PATH_AUTO;
  }
  return fallback;
}

function resolveStreamWatchCommentaryPath(settings = null) {
  const configured = settings?.voice?.streamWatch?.commentaryPath;
  return normalizeStreamWatchCommentaryPath(configured, STREAM_WATCH_COMMENTARY_PATH_AUTO);
}

function resolveStreamWatchBrainContextSettings(settings = null) {
  const streamWatchSettings =
    settings?.voice?.streamWatch && typeof settings.voice.streamWatch === "object"
      ? settings.voice.streamWatch
      : {};
  const prompt = normalizeVoiceText(
    String(streamWatchSettings.brainContextPrompt || ""),
    STREAM_WATCH_BRAIN_CONTEXT_PROMPT_MAX_CHARS
  );

  return {
    enabled:
      streamWatchSettings.brainContextEnabled !== undefined
        ? Boolean(streamWatchSettings.brainContextEnabled)
        : true,
    minIntervalSeconds: clamp(
      Number(streamWatchSettings.brainContextMinIntervalSeconds) || 4,
      1,
      120
    ),
    maxEntries: clamp(
      Number(streamWatchSettings.brainContextMaxEntries) || 8,
      1,
      24
    ),
    prompt: prompt || DEFAULT_STREAM_WATCH_BRAIN_CONTEXT_PROMPT
  };
}

function getStreamWatchBrainContextEntries(session, maxEntries = 8) {
  const streamWatch = session?.streamWatch && typeof session.streamWatch === "object" ? session.streamWatch : {};
  const entries = Array.isArray(streamWatch.brainContextEntries) ? streamWatch.brainContextEntries : [];
  const boundedMax = clamp(Number(maxEntries) || 8, 1, 24);
  return entries
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const text = normalizeVoiceText(entry.text, STREAM_WATCH_BRAIN_CONTEXT_LINE_MAX_CHARS);
      if (!text) return null;
      const atRaw = Number(entry.at);
      return {
        text,
        at: Number.isFinite(atRaw) ? Math.max(0, Math.round(atRaw)) : 0,
        provider: String(entry.provider || "").trim() || null,
        model: String(entry.model || "").trim() || null,
        speakerName: String(entry.speakerName || "").trim() || null
      };
    })
    .filter(Boolean)
    .slice(-boundedMax);
}

function appendStreamWatchBrainContextEntry({
  session,
  text,
  at,
  provider = null,
  model = null,
  speakerName = null,
  maxEntries = 8
}) {
  if (!session) return null;
  const normalizedText = normalizeVoiceText(text, STREAM_WATCH_BRAIN_CONTEXT_LINE_MAX_CHARS);
  if (!normalizedText) return null;
  const normalizedAt = Number.isFinite(Number(at)) ? Math.max(0, Math.round(Number(at))) : Date.now();
  const boundedMax = clamp(Number(maxEntries) || 8, 1, 24);
  const current = getStreamWatchBrainContextEntries(session, boundedMax);
  const last = current[current.length - 1] || null;
  const normalizedProvider = String(provider || "").trim() || null;
  const normalizedModel = String(model || "").trim() || null;
  const normalizedSpeakerName = String(speakerName || "").trim() || null;
  let nextEntries = current;

  if (last && last.text.toLowerCase() === normalizedText.toLowerCase()) {
    nextEntries = [
      ...current.slice(0, -1),
      {
        ...last,
        at: normalizedAt,
        provider: normalizedProvider || last.provider || null,
        model: normalizedModel || last.model || null,
        speakerName: normalizedSpeakerName || last.speakerName || null
      }
    ];
  } else {
    nextEntries = [
      ...current,
      {
        text: normalizedText,
        at: normalizedAt,
        provider: normalizedProvider,
        model: normalizedModel,
        speakerName: normalizedSpeakerName
      }
    ].slice(-boundedMax);
  }

  session.streamWatch = session.streamWatch || {};
  session.streamWatch.brainContextEntries = nextEntries;
  session.streamWatch.lastBrainContextAt = normalizedAt;
  session.streamWatch.lastBrainContextProvider = normalizedProvider;
  session.streamWatch.lastBrainContextModel = normalizedModel;
  return nextEntries[nextEntries.length - 1] || null;
}

function isStreamWatchPlaybackBusy(session) {
  if (!session || session.ending) return false;
  if (session.botTurnOpen) return true;
  const queueState =
    session.audioPlaybackQueue && typeof session.audioPlaybackQueue === "object"
      ? session.audioPlaybackQueue
      : null;
  if (!queueState) return false;
  const queuedBytes = Math.max(0, Number(queueState.queuedBytes || 0));
  const queueActive = Boolean(queueState.pumping || queueState.waitingDrain);
  const streamBufferedBytes = Math.max(0, Number(session.botAudioStream?.writableLength || 0));
  return queueActive || queuedBytes > 0 || streamBufferedBytes > 0;
}

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
  session.streamWatch.lastBrainContextAt = 0;
  session.streamWatch.lastBrainContextProvider = null;
  session.streamWatch.lastBrainContextModel = null;
  session.streamWatch.brainContextEntries = [];
  session.streamWatch.ingestedFrameCount = 0;
  session.streamWatch.acceptedFrameCountInWindow = 0;
  session.streamWatch.frameWindowStartedAt = 0;
  session.streamWatch.latestFrameMimeType = null;
  session.streamWatch.latestFrameDataBase64 = "";
  session.streamWatch.latestFrameAt = 0;
}

export function getStreamWatchBrainContextForPrompt(session, settings = null) {
  if (!session || session.ending) return null;
  const streamWatch = session.streamWatch || {};
  if (!streamWatch.active) return null;

  const brainContextSettings = resolveStreamWatchBrainContextSettings(settings);
  if (!brainContextSettings.enabled) return null;

  const entries = getStreamWatchBrainContextEntries(session, brainContextSettings.maxEntries);
  if (!entries.length) return null;

  const now = Date.now();
  const notes = entries
    .map((entry) => {
      const ageMs = Math.max(0, now - Number(entry.at || 0));
      const ageSeconds = Math.floor(ageMs / 1000);
      const ageLabel = ageSeconds <= 1 ? "just now" : `${ageSeconds}s ago`;
      const speakerLabel = entry.speakerName ? `${entry.speakerName}: ` : "";
      return `${speakerLabel}${entry.text} (${ageLabel})`;
    })
    .slice(-brainContextSettings.maxEntries);

  if (!notes.length) return null;

  const last = entries[entries.length - 1] || null;
  return {
    prompt: brainContextSettings.prompt,
    notes,
    lastAt: Number(last?.at || 0) || null,
    provider: last?.provider || streamWatch.lastBrainContextProvider || null,
    model: last?.model || streamWatch.lastBrainContextModel || null
  };
}

export function supportsStreamWatchCommentary(manager, session, settings = null) {
  if (!session || session.ending) return false;
  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();
  if (!isRealtimeMode(session.mode)) return false;
  const realtimeClient = session.realtimeClient;
  const streamWatchSettings = resolvedSettings?.voice?.streamWatch || {};
  const autonomousCommentaryEnabled =
    streamWatchSettings.autonomousCommentaryEnabled !== undefined
      ? Boolean(streamWatchSettings.autonomousCommentaryEnabled)
      : true;
  const brainContextSettings = resolveStreamWatchBrainContextSettings(resolvedSettings);
  const brainContextReady =
    brainContextSettings.enabled &&
    supportsStreamWatchBrainContext(manager, { session, settings: resolvedSettings });

  if (!autonomousCommentaryEnabled) return brainContextReady;

  const commentaryPath = resolveStreamWatchCommentaryPath(resolvedSettings);
  if (commentaryPath === STREAM_WATCH_COMMENTARY_PATH_ANTHROPIC_KEYFRAMES) {
    return (
      supportsVisionFallbackStreamWatchCommentary(manager, { session, settings: resolvedSettings }) ||
      brainContextReady
    );
  }
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
  const realtimeClient = session.realtimeClient;
  if (!realtimeClient || typeof realtimeClient.requestTextUtterance !== "function") return false;
  if (!manager.llm || typeof manager.llm.generate !== "function") return false;
  return Boolean(resolveStreamWatchVisionProviderSettings(manager, settings));
}

export function supportsStreamWatchBrainContext(manager, { session = null, settings = null } = {}) {
  if (!session || session.ending) return false;
  if (!manager.llm || typeof manager.llm.generate !== "function") return false;
  const commentaryPath = resolveStreamWatchCommentaryPath(settings);
  if (commentaryPath !== STREAM_WATCH_COMMENTARY_PATH_ANTHROPIC_KEYFRAMES) return false;
  return Boolean(resolveStreamWatchVisionProviderSettings(manager, settings));
}

export function resolveStreamWatchVisionProviderSettings(manager, settings = null) {
  const commentaryPath = resolveStreamWatchCommentaryPath(settings);
  const llmSettings = settings?.llm && typeof settings.llm === "object" ? settings.llm : {};
  const fallbackCandidates = [
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
  const candidates = commentaryPath === STREAM_WATCH_COMMENTARY_PATH_ANTHROPIC_KEYFRAMES
    ? fallbackCandidates.filter((candidate) => candidate.provider === "anthropic")
    : fallbackCandidates;

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
    "You can see the provided frame.",
    "Never say you cannot see the screen or ask for a stream link.",
    "Return exactly one short spoken commentary line (max 12 words).",
    "No lists, no quotes, no stage directions."
  ].join(" ");
  const userPrompt = [
    `Latest frame from ${speakerName}'s stream.`,
    "Comment on only what is visible in this frame.",
    "If uncertain about details, say that briefly without denying visibility."
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

async function generateVisionFallbackStreamWatchBrainContext(manager, {
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
  const brainContextSettings = resolveStreamWatchBrainContextSettings(settings);
  const systemPrompt = [
    `You are ${getPromptBotName(settings)} preparing private stream-watch notes for your own voice brain.`,
    "You are looking at one still frame from a live stream.",
    "Never claim you cannot see the stream.",
    "Return exactly one short factual note (max 16 words).",
    "Do not write dialogue or commands."
  ].join(" ");
  const userPrompt = [
    `Frame from ${speakerName}'s stream.`,
    String(brainContextSettings.prompt || DEFAULT_STREAM_WATCH_BRAIN_CONTEXT_PROMPT),
    "Focus only on what is visible now. Mention uncertainty briefly if needed."
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
      source: "voice_stream_watch_brain_context"
    }
  });

  const rawText = String(generated?.text || "").trim();
  const oneLine = rawText.split(/\r?\n/)[0] || "";
  const text = normalizeVoiceText(oneLine, STREAM_WATCH_BRAIN_CONTEXT_LINE_MAX_CHARS);
  if (!text) return null;
  return {
    text,
    provider: generated?.provider || providerSettings.provider || null,
    model: generated?.model || providerSettings.model || null
  };
}

async function maybeRefreshStreamWatchBrainContext(manager, {
  session,
  settings,
  streamerUserId = null,
  source = "api_stream_ingest"
}) {
  if (!session || session.ending) return null;
  if (!session.streamWatch?.active) return null;
  const brainContextSettings = resolveStreamWatchBrainContextSettings(settings);
  if (!brainContextSettings.enabled) return null;
  const now = Date.now();
  const minIntervalMs = brainContextSettings.minIntervalSeconds * 1000;
  if (now - Number(session.streamWatch.lastBrainContextAt || 0) < minIntervalMs) return null;

  const bufferedFrame = String(session.streamWatch?.latestFrameDataBase64 || "").trim();
  if (!bufferedFrame) return null;
  const generated = await generateVisionFallbackStreamWatchBrainContext(manager, {
    session,
    settings,
    streamerUserId,
    frameMimeType: session.streamWatch?.latestFrameMimeType || "image/jpeg",
    frameDataBase64: bufferedFrame
  });
  const note = normalizeVoiceText(generated?.text || "", STREAM_WATCH_BRAIN_CONTEXT_LINE_MAX_CHARS);
  if (!note) return null;
  const speakerName = manager.resolveVoiceSpeakerName(session, streamerUserId) || null;
  const stored = appendStreamWatchBrainContextEntry({
    session,
    text: note,
    at: now,
    provider: generated?.provider || null,
    model: generated?.model || null,
    speakerName,
    maxEntries: brainContextSettings.maxEntries
  });
  if (!stored) return null;

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: manager.client.user?.id || null,
    content: "stream_watch_brain_context_updated",
    metadata: {
      sessionId: session.id,
      source: String(source || "api_stream_ingest"),
      streamerUserId: streamerUserId || null,
      provider: generated?.provider || null,
      model: generated?.model || null,
      note: stored.text
    }
  });

  return {
    note: stored.text,
    provider: generated?.provider || null,
    model: generated?.model || null
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
  session.streamWatch.lastBrainContextAt = 0;
  session.streamWatch.lastBrainContextProvider = null;
  session.streamWatch.lastBrainContextModel = null;
  session.streamWatch.brainContextEntries = [];

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
  const lastBrainContextAgoSec = Number(streamWatch.lastBrainContextAt || 0)
    ? Math.max(0, Math.floor((Date.now() - Number(streamWatch.lastBrainContextAt || 0)) / 1000))
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
      lastBrainContextAgoSec,
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
  }
  streamWatch.latestFrameMimeType = resolvedMimeType;
  streamWatch.latestFrameDataBase64 = normalizedFrame;
  streamWatch.latestFrameAt = now;

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

  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();
  const streamWatchSettings = resolvedSettings?.voice?.streamWatch || {};
  const commentaryPath = resolveStreamWatchCommentaryPath(resolvedSettings);
  const forceAnthropicKeyframes = commentaryPath === STREAM_WATCH_COMMENTARY_PATH_ANTHROPIC_KEYFRAMES;

  if (forceAnthropicKeyframes) {
    try {
      await maybeRefreshStreamWatchBrainContext(manager, {
        session,
        settings: resolvedSettings,
        streamerUserId,
        source
      });
    } catch (error) {
      manager.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: manager.client.user?.id || null,
        content: `stream_watch_brain_context_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          source: String(source || "api_stream_ingest")
        }
      });
    }
  }

  const autonomousCommentaryEnabled =
    streamWatchSettings.autonomousCommentaryEnabled !== undefined
      ? Boolean(streamWatchSettings.autonomousCommentaryEnabled)
      : true;
  if (!autonomousCommentaryEnabled) return;

  if (session.userCaptures.size > 0) return;
  if (session.pendingResponse) return;
  if (isStreamWatchPlaybackBusy(session)) return;

  const quietWindowMs = STREAM_WATCH_AUDIO_QUIET_WINDOW_MS;
  const sinceLastInboundAudio = Date.now() - Number(session.lastInboundAudioAt || 0);
  if (Number(session.lastInboundAudioAt || 0) > 0 && sinceLastInboundAudio < quietWindowMs) return;

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
    if (!forceAnthropicKeyframes && typeof realtimeClient.requestVideoCommentary === "function") {
      realtimeClient.requestVideoCommentary(nativePrompt);
    } else if (typeof realtimeClient.requestTextUtterance === "function") {
      const bufferedFrame = String(session.streamWatch?.latestFrameDataBase64 || "").trim();
      if (!bufferedFrame) return;
      const generated = await generateVisionFallbackStreamWatchCommentary(manager, {
        session,
        settings: resolvedSettings,
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
        configuredCommentaryPath: commentaryPath,
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
