import { clamp, deepMerge } from "../utils.ts";
import { getPromptBotName } from "../prompts/promptCore.ts";
import { safeJsonParseFromString } from "../normalization/valueParsers.ts";
import { buildVoiceReplyScopeKey } from "../tools/activeReplyRegistry.ts";
import {
  getBotName,
  getResolvedOrchestratorBinding,
  getResolvedVoiceGenerationBinding,
  getVoiceStreamWatchSettings
} from "../settings/agentStack.ts";
import {
  buildStreamKey,
  getStreamByUserAndGuild,
  requestStreamWatch,
  streamHasCredentials,
  type StreamDiscoveryClientLike,
  type GoLiveStream,
  type StreamDiscoveryState
} from "../selfbot/streamDiscovery.ts";
import { isRealtimeMode, normalizeVoiceText } from "./voiceSessionHelpers.ts";
import {
  clearNativeDiscordScreenShareState,
  ensureNativeDiscordScreenShareState,
  listActiveNativeDiscordScreenSharers,
  removeNativeDiscordVideoSharer,
  sharerHasWebcamOnly
} from "./nativeDiscordScreenShare.ts";
import { sendOperationalMessage } from "./voiceOperationalMessaging.ts";

type StreamWatchSession = {
  id?: string | null;
  guildId?: string | null;
  textChannelId?: string | null;
  voiceChannelId?: string | null;
  mode?: string | null;
  ending?: boolean;
  settingsSnapshot?: Record<string, unknown> | null;
  streamWatch?: Record<string, unknown> | null;
  nativeScreenShare?: Record<string, unknown> | null;
  voxClient?: {
    subscribeUserVideo?: (payload: Record<string, unknown>) => void;
    unsubscribeUserVideo?: (userId: string) => void;
    streamWatchConnect?: (payload: {
      endpoint: string;
      token: string;
      serverId: string;
      sessionId: string;
      userId: string;
      daveChannelId: string;
    }) => void;
    streamWatchDisconnect?: (reason?: string | null) => void;
    getLastVoiceSessionId?: () => string | null;
  } | null;
  botTurnOpen?: boolean;
  botAudioStream?: { writableLength?: number } | null;
  inFlightAcceptedBrainTurn?: object | null;
  pendingFileAsrTurns?: number;
  realtimeTurnDrainActive?: boolean;
  pendingRealtimeTurns?: unknown[] | null;
  realtimeClient?: {
    appendInputVideoFrame?: (payload: { mimeType: string; dataBase64: string }) => void;
  } | null;
  userCaptures?: Map<string, unknown>;
  pendingResponse?: unknown;
  lastInboundAudioAt?: number;
  [key: string]: unknown;
};

type StreamWatchManager = {
  client: StreamDiscoveryClientLike & {
    user?: { id?: string | null; username?: string | null } | null;
    guilds: {
      cache: Map<string, {
        channels?: {
          cache?: Map<string, {
            members?: {
              has?: (userId: string) => boolean;
            } | null;
          }>;
        } | null;
        members?: {
          me?: {
            voice?: {
              sessionId?: string | null;
            } | null;
          } | null;
        } | null;
      }>;
    };
  };
  llm?: {
    isProviderConfigured?: (provider: string) => boolean;
    generate?: (payload: Record<string, unknown>) => Promise<{
      text?: string | null;
      provider?: string | null;
      model?: string | null;
    } | null>;
  } | null;
  memory?: {
    ingestMessage?: (payload: Record<string, unknown>) => Promise<unknown>;
    rememberDirectiveLineDetailed?: (payload: Record<string, unknown>) => Promise<{
      ok?: boolean;
      reason?: string | null;
    } | null>;
  } | null;
  resolveVoiceSpeakerName: (session: StreamWatchSession, userId?: string | null) => string | null;
  sessions: Map<string, StreamWatchSession>;
  store: {
    getSettings: () => Record<string, unknown> | null;
    logAction: (entry: Record<string, unknown>) => void;
  };
  streamDiscovery?: StreamDiscoveryState | null;
  touchActivity: (guildId: string, resolvedSettings?: Record<string, unknown> | null) => void;
  composeOperationalMessage?: (payload: Record<string, unknown>) => Promise<string | null>;
  deferredActionQueue?: {
    getDeferredQueuedUserTurns?: (session: StreamWatchSession) => unknown[] | null;
  } | null;
  getOutputChannelState?: (session: StreamWatchSession) => { locked?: boolean } | null;
  runRealtimeBrainReply?: (payload: {
    session: StreamWatchSession;
    settings: Record<string, unknown> | null;
    userId: string;
    transcript?: string;
    inputKind?: string;
    directAddressed?: boolean;
    directAddressConfidence?: number;
    conversationContext?: unknown;
    musicWakeFollowupEligibleAtCapture?: boolean;
    source?: string;
    latencyContext?: unknown;
    frozenFrameSnapshot?: unknown;
    runtimeEventContext?: unknown;
  }) => Promise<unknown>;
  activeReplies?: {
    has?: (scopeKey: string) => boolean;
  } | null;
};

type EnableWatchStreamResult = {
  ok: boolean;
  reason?: string;
  targetUserId?: string;
  fallback?: string;
  reused?: boolean;
  frameReady?: boolean;
};

const STREAM_WATCH_AUDIO_QUIET_WINDOW_MS = 2200;
const NOTE_RECENT_TRANSCRIPT_MAX_TURNS = 3;
const NOTE_RECENT_TRANSCRIPT_MAX_CHARS = 200;

function getRecentTranscriptSnippet(session: StreamWatchSession): string {
  const turns = Array.isArray(session.transcriptTurns) ? session.transcriptTurns : [];
  const speechTurns = turns
    .filter((t): t is Record<string, unknown> =>
      t != null && typeof t === "object" && (!("kind" in t) || t.kind === "speech")
    )
    .slice(-NOTE_RECENT_TRANSCRIPT_MAX_TURNS);
  if (speechTurns.length === 0) return "";
  const lines = speechTurns.map((t) => {
    const name = String(t.speakerName || t.role || "?").trim();
    const text = String(t.text || "").replace(/\s+/g, " ").trim().slice(0, 80);
    return `${name}: ${text}`;
  });
  const joined = lines.join(" | ");
  return joined.length > NOTE_RECENT_TRANSCRIPT_MAX_CHARS
    ? joined.slice(0, NOTE_RECENT_TRANSCRIPT_MAX_CHARS - 1) + "…"
    : joined;
}
const STREAM_WATCH_NOTE_PROMPT_MAX_CHARS = 420;
const STREAM_WATCH_NOTE_LINE_MAX_CHARS = 220;
const STREAM_WATCH_NOTE_MAX_OUTPUT_TOKENS = 72;
const DEFAULT_STREAM_WATCH_NOTE_PROMPT =
  "Write one short factual private note about the most salient visible state or change in this frame. Prioritize gameplay actions, objectives, outcomes, menus, or unusual/funny moments that could support a natural later comment. If the frame is mostly idle UI, lobby, desktop, or other non-gameplay context, say that plainly. Prefer what is newly different from the previous frame.";
const STREAM_WATCH_NOTE_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    note: { type: "string" }
  },
  required: ["note"],
  additionalProperties: false
});
const STREAM_WATCH_MEMORY_RECAP_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    shouldStore: { type: "boolean" },
    recap: { type: "string" }
  },
  required: ["shouldStore", "recap"],
  additionalProperties: false
});

type StreamWatchNoteLoopState = {
  timer: ReturnType<typeof setTimeout> | null;
  nextRunAt: number;
  running: boolean;
  lastChangeCaptureAt: number;
};

const streamWatchNoteLoopState = new WeakMap<StreamWatchSession, StreamWatchNoteLoopState>();

function getStreamWatchNoteLoopState(session: StreamWatchSession): StreamWatchNoteLoopState {
  const existing = streamWatchNoteLoopState.get(session);
  if (existing) return existing;
  const created: StreamWatchNoteLoopState = {
    timer: null,
    nextRunAt: 0,
    running: false,
    lastChangeCaptureAt: 0
  };
  streamWatchNoteLoopState.set(session, created);
  return created;
}

function clearStreamWatchNoteTimer(session: StreamWatchSession | null | undefined) {
  if (!session) return;
  const state = getStreamWatchNoteLoopState(session);
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.nextRunAt = 0;
}

function resolveStreamWatchNoteSettings(settings = null) {
  const streamWatchSettings = getVoiceStreamWatchSettings(settings);
  const prompt = normalizeVoiceText(
    String(streamWatchSettings.notePrompt || ""),
    STREAM_WATCH_NOTE_PROMPT_MAX_CHARS
  );

  return {
    provider: String(streamWatchSettings.noteProvider || "").trim(),
    model: String(streamWatchSettings.noteModel || "").trim(),
    intervalSeconds: clamp(
      Number(streamWatchSettings.noteIntervalSeconds) || 10,
      3,
      120
    ),
    idleIntervalSeconds: clamp(
      Number(streamWatchSettings.noteIdleIntervalSeconds) || 30,
      10,
      120
    ),
    staticFloor: clamp(
      Number(streamWatchSettings.staticFloor) || 0.005,
      0.001,
      0.05
    ),
    maxEntries: clamp(
      Number(streamWatchSettings.maxNoteEntries) || 12,
      1,
      24
    ),
    changeThreshold: clamp(
      Number(streamWatchSettings.changeThreshold) || 0.01,
      0.005,
      1.0
    ),
    changeMinIntervalSeconds: clamp(
      Number(streamWatchSettings.changeMinIntervalSeconds) || 2,
      1,
      30
    ),
    prompt: prompt || DEFAULT_STREAM_WATCH_NOTE_PROMPT
  };
}

function resolveStreamWatchCommentarySettings(settings = null) {
  const streamWatchSettings = getVoiceStreamWatchSettings(settings);
  return {
    enabled:
      streamWatchSettings.autonomousCommentaryEnabled !== undefined
        ? Boolean(streamWatchSettings.autonomousCommentaryEnabled)
        : true,
    intervalSeconds: clamp(
      Number(streamWatchSettings.commentaryIntervalSeconds) || 15,
      5,
      120
    ),
    changeThreshold: clamp(
      Number(streamWatchSettings.changeThreshold) || 0.01,
      0.005,
      1.0
    ),
    changeMinIntervalSeconds: clamp(
      Number(streamWatchSettings.changeMinIntervalSeconds) || 2,
      1,
      30
    ),
    provider: String(streamWatchSettings.commentaryProvider || "").trim(),
    model: String(streamWatchSettings.commentaryModel || "").trim()
  };
}

function getStreamWatchNoteEntries(session, maxEntries = 8) {
  const streamWatch = session?.streamWatch && typeof session.streamWatch === "object" ? session.streamWatch : {};
  const entries = Array.isArray(streamWatch.noteEntries) ? streamWatch.noteEntries : [];
  const boundedMax = clamp(Number(maxEntries) || 8, 1, 24);
  return entries
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const text = normalizeVoiceText(entry.text, STREAM_WATCH_NOTE_LINE_MAX_CHARS);
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

function getLatestStreamWatchNoteEntry(session) {
  const entries = getStreamWatchNoteEntries(session, 24);
  return entries[entries.length - 1] || null;
}

function resolveNativeDiscordVideoSubscriptionSettings(settings = null) {
  const streamWatchSettings = getVoiceStreamWatchSettings(settings);
  const preferredPixelCountRaw = Number(streamWatchSettings.nativeDiscordPreferredPixelCount) || 0;
  return {
    maxFramesPerSecond: clamp(
      Number(streamWatchSettings.nativeDiscordMaxFramesPerSecond) || 2,
      1,
      10
    ),
    preferredQuality: clamp(
      Number(streamWatchSettings.nativeDiscordPreferredQuality) || 100,
      0,
      100
    ),
    preferredPixelCount:
      preferredPixelCountRaw > 0
        ? clamp(preferredPixelCountRaw, 64 * 64, 3840 * 2160)
        : 640 * 360,
    jpegQuality: clamp(
      Number(streamWatchSettings.nativeDiscordJpegQuality) || 60,
      10,
      100
    ),
    preferredStreamType:
      String(streamWatchSettings.nativeDiscordPreferredStreamType || "screen")
        .trim()
        .toLowerCase() || null
  };
}

function getStreamDiscoveryState(manager: StreamWatchManager): StreamDiscoveryState | null {
  const state = manager.streamDiscovery;
  if (!state || typeof state !== "object") return null;
  return state.streams instanceof Map ? state : null;
}

function deriveStreamWatchDaveChannelId(rtcServerId: string | null | undefined): string | null {
  const normalizedRtcServerId = String(rtcServerId || "").trim();
  if (!normalizedRtcServerId) return null;
  try {
    const serverId = BigInt(normalizedRtcServerId);
    if (serverId <= 0n) return null;
    return String(serverId - 1n);
  } catch {
    return null;
  }
}

function getCurrentVoiceSessionId(manager: StreamWatchManager, session): string | null {
  const clientSessionId =
    session?.voxClient && typeof session.voxClient.getLastVoiceSessionId === "function"
      ? session.voxClient.getLastVoiceSessionId()
      : null;
  const normalizedClientSessionId = String(clientSessionId || "").trim();
  if (normalizedClientSessionId) return normalizedClientSessionId;

  const guild = manager.client.guilds.cache.get(String(session?.guildId || "").trim()) || null;
  const gatewayVoiceSessionId = String(guild?.members?.me?.voice?.sessionId || "").trim();
  return gatewayVoiceSessionId || null;
}

function updateNativeDiscordStreamTransportState(session, {
  activeStreamKey,
  lastRtcServerId,
  lastStreamEndpoint,
  lastCredentialsReceivedAt,
  lastVoiceSessionId,
  transportStatus,
  transportReason,
  transportConnectedAt
}: {
  activeStreamKey?: string | null;
  lastRtcServerId?: string | null;
  lastStreamEndpoint?: string | null;
  lastCredentialsReceivedAt?: number;
  lastVoiceSessionId?: string | null;
  transportStatus?: string | null;
  transportReason?: string | null;
  transportConnectedAt?: number;
} = {}) {
  const nativeScreenShare = ensureNativeDiscordScreenShareState(session);
  const now = Date.now();

  if (activeStreamKey !== undefined) {
    nativeScreenShare.activeStreamKey = String(activeStreamKey || "").trim() || null;
  }
  if (lastRtcServerId !== undefined) {
    nativeScreenShare.lastRtcServerId = String(lastRtcServerId || "").trim() || null;
  }
  if (lastStreamEndpoint !== undefined) {
    nativeScreenShare.lastStreamEndpoint = String(lastStreamEndpoint || "").trim() || null;
  }
  if (lastCredentialsReceivedAt !== undefined) {
    nativeScreenShare.lastCredentialsReceivedAt = Math.max(0, Math.floor(Number(lastCredentialsReceivedAt) || 0));
  }
  if (lastVoiceSessionId !== undefined) {
    nativeScreenShare.lastVoiceSessionId = String(lastVoiceSessionId || "").trim() || null;
  }
  if (transportStatus !== undefined) {
    nativeScreenShare.transportStatus = String(transportStatus || "").trim() || null;
    nativeScreenShare.transportUpdatedAt = now;
  }
  if (transportReason !== undefined) {
    nativeScreenShare.transportReason = String(transportReason || "").trim() || null;
  }
  if (transportConnectedAt !== undefined) {
    nativeScreenShare.transportConnectedAt = Math.max(0, Math.floor(Number(transportConnectedAt) || 0));
  }

  return nativeScreenShare;
}

function clearNativeDiscordStreamTransportState(session, reason: string | null = null) {
  return updateNativeDiscordStreamTransportState(session, {
    activeStreamKey: null,
    lastRtcServerId: null,
    lastStreamEndpoint: null,
    lastCredentialsReceivedAt: 0,
    lastVoiceSessionId: null,
    transportStatus: null,
    transportReason: String(reason || "").trim() || null,
    transportConnectedAt: 0
  });
}

function resolveRequestedStream(session, targetUserId: string, discoveryState: StreamDiscoveryState | null) {
  const normalizedTargetUserId = String(targetUserId || "").trim();
  const normalizedGuildId = String(session?.guildId || "").trim();
  const normalizedVoiceChannelId = String(session?.voiceChannelId || "").trim();
  const discoveredStream =
    discoveryState && normalizedGuildId && normalizedTargetUserId
      ? getStreamByUserAndGuild(discoveryState, normalizedTargetUserId, normalizedGuildId)
      : null;
  if (discoveredStream?.streamKey) {
    return {
      streamKey: discoveredStream.streamKey,
      stream: discoveredStream
    };
  }
  if (!normalizedGuildId || !normalizedVoiceChannelId || !normalizedTargetUserId) {
    return {
      streamKey: null,
      stream: null
    };
  }
  return {
    streamKey: buildStreamKey(normalizedGuildId, normalizedVoiceChannelId, normalizedTargetUserId),
    stream: null
  };
}

function requestNativeDiscordStreamWatch(manager: StreamWatchManager, session, {
  targetUserId,
  source = "screen_share_link"
}: {
  targetUserId: string;
  source?: string | null;
}) {
  const discoveryState = getStreamDiscoveryState(manager);
  if (!discoveryState) {
    return {
      ok: false,
      reason: "stream_discovery_unavailable",
      fallback: "screen_share_link",
      stream: null as GoLiveStream | null
    };
  }

  const requested = resolveRequestedStream(session, targetUserId, discoveryState);
  if (!requested.streamKey) {
    return {
      ok: false,
      reason: "stream_key_unavailable",
      fallback: "screen_share_link",
      stream: null as GoLiveStream | null
    };
  }

  const watchRequested = requestStreamWatch(manager.client, discoveryState, requested.streamKey);
  if (!watchRequested) {
    return {
      ok: false,
      reason: "stream_watch_request_failed",
      fallback: "screen_share_link",
      stream: requested.stream
    };
  }

  updateNativeDiscordStreamTransportState(session, {
    activeStreamKey: requested.streamKey,
    transportStatus: "watch_requested",
    transportReason: null
  });

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: targetUserId,
    content: "native_discord_stream_watch_requested",
    metadata: {
      sessionId: session.id,
      source: String(source || "screen_share_link"),
      streamKey: requested.streamKey,
      hasDiscoveredStream: Boolean(requested.stream)
    }
  });

  return {
    ok: true,
    reason: "stream_watch_requested",
    fallback: null,
    stream: requested.stream
  };
}

function connectNativeDiscordStreamTransport(
  manager: StreamWatchManager,
  session,
  stream: GoLiveStream,
  {
    source = "stream_credentials_received"
  }: {
    source?: string | null;
  } = {}
) {
  if (!streamHasCredentials(stream)) {
    updateNativeDiscordStreamTransportState(session, {
      activeStreamKey: stream.streamKey,
      transportStatus: "waiting_for_credentials",
      transportReason: null
    });
    return {
      ok: false,
      reason: "waiting_for_credentials"
    };
  }

  if (!session?.voxClient || typeof session.voxClient.streamWatchConnect !== "function") {
    updateNativeDiscordStreamTransportState(session, {
      activeStreamKey: stream.streamKey,
      lastRtcServerId: stream.rtcServerId,
      lastStreamEndpoint: stream.endpoint,
      lastCredentialsReceivedAt: Number(stream.credentialsReceivedAt || 0),
      transportStatus: "transport_unavailable",
      transportReason: "stream_watch_connect_missing"
    });
    return {
      ok: false,
      reason: "stream_watch_transport_unavailable"
    };
  }

  const currentVoiceSessionId = getCurrentVoiceSessionId(manager, session);
  if (!currentVoiceSessionId) {
    updateNativeDiscordStreamTransportState(session, {
      activeStreamKey: stream.streamKey,
      lastRtcServerId: stream.rtcServerId,
      lastStreamEndpoint: stream.endpoint,
      lastCredentialsReceivedAt: Number(stream.credentialsReceivedAt || 0),
      transportStatus: "waiting_for_voice_session",
      transportReason: null
    });
    return {
      ok: false,
      reason: "voice_session_id_unavailable"
    };
  }

  const daveChannelId = deriveStreamWatchDaveChannelId(stream.rtcServerId);
  if (!daveChannelId) {
    updateNativeDiscordStreamTransportState(session, {
      activeStreamKey: stream.streamKey,
      lastRtcServerId: stream.rtcServerId,
      lastStreamEndpoint: stream.endpoint,
      lastCredentialsReceivedAt: Number(stream.credentialsReceivedAt || 0),
      lastVoiceSessionId: currentVoiceSessionId,
      transportStatus: "invalid_dave_channel",
      transportReason: "rtc_server_id_derivation_failed"
    });
    return {
      ok: false,
      reason: "dave_channel_id_unavailable"
    };
  }

  const nativeScreenShare = ensureNativeDiscordScreenShareState(session);
  const alreadyCurrent =
    nativeScreenShare.activeStreamKey === stream.streamKey &&
    nativeScreenShare.lastRtcServerId === stream.rtcServerId &&
    nativeScreenShare.lastStreamEndpoint === stream.endpoint &&
    nativeScreenShare.lastVoiceSessionId === currentVoiceSessionId &&
    (nativeScreenShare.transportStatus === "connect_requested" ||
      nativeScreenShare.transportStatus === "connecting" ||
      nativeScreenShare.transportStatus === "ready");
  if (alreadyCurrent) {
    return {
      ok: true,
      reason: nativeScreenShare.transportStatus || "already_connected"
    };
  }

  session.voxClient.streamWatchConnect({
    endpoint: String(stream.endpoint || "").trim(),
    token: String(stream.token || "").trim(),
    serverId: String(stream.rtcServerId || "").trim(),
    sessionId: currentVoiceSessionId,
    userId: String(manager.client.user?.id || "").trim(),
    daveChannelId
  });

  updateNativeDiscordStreamTransportState(session, {
    activeStreamKey: stream.streamKey,
    lastRtcServerId: stream.rtcServerId,
    lastStreamEndpoint: stream.endpoint,
    lastCredentialsReceivedAt: Number(stream.credentialsReceivedAt || Date.now()),
    lastVoiceSessionId: currentVoiceSessionId,
    transportStatus: "connect_requested",
    transportReason: null
  });

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: stream.userId,
    content: "native_discord_stream_transport_connect_requested",
    metadata: {
      sessionId: session.id,
      source: String(source || "stream_credentials_received"),
      streamKey: stream.streamKey,
      rtcServerId: stream.rtcServerId,
      voiceSessionId: currentVoiceSessionId
    }
  });

  return {
    ok: true,
    reason: "stream_transport_connect_requested"
  };
}

function disconnectNativeDiscordStreamTransport(
  manager: StreamWatchManager,
  session,
  reason: string | null = null
) {
  const nativeScreenShare = ensureNativeDiscordScreenShareState(session);
  const normalizedReason = String(reason || "").trim() || "stream_watch_stopped";

  if (session?.voxClient && typeof session.voxClient.streamWatchDisconnect === "function") {
    try {
      session.voxClient.streamWatchDisconnect(normalizedReason);
    } catch (error) {
      manager.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: session.streamWatch?.targetUserId || manager.client.user?.id || null,
        content: `native_discord_stream_transport_disconnect_failed: ${String((error as Error)?.message || error)}`,
        metadata: {
          sessionId: session.id,
          reason: normalizedReason,
          streamKey: nativeScreenShare.activeStreamKey || null
        }
      });
    }
  }

  clearNativeDiscordStreamTransportState(session, normalizedReason);
}

function clearNativeDiscordSubscriptionState(session, targetUserId = null) {
  if (
    session?.nativeScreenShare &&
    typeof session.nativeScreenShare === "object" &&
    (!targetUserId || session.nativeScreenShare.subscribedTargetUserId === targetUserId)
  ) {
    session.nativeScreenShare.subscribedTargetUserId = null;
  }
}

function unsubscribeNativeDiscordVideo(manager: StreamWatchManager, session, targetUserId, reason) {
  const normalizedTargetUserId = String(targetUserId || "").trim();
  if (!session || !normalizedTargetUserId) {
    clearNativeDiscordSubscriptionState(session, normalizedTargetUserId);
    return;
  }

  try {
    if (typeof session.voxClient?.unsubscribeUserVideo === "function") {
      session.voxClient.unsubscribeUserVideo(normalizedTargetUserId);
    }
  } catch (error) {
    manager.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: normalizedTargetUserId,
      content: `native_discord_video_unsubscribe_failed: ${String((error as Error)?.message || error)}`,
      metadata: {
        sessionId: session.id,
        targetUserId: normalizedTargetUserId,
        reason: String(reason || "stream_watch_stop")
      }
    });
  } finally {
    clearNativeDiscordSubscriptionState(session, normalizedTargetUserId);
  }
}

function subscribeNativeDiscordVideo(
  manager: StreamWatchManager,
  session,
  settings,
  targetUserId,
  source
) {
  const normalizedTargetUserId = String(targetUserId || "").trim();
  if (!session || !normalizedTargetUserId || typeof session.voxClient?.subscribeUserVideo !== "function") {
    return;
  }

  const currentTargetUserId =
    session.nativeScreenShare && typeof session.nativeScreenShare === "object"
      ? String(session.nativeScreenShare.subscribedTargetUserId || "").trim() || null
      : null;
  if (currentTargetUserId && currentTargetUserId !== normalizedTargetUserId) {
    unsubscribeNativeDiscordVideo(manager, session, currentTargetUserId, "stream_watch_retarget");
  }

  const subscription = resolveNativeDiscordVideoSubscriptionSettings(settings);
  try {
    session.voxClient.subscribeUserVideo({
      userId: normalizedTargetUserId,
      maxFramesPerSecond: subscription.maxFramesPerSecond,
      preferredQuality: subscription.preferredQuality,
      preferredPixelCount: subscription.preferredPixelCount,
      preferredStreamType: subscription.preferredStreamType,
      jpegQuality: subscription.jpegQuality
    });
    if (session.nativeScreenShare && typeof session.nativeScreenShare === "object") {
      session.nativeScreenShare.subscribedTargetUserId = normalizedTargetUserId;
    }
  } catch (error) {
    manager.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: normalizedTargetUserId,
      content: `native_discord_video_subscribe_failed: ${String((error as Error)?.message || error)}`,
      metadata: {
        sessionId: session.id,
        targetUserId: normalizedTargetUserId,
        source: String(source || "screen_share_link")
      }
    });
  }
}

function buildStreamWatchNotesText(session, maxEntries = 6) {
  return getStreamWatchNoteEntries(session, maxEntries)
    .slice(-Math.max(1, Number(maxEntries) || 6))
    .map((entry, index) => {
      const speakerPrefix = entry.speakerName ? `${entry.speakerName}: ` : "";
      return `${index + 1}. ${speakerPrefix}${entry.text}`;
    })
    .join("\n");
}

export function appendStreamWatchNoteEntry({
  session,
  text,
  at,
  provider = null,
  model = null,
  speakerName = null,
  maxEntries = 8
}) {
  if (!session) return null;
  const normalizedText = normalizeVoiceText(text, STREAM_WATCH_NOTE_LINE_MAX_CHARS);
  if (!normalizedText) return null;
  const normalizedAt = Number.isFinite(Number(at)) ? Math.max(0, Math.round(Number(at))) : Date.now();
  const boundedMax = clamp(Number(maxEntries) || 8, 1, 24);
  const current = getStreamWatchNoteEntries(session, boundedMax);
  const last = current[current.length - 1] || null;
  const normalizedProvider = String(provider || "").trim() || null;
  const normalizedModel = String(model || "").trim() || null;
  const normalizedSpeakerName = String(speakerName || "").trim() || null;
  let nextEntries = current;

  const formatPendingCompactionNote = (entry) => {
    const noteText = normalizeVoiceText(entry?.text || "", STREAM_WATCH_NOTE_LINE_MAX_CHARS);
    if (!noteText) return "";
    const noteSpeaker = String(entry?.speakerName || "").trim();
    return noteSpeaker ? `${noteSpeaker}: ${noteText}` : noteText;
  };

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
    const evictedEntries = current.length >= boundedMax ? current.slice(0, current.length - boundedMax + 1) : [];
    if (evictedEntries.length > 0) {
      session.pendingCompactionNotes = [
        ...(Array.isArray(session.pendingCompactionNotes) ? session.pendingCompactionNotes : []),
        ...evictedEntries.map((entry) => formatPendingCompactionNote(entry)).filter(Boolean)
      ].slice(-24);
    }
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
  session.streamWatch.noteEntries = nextEntries;
  session.streamWatch.lastNoteAt = normalizedAt;
  session.streamWatch.lastNoteProvider = normalizedProvider;
  session.streamWatch.lastNoteModel = normalizedModel;
  return nextEntries[nextEntries.length - 1] || null;
}

function isStreamWatchPlaybackBusy(session) {
  if (!session || session.ending) return false;
  if (session.botTurnOpen) return true;
  const streamBuffered = Math.max(0, Number(session.botAudioStream?.writableLength || 0));
  return streamBuffered > 0;
}

function hasPendingDeferredVoiceTurns(manager: StreamWatchManager, session) {
  if (!session || session.ending) return false;
  const deferredTurns = manager.deferredActionQueue?.getDeferredQueuedUserTurns?.(session);
  return Array.isArray(deferredTurns) && deferredTurns.length > 0;
}

function hasActiveVoiceGeneration(manager: StreamWatchManager, session) {
  if (!session || session.ending) return false;
  if (session.inFlightAcceptedBrainTurn && typeof session.inFlightAcceptedBrainTurn === "object") {
    return true;
  }
  try {
    return Boolean(manager.activeReplies?.has?.(buildVoiceReplyScopeKey(session.id)));
  } catch {
    return false;
  }
}

function hasQueuedVoiceWork(manager: StreamWatchManager, session) {
  if (!session || session.ending) return false;
  if (hasActiveVoiceGeneration(manager, session)) return true;
  if (Number(session.pendingFileAsrTurns || 0) > 0) return true;
  if (session.realtimeTurnDrainActive) return true;
  if (Array.isArray(session.pendingRealtimeTurns) && session.pendingRealtimeTurns.length > 0) return true;
  if (hasPendingDeferredVoiceTurns(manager, session)) return true;
  const outputChannelState = manager.getOutputChannelState?.(session);
  return Boolean(outputChannelState?.locked);
}

async function sendStreamWatchOfflineMessage(manager: StreamWatchManager, { message, settings, guildId, requesterId }) {
  await sendOperationalMessage(manager, {
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

async function resolveStreamWatchRequestContext(manager: StreamWatchManager, { message, settings }) {
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

export async function requestWatchStream(manager: StreamWatchManager, { message, settings, targetUserId = null }) {
  const context = await resolveStreamWatchRequestContext(manager, { message, settings });
  if (!context) return false;
  if (context.handled) return true;
  const { guildId, session, requesterId } = context;

  if (String(message.member?.voice?.channelId || "") !== String(session.voiceChannelId || "")) {
    await sendOperationalMessage(manager, {
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
    await sendOperationalMessage(manager, {
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
    await sendOperationalMessage(manager, {
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

  await sendOperationalMessage(manager, {
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

export function initializeStreamWatchState(manager: StreamWatchManager, { session, requesterUserId, targetUserId = null }) {
  if (!session) return;
  clearStreamWatchNoteTimer(session);
  const noteLoop = getStreamWatchNoteLoopState(session);
  noteLoop.running = false;
  noteLoop.lastChangeCaptureAt = 0;
  session.streamWatch = session.streamWatch || {};
  clearNativeDiscordScreenShareState(session);
  session.streamWatch.active = true;
  session.streamWatch.targetUserId = String(targetUserId || requesterUserId || "").trim() || null;
  session.streamWatch.requestedByUserId = String(requesterUserId || "").trim() || null;
  session.streamWatch.lastFrameAt = 0;
  session.streamWatch.lastCommentaryAt = 0;
  session.streamWatch.lastCommentaryNote = null;
  session.streamWatch.lastMemoryRecapAt = 0;
  session.streamWatch.lastMemoryRecapText = null;
  session.streamWatch.lastMemoryRecapDurableSaved = false;
  session.streamWatch.lastMemoryRecapReason = null;
  session.streamWatch.lastNoteAt = 0;
  session.streamWatch.lastNoteProvider = null;
  session.streamWatch.lastNoteModel = null;
  session.streamWatch.noteEntries = [];
  session.streamWatch.ingestedFrameCount = 0;
  session.streamWatch.acceptedFrameCountInWindow = 0;
  session.streamWatch.frameWindowStartedAt = 0;
  session.streamWatch.latestFrameMimeType = null;
  session.streamWatch.latestFrameDataBase64 = "";
  session.streamWatch.latestFrameAt = 0;
  session.streamWatch.latestChangeScore = 0;
  session.streamWatch.latestEmaChangeScore = 0;
  session.streamWatch.latestIsSceneCut = false;
}

export function getStreamWatchNotesForPrompt(session, settings = null) {
  if (!session || session.ending) return null;
  const streamWatch = session.streamWatch || {};
  const noteSettings = resolveStreamWatchNoteSettings(settings);
  const entries = getStreamWatchNoteEntries(session, noteSettings.maxEntries);
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
    .slice(-noteSettings.maxEntries);
  if (!notes.length) return null;

  const last = entries[entries.length - 1] || null;
  return {
    prompt: noteSettings.prompt,
    notes,
    lastAt: Number(last?.at || 0) || null,
    provider: last?.provider || streamWatch.lastNoteProvider || null,
    model: last?.model || streamWatch.lastNoteModel || null,
    active: Boolean(streamWatch.active)
  };
}

export function supportsStreamWatchCommentary(manager: StreamWatchManager, session, settings = null) {
  if (!session || session.ending) return false;
  if (!isRealtimeMode(session.mode)) return false;
  return supportsDirectVisionCommentary(manager, settings || session.settingsSnapshot || manager.store.getSettings());
}

export function supportsStreamWatchNotes(manager: StreamWatchManager, { session = null, settings = null } = {}) {
  if (!session || session.ending) return false;
  if (!manager.llm || typeof manager.llm.generate !== "function") return false;
  return Boolean(resolveStreamWatchNoteModelSettings(manager, settings));
}

export function resolveStreamWatchNoteModelSettings(manager: StreamWatchManager, settings = null) {
  const llmSettings = getResolvedOrchestratorBinding(settings);
  const noteSettings = resolveStreamWatchNoteSettings(settings);
  const provider = noteSettings.provider;
  const model = noteSettings.model;

  if (!provider || !model) return null;
  if (!manager.llm?.isProviderConfigured?.(provider)) return null;

  return {
    ...llmSettings,
    provider,
    model,
    temperature: 0.3,
    maxOutputTokens: STREAM_WATCH_NOTE_MAX_OUTPUT_TOKENS
  };
}

const DIRECT_VISION_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "claude-oauth",
  "openai-oauth",
  "codex-cli",
  "codex_cli_session",
  "xai"
]);

function supportsDirectVisionCommentary(manager: StreamWatchManager, settings = null) {
  if (!manager.llm || typeof manager.llm.generate !== "function") return false;
  const commentarySettings = resolveStreamWatchCommentarySettings(settings);
  const resolvedSettings =
    commentarySettings.provider && commentarySettings.model
      ? withStreamWatchCommentaryBinding(settings, {
          provider: commentarySettings.provider,
          model: commentarySettings.model
        })
      : settings;
  const voiceBinding = getResolvedVoiceGenerationBinding(resolvedSettings);
  return DIRECT_VISION_PROVIDERS.has(voiceBinding.provider);
}

function withStreamWatchCommentaryBinding(
  settings: Record<string, unknown> | null,
  binding: { provider: string; model: string }
) {
  return deepMerge(settings || {}, {
    agentStack: {
      runtimeConfig: {
        voice: {
          generation: {
            mode: "dedicated_model",
            model: {
              provider: binding.provider,
              model: binding.model
            }
          }
        }
      }
    }
  });
}

async function generateStreamWatchNote(manager: StreamWatchManager, {
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

  const providerSettings = resolveStreamWatchNoteModelSettings(manager, settings);
  if (!providerSettings) return null;
  const speakerName = manager.resolveVoiceSpeakerName(session, streamerUserId) || "the streamer";
  const noteSettings = resolveStreamWatchNoteSettings(settings);
  const previousEntries = getStreamWatchNoteEntries(session, noteSettings.maxEntries);
  const now = Date.now();
  const formattedHistory = previousEntries
    .map((entry) => {
      const ageSec = entry.at ? Math.round((now - entry.at) / 1000) : 0;
      const ageLabel = ageSec > 0 ? ` (${ageSec}s ago)` : "";
      return `- ${entry.text}${ageLabel}`;
    })
    .join("\n");
  const systemPrompt = [
    `You are ${getPromptBotName(settings)} preparing private stream-watch notes for your own reference.`,
    "You are looking at one still frame from a live stream.",
    "Never claim you cannot see the stream.",
    "Return strict JSON only.",
    "The note must be one short factual private note, max 16 words.",
    "Use your observation history to notice what changed or stayed important.",
    "Do not write dialogue or commands."
  ].join(" ");
  const recentTranscript = getRecentTranscriptSnippet(session);
  const userPromptParts = [
    `Frame from ${speakerName}'s stream.`,
    formattedHistory
      ? `Your previous observations:\n${formattedHistory}`
      : "Previous observations: none (this is the first frame)."
  ];
  if (recentTranscript) {
    userPromptParts.push(`Recent conversation: ${recentTranscript}`);
  }
  userPromptParts.push(
    String(noteSettings.prompt || DEFAULT_STREAM_WATCH_NOTE_PROMPT),
    "Focus only on what is visible now. Mention uncertainty briefly if needed."
  );
  const userPrompt = userPromptParts.join(" ");

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
      source: "voice_stream_watch_note"
    },
    jsonSchema: STREAM_WATCH_NOTE_JSON_SCHEMA
  });

  const rawText = String(generated?.text || "").trim();
  const parsed = safeJsonParseFromString(rawText, null);
  const parsedNote = parsed && typeof parsed === "object" ? parsed.note : "";
  const oneLine = String(parsedNote || rawText).split(/\r?\n/)[0] || "";
  const text = normalizeVoiceText(oneLine, STREAM_WATCH_NOTE_LINE_MAX_CHARS);
  if (!text) return null;
  return {
    text,
    provider: generated?.provider || providerSettings.provider || null,
    model: generated?.model || providerSettings.model || null
  };
}

function getStreamWatchChangeState(session: StreamWatchSession, settings = null) {
  const noteSettings = resolveStreamWatchNoteSettings(settings);
  const latestChangeScore = Number(session.streamWatch?.latestChangeScore || 0);
  const latestEmaChangeScore = Number(session.streamWatch?.latestEmaChangeScore || 0);
  const isSceneCut = Boolean(session.streamWatch?.latestIsSceneCut);
  const significantChange =
    isSceneCut ||
    latestChangeScore >= noteSettings.changeThreshold ||
    latestEmaChangeScore >= noteSettings.changeThreshold;
  const staticMotion =
    !isSceneCut &&
    latestChangeScore < noteSettings.staticFloor &&
    latestEmaChangeScore < noteSettings.staticFloor;
  return {
    latestChangeScore,
    latestEmaChangeScore,
    isSceneCut,
    significantChange,
    staticMotion
  };
}

function getScheduledStreamWatchNoteReason(session: StreamWatchSession, settings = null) {
  const changeState = getStreamWatchChangeState(session, settings);
  return changeState.staticMotion ? "idle_interval" : "interval";
}

function scheduleStreamWatchNoteRun(
  manager: StreamWatchManager,
  {
    session,
    settings,
    source = "stream_watch_note_loop"
  }: {
    session: StreamWatchSession;
    settings: Record<string, unknown> | null;
    source?: string;
  }
) {
  if (!session || session.ending || !session.streamWatch?.active) {
    clearStreamWatchNoteTimer(session);
    return;
  }
  if (!supportsStreamWatchNotes(manager, { session, settings })) {
    clearStreamWatchNoteTimer(session);
    return;
  }
  if (!String(session.streamWatch?.latestFrameDataBase64 || "").trim()) return;

  const loopState = getStreamWatchNoteLoopState(session);
  if (loopState.running) return;

  const noteSettings = resolveStreamWatchNoteSettings(settings);
  const changeState = getStreamWatchChangeState(session, settings);
  const delayMs = (changeState.staticMotion ? noteSettings.idleIntervalSeconds : noteSettings.intervalSeconds) * 1000;
  const nextRunAt = Date.now() + delayMs;
  if (loopState.timer && loopState.nextRunAt > 0 && loopState.nextRunAt <= nextRunAt) return;

  clearStreamWatchNoteTimer(session);
  loopState.nextRunAt = nextRunAt;
  loopState.timer = setTimeout(() => {
    const resolvedSettings = (session.settingsSnapshot || manager.store.getSettings()) as Record<string, unknown> | null;
    void captureStreamWatchNote(manager, {
      session,
      settings: resolvedSettings,
      streamerUserId: String(session.streamWatch?.targetUserId || "").trim() || null,
      source,
      reason: getScheduledStreamWatchNoteReason(session, resolvedSettings)
    });
  }, delayMs);
}

async function captureStreamWatchNote(
  manager: StreamWatchManager,
  {
    session,
    settings,
    streamerUserId = null,
    source = "api_stream_ingest",
    reason = "interval"
  }: {
    session: StreamWatchSession;
    settings: Record<string, unknown> | null;
    streamerUserId?: string | null;
    source?: string;
    reason?: string;
  }
) {
  if (!session || session.ending || !session.streamWatch?.active) return null;
  if (!supportsStreamWatchNotes(manager, { session, settings })) return null;
  const bufferedFrame = String(session.streamWatch?.latestFrameDataBase64 || "").trim();
  if (!bufferedFrame) return null;

  const loopState = getStreamWatchNoteLoopState(session);
  if (loopState.running) return null;
  loopState.running = true;
  clearStreamWatchNoteTimer(session);

  try {
    const noteSettings = resolveStreamWatchNoteSettings(settings);
    const generated = await generateStreamWatchNote(manager, {
      session,
      settings,
      streamerUserId,
      frameMimeType: session.streamWatch?.latestFrameMimeType || "image/jpeg",
      frameDataBase64: bufferedFrame
    });
    const note = normalizeVoiceText(generated?.text || "", STREAM_WATCH_NOTE_LINE_MAX_CHARS);
    if (!note) return null;

    const speakerName = manager.resolveVoiceSpeakerName(session, streamerUserId) || null;
    const stored = appendStreamWatchNoteEntry({
      session,
      text: note,
      at: Date.now(),
      provider: generated?.provider || null,
      model: generated?.model || null,
      speakerName,
      maxEntries: noteSettings.maxEntries
    });
    if (!stored) return null;

    if (reason === "change_detected" || reason === "share_start") {
      loopState.lastChangeCaptureAt = Date.now();
    }

    manager.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: manager.client.user?.id || null,
      content: "stream_watch_note_updated",
      metadata: {
        sessionId: session.id,
        source: String(source || "api_stream_ingest"),
        reason,
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
  } catch (error) {
    manager.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: manager.client.user?.id || null,
      content: `stream_watch_note_failed: ${String((error as Error)?.message || error)}`,
      metadata: {
        sessionId: session.id,
        source: String(source || "api_stream_ingest"),
        reason
      }
    });
    return null;
  } finally {
    loopState.running = false;
    const resolvedSettings = (session.settingsSnapshot || settings || manager.store.getSettings()) as Record<string, unknown> | null;
    scheduleStreamWatchNoteRun(manager, {
      session,
      settings: resolvedSettings,
      source
    });
  }
}

function maybeCaptureStreamWatchNote(
  manager: StreamWatchManager,
  {
    session,
    settings,
    streamerUserId = null,
    source = "api_stream_ingest"
  }: {
    session: StreamWatchSession;
    settings: Record<string, unknown> | null;
    streamerUserId?: string | null;
    source?: string;
  }
) {
  if (!session || session.ending || !session.streamWatch?.active) return;
  if (!supportsStreamWatchNotes(manager, { session, settings })) return;

  const loopState = getStreamWatchNoteLoopState(session);
  if (loopState.running) return;

  const noteSettings = resolveStreamWatchNoteSettings(settings);
  const changeState = getStreamWatchChangeState(session, settings);
  const firstFrame = Number(session.streamWatch?.ingestedFrameCount || 0) <= 1;
  const changeCooldownElapsed =
    Date.now() - Number(loopState.lastChangeCaptureAt || 0) >= noteSettings.changeMinIntervalSeconds * 1000;
  const shouldCaptureNow = firstFrame || (changeState.significantChange && changeCooldownElapsed);

  if (shouldCaptureNow) {
    void captureStreamWatchNote(manager, {
      session,
      settings,
      streamerUserId,
      source,
      reason: firstFrame ? "share_start" : "change_detected"
    });
    return;
  }

  scheduleStreamWatchNoteRun(manager, {
    session,
    settings,
    source
  });
}

async function generateStreamWatchMemoryRecap(manager: StreamWatchManager, {
  session,
  settings,
  reason = "watching_stopped"
}) {
  const notesText = buildStreamWatchNotesText(session, 6);
  if (!notesText) return null;
  const speakerName = manager.resolveVoiceSpeakerName(session, session.streamWatch?.targetUserId) || "the streamer";
  const systemPrompt = [
    `You are ${getPromptBotName(settings)} summarizing an ended screen-watch session for memory.`,
    "You will receive recent observations captured during one screen-watch session.",
    "Return strict JSON only.",
    "recap must be one concise grounded sentence, max 22 words.",
    "shouldStore should be true if the recap is useful future continuity for this conversation or likely relevant later.",
    "Avoid filler, speculation, and talk about the bot."
  ].join(" ");
  const userPromptParts = [
    `Speaker: ${speakerName}`,
    `Stop reason: ${String(reason || "watching_stopped")}`
  ];
  if (notesText) {
    userPromptParts.push("Recent screen observations:");
    userPromptParts.push(notesText);
  }
  const userPrompt = userPromptParts.join("\n");

  try {
    const generated = await manager.llm.generate({
      settings,
      systemPrompt,
      userPrompt,
      trace: {
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: manager.client.user?.id || null,
        source: "voice_stream_watch_memory_recap"
      },
      jsonSchema: STREAM_WATCH_MEMORY_RECAP_JSON_SCHEMA
    });
    const parsed = safeJsonParseFromString(String(generated?.text || ""), null);
    const recap = normalizeVoiceText(parsed?.recap || "", 190);
    if (!recap) return null;
    return {
      recap,
      shouldStore: parsed?.shouldStore !== undefined ? Boolean(parsed.shouldStore) : true
    };
  } catch {
    const latestNote = getLatestStreamWatchNoteEntry(session)?.text || "";
    const recap = normalizeVoiceText(
      `${speakerName} recently screen-shared ${latestNote || "their current screen context"}.`,
      190
    );
    return recap
      ? {
          recap,
          shouldStore: true
        }
      : null;
  }
}

async function persistStreamWatchRecapToMemory(manager: StreamWatchManager, {
  session,
  settings,
  reason = "watching_stopped"
}) {
  if (!session || session.ending) return null;
  if (!settings?.memory?.enabled) return null;
  if (!manager.memory || typeof manager.memory !== "object") return null;
  if (typeof manager.memory.ingestMessage !== "function") return null;

  const recap = await generateStreamWatchMemoryRecap(manager, {
    session,
    settings,
    reason
  });
  if (!recap?.recap) return null;

  const messageId = `voice-screen-share-recap-${session.id}-${Date.now()}`;
  const authorId = String(manager.client.user?.id || "bot");
  const authorName = String(getBotName(settings) || manager.client.user?.username || "bot");
  const logContent = normalizeVoiceText(`Screen share recap: ${recap.recap}`, 320);
  if (logContent) {
    await manager.memory.ingestMessage({
      messageId,
      authorId,
      authorName,
      content: logContent,
      isBot: true,
      settings,
      trace: {
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: authorId,
        source: "voice_stream_watch_memory_recap"
      }
    });
  }

  let durableSaved = false;
  if (recap.shouldStore && typeof manager.memory.rememberDirectiveLineDetailed === "function") {
    const saved = await manager.memory.rememberDirectiveLineDetailed({
      line: recap.recap,
      sourceMessageId: messageId,
      userId: authorId,
      guildId: session.guildId,
      channelId: session.textChannelId,
      sourceText: recap.recap,
      scope: "lore",
      validationMode: "strict"
    });
    durableSaved = Boolean(saved?.ok);
  }

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: authorId,
    content: "stream_watch_memory_recap_saved",
    metadata: {
      sessionId: session.id,
      reason: String(reason || "watching_stopped"),
      recap: recap.recap,
      durableSaved
    }
  });

  session.streamWatch.lastMemoryRecapAt = Date.now();
  session.streamWatch.lastMemoryRecapText = recap.recap;
  session.streamWatch.lastMemoryRecapDurableSaved = durableSaved;
  session.streamWatch.lastMemoryRecapReason = String(reason || "watching_stopped");

  return {
    recap: recap.recap,
    durableSaved
  };
}

async function finalizeStreamWatchState(manager: StreamWatchManager, {
  session,
  settings,
  reason = "watching_stopped",
  preserveNotes = true,
  persistMemory = true
}) {
  if (!session || session.ending) {
    return {
      ok: false,
      reason: "session_not_found"
    };
  }
  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();
  const memoryRecap = persistMemory
    ? await persistStreamWatchRecapToMemory(manager, {
        session,
        settings: resolvedSettings,
        reason
      })
    : null;
  const previousTargetUserId = String(session.streamWatch?.targetUserId || "").trim() || null;

  unsubscribeNativeDiscordVideo(manager, session, previousTargetUserId, reason);
  disconnectNativeDiscordStreamTransport(manager, session, reason);
  clearStreamWatchNoteTimer(session);
  getStreamWatchNoteLoopState(session).running = false;

  session.streamWatch.active = false;
  session.streamWatch.targetUserId = null;
  session.streamWatch.requestedByUserId = null;
  session.streamWatch.latestFrameMimeType = null;
  session.streamWatch.latestFrameDataBase64 = "";
  session.streamWatch.latestFrameAt = 0;
  session.streamWatch.latestChangeScore = 0;
  session.streamWatch.latestEmaChangeScore = 0;
  session.streamWatch.latestIsSceneCut = false;

  if (!preserveNotes) {
    session.streamWatch.lastNoteAt = 0;
    session.streamWatch.lastNoteProvider = null;
    session.streamWatch.lastNoteModel = null;
    session.streamWatch.noteEntries = [];
  }

  return {
    ok: true,
    reason: "watching_stopped",
    memoryRecap
  };
}

export function isUserInSessionVoiceChannel(manager: StreamWatchManager, { session, userId }) {
  const normalizedUserId = String(userId || "").trim();
  if (!session || !normalizedUserId) return false;
  const guild = manager.client.guilds.cache.get(String(session.guildId || "")) || null;
  const voiceChannel = guild?.channels?.cache?.get(String(session.voiceChannelId || "")) || null;
  return Boolean(voiceChannel?.members?.has?.(normalizedUserId));
}

export function isStreamWatchFrameReady(session) {
  const nativeScreenShare = ensureNativeDiscordScreenShareState(session);
  if (Number(nativeScreenShare.lastDecodeSuccessAt || 0) > 0) {
    return true;
  }
  const latestFrameMimeType = String(session?.streamWatch?.latestFrameMimeType || "").trim().toLowerCase();
  const latestFrameDataBase64 = String(session?.streamWatch?.latestFrameDataBase64 || "").trim();
  return latestFrameMimeType.startsWith("image/") && latestFrameDataBase64.length > 0;
}

function canReuseActiveStreamWatch(session, targetUserId: string) {
  if (!session?.streamWatch?.active) return false;
  const activeTargetUserId = String(session.streamWatch?.targetUserId || "").trim();
  if (!activeTargetUserId || activeTargetUserId !== targetUserId) return false;

  const nativeScreenShare = ensureNativeDiscordScreenShareState(session);
  const transportStatus = String(nativeScreenShare.transportStatus || "").trim().toLowerCase();
  if (["waiting_for_credentials", "connect_requested", "connecting", "ready"].includes(transportStatus)) {
    return true;
  }

  if (isStreamWatchFrameReady(session)) {
    return true;
  }

  return listActiveNativeDiscordScreenSharers(session).some((entry) => entry.userId === targetUserId);
}

function getStreamWatchReadinessResult(session, targetUserId: string) {
  const frameReady = isStreamWatchFrameReady(session);
  return {
    ok: true,
    reused: true,
    frameReady,
    reason: frameReady ? "frame_context_ready" : "waiting_for_frame_context",
    targetUserId: String(session?.streamWatch?.targetUserId || targetUserId).trim() || targetUserId
  };
}

export async function enableWatchStreamForUser(manager: StreamWatchManager, {
  guildId,
  requesterUserId,
  targetUserId = null,
  settings = null,
  source = "screen_share_link"
}): Promise<EnableWatchStreamResult> {
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
  if (canReuseActiveStreamWatch(session, resolvedTarget)) {
    subscribeNativeDiscordVideo(manager, session, resolvedSettings, resolvedTarget, source);
    const reusedResult = getStreamWatchReadinessResult(session, resolvedTarget);
    manager.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: normalizedRequesterId,
      content: "stream_watch_reused_programmatic",
      metadata: {
        sessionId: session.id,
        source: String(source || "screen_share_link"),
        targetUserId: reusedResult.targetUserId,
        frameReady: reusedResult.frameReady,
        streamKey: ensureNativeDiscordScreenShareState(session).activeStreamKey || null,
        transportStatus: ensureNativeDiscordScreenShareState(session).transportStatus || null
      }
    });
    return reusedResult;
  }
  if (
    session.streamWatch?.active &&
    String(session.streamWatch.targetUserId || "").trim() &&
    String(session.streamWatch.targetUserId || "").trim() !== resolvedTarget
  ) {
    await finalizeStreamWatchState(manager, {
      session,
      settings: resolvedSettings,
      reason: "stream_watch_retargeted",
      preserveNotes: true,
      persistMemory: true
    });
  }

  initializeStreamWatchState(manager, {
    session,
    requesterUserId: normalizedRequesterId,
    targetUserId: resolvedTarget
  });

  // ── Try Go Live (screen share) first ─────────────────────────
  const nativeTransportRequest = requestNativeDiscordStreamWatch(manager, session, {
    targetUserId: resolvedTarget,
    source
  });

  // ── Webcam fallback ──────────────────────────────────────────
  // If Go Live discovery fails (no stream key — user isn't Go
  // Live streaming), check if the target has a webcam ("video")
  // stream on the main voice connection.  Webcam video uses the
  // same voice transport, so we just subscribe — no separate RTC
  // connection needed.
  let isWebcamPath = false;
  if (!nativeTransportRequest.ok) {
    const nativeState = ensureNativeDiscordScreenShareState(session);
    const sharer = nativeState.sharers.get(resolvedTarget);
    if (sharer && sharerHasWebcamOnly(sharer)) {
      isWebcamPath = true;
      updateNativeDiscordStreamTransportState(session, {
        transportStatus: "ready",
        transportReason: "webcam_on_voice_transport"
      });
      manager.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: resolvedTarget,
        content: "screen_watch_started_native",
        metadata: {
          sessionId: session.id,
          source: String(source || "webcam"),
          targetUserId: resolvedTarget,
          transport: "voice_webcam",
          streamType: "video"
        }
      });
    } else {
      return {
        ok: false,
        reason: nativeTransportRequest.reason,
        fallback: nativeTransportRequest.fallback
      };
    }
  }

  if (!isWebcamPath) {
    if (nativeTransportRequest.stream && streamHasCredentials(nativeTransportRequest.stream)) {
      const connectResult = connectNativeDiscordStreamTransport(manager, session, nativeTransportRequest.stream, {
        source
      });
      if (!connectResult.ok) {
        return {
          ok: false,
          reason: connectResult.reason,
          fallback: "screen_share_link"
        };
      }
    } else {
      updateNativeDiscordStreamTransportState(session, {
        transportStatus: "waiting_for_credentials",
        transportReason: null
      });
    }
  }

  // Subscribe to the target user's video.  For webcam, use null
  // preferredStreamType so the soft-preference sort picks the
  // webcam stream.  For Go Live, use the configured default
  // ("screen").
  if (isWebcamPath) {
    const subscription = resolveNativeDiscordVideoSubscriptionSettings(resolvedSettings);
    try {
      session.voxClient.subscribeUserVideo({
        userId: resolvedTarget,
        maxFramesPerSecond: subscription.maxFramesPerSecond,
        preferredQuality: subscription.preferredQuality,
        preferredPixelCount: subscription.preferredPixelCount,
        preferredStreamType: null,  // accept any stream type (webcam)
        jpegQuality: subscription.jpegQuality
      });
      const nativeState = ensureNativeDiscordScreenShareState(session);
      nativeState.subscribedTargetUserId = resolvedTarget;
    } catch (error) {
      manager.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: resolvedTarget,
        content: `webcam_video_subscribe_failed: ${String((error as Error)?.message || error)}`,
        metadata: { sessionId: session.id, targetUserId: resolvedTarget }
      });
    }
  } else {
    subscribeNativeDiscordVideo(manager, session, resolvedSettings, resolvedTarget, source);
  }

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: normalizedRequesterId,
    content: isWebcamPath
      ? "stream_watch_enabled_webcam"
      : "stream_watch_enabled_programmatic",
    metadata: {
      sessionId: session.id,
      source: String(source || "screen_share_link"),
      targetUserId: resolvedTarget,
      streamKey: ensureNativeDiscordScreenShareState(session).activeStreamKey || null,
      transportStatus: ensureNativeDiscordScreenShareState(session).transportStatus || null,
      isWebcam: isWebcamPath
    }
  });

  const frameReady = isStreamWatchFrameReady(session);
  return {
    ok: true,
    reused: false,
    frameReady,
    reason: frameReady ? "frame_context_ready" : "waiting_for_frame_context",
    targetUserId: String(session.streamWatch?.targetUserId || resolvedTarget).trim() || resolvedTarget
  };
}

export async function requestStopWatchingStream(manager: StreamWatchManager, { message, settings }) {
  const context = await resolveStreamWatchRequestContext(manager, { message, settings });
  if (!context) return false;
  if (context.handled) return true;
  const { guildId, session, requesterId } = context;

  if (!session.streamWatch?.active) {
    await sendOperationalMessage(manager, {
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

  const stopResult = await finalizeStreamWatchState(manager, {
    session,
    settings,
    reason: "watching_stopped",
    preserveNotes: true,
    persistMemory: true
  });

  await sendOperationalMessage(manager, {
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
  return Boolean(stopResult?.ok);
}

export async function stopWatchStreamForUser(manager: StreamWatchManager, {
  guildId,
  requesterUserId = null,
  targetUserId = null,
  settings = null,
  reason = "screen_share_session_stopped"
}) {
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) {
    return {
      ok: false,
      reason: "guild_id_required"
    };
  }

  const session = manager.sessions.get(normalizedGuildId);
  if (!session || session.ending) {
    return {
      ok: false,
      reason: "session_not_found"
    };
  }
  if (!session.streamWatch?.active) {
    return {
      ok: false,
      reason: "already_stopped"
    };
  }

  const normalizedRequesterId = String(requesterUserId || "").trim();
  const normalizedTargetUserId = String(targetUserId || "").trim();
  if (
    normalizedRequesterId &&
    session.streamWatch?.requestedByUserId &&
    String(session.streamWatch.requestedByUserId) !== normalizedRequesterId
  ) {
    return {
      ok: false,
      reason: "requester_mismatch"
    };
  }
  if (
    normalizedTargetUserId &&
    session.streamWatch?.targetUserId &&
    String(session.streamWatch.targetUserId) !== normalizedTargetUserId
  ) {
    return {
      ok: false,
      reason: "target_user_mismatch"
    };
  }

  return await finalizeStreamWatchState(manager, {
    session,
    settings,
    reason,
    preserveNotes: true,
    persistMemory: true
  });
}

export function handleDiscoveredStreamCredentialsReceived(
  manager: StreamWatchManager,
  {
    stream
  }: {
    stream: GoLiveStream;
  }
) {
  const normalizedGuildId = String(stream?.guildId || "").trim();
  const normalizedUserId = String(stream?.userId || "").trim();
  if (!normalizedGuildId || !normalizedUserId) return false;

  const session = manager.sessions.get(normalizedGuildId);
  if (!session || session.ending || !session.streamWatch?.active) return false;
  if (String(session.streamWatch.targetUserId || "").trim() !== normalizedUserId) return false;

  connectNativeDiscordStreamTransport(manager, session, stream, {
    source: "stream_credentials_received"
  });
  return true;
}

export async function handleDiscoveredStreamDeleted(
  manager: StreamWatchManager,
  {
    stream,
    settings = null
  }: {
    stream: GoLiveStream;
    settings?: Record<string, unknown> | null;
  }
) {
  const normalizedGuildId = String(stream?.guildId || "").trim();
  const normalizedUserId = String(stream?.userId || "").trim();
  if (!normalizedGuildId || !normalizedUserId) return false;

  const session = manager.sessions.get(normalizedGuildId);
  if (!session || session.ending || !session.streamWatch?.active) return false;
  if (String(session.streamWatch.targetUserId || "").trim() !== normalizedUserId) return false;

  removeNativeDiscordVideoSharer(session, normalizedUserId);
  updateNativeDiscordStreamTransportState(session, {
    activeStreamKey: stream.streamKey,
    transportStatus: "stream_deleted",
    transportReason: null
  });

  await stopWatchStreamForUser(manager, {
    guildId: normalizedGuildId,
    targetUserId: normalizedUserId,
    settings,
    reason: "native_discord_stream_deleted"
  });
  return true;
}

export async function requestStreamWatchStatus(manager: StreamWatchManager, { message, settings }) {
  const context = await resolveStreamWatchRequestContext(manager, { message, settings });
  if (!context) return false;
  if (context.handled) return true;
  const { guildId, session, requesterId } = context;

  const streamWatch = session.streamWatch || {};
  const nativeScreenShare = ensureNativeDiscordScreenShareState(session);
  const lastFrameAgoSec = Number(streamWatch.lastFrameAt || 0)
    ? Math.max(0, Math.floor((Date.now() - Number(streamWatch.lastFrameAt || 0)) / 1000))
    : null;
  const lastCommentaryAgoSec = Number(streamWatch.lastCommentaryAt || 0)
    ? Math.max(0, Math.floor((Date.now() - Number(streamWatch.lastCommentaryAt || 0)) / 1000))
    : null;
  const lastNoteAgoSec = Number(streamWatch.lastNoteAt || 0)
    ? Math.max(0, Math.floor((Date.now() - Number(streamWatch.lastNoteAt || 0)) / 1000))
    : null;

  await sendOperationalMessage(manager, {
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
      lastNoteAgoSec,
      ingestedFrameCount: Number(streamWatch.ingestedFrameCount || 0),
      activeStreamKey: nativeScreenShare.activeStreamKey || null,
      transportStatus: nativeScreenShare.transportStatus || null,
      transportReason: nativeScreenShare.transportReason || null
    }
  });
  return true;
}

export async function ingestStreamFrame(manager: StreamWatchManager, {
  guildId,
  streamerUserId = null,
  mimeType = "image/jpeg",
  dataBase64 = "",
  source = "api_stream_ingest",
  settings = null,
  changeScore = undefined as number | undefined,
  emaChangeScore = undefined as number | undefined,
  isSceneCut = undefined as boolean | undefined
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
  // Frame-diff scores from clankvox (coarse luma diff + EMA smoothing).
  streamWatch.latestChangeScore = typeof changeScore === "number" ? changeScore : 0;
  streamWatch.latestEmaChangeScore = typeof emaChangeScore === "number" ? emaChangeScore : 0;
  streamWatch.latestIsSceneCut = typeof isSceneCut === "boolean" ? isSceneCut : false;

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

  maybeCaptureStreamWatchNote(manager, {
    session,
    settings: resolvedSettings,
    streamerUserId: normalizedStreamerId,
    source
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

export async function maybeTriggerStreamWatchCommentary(manager: StreamWatchManager, {
  session,
  settings,
  streamerUserId = null,
  source = "api_stream_ingest"
}) {
  if (!session || session.ending) return;
  if (!supportsStreamWatchCommentary(manager, session, settings)) return;
  if (!session.streamWatch?.active) return;
  const baseSettings = (settings || session.settingsSnapshot || manager.store.getSettings()) as Record<string, unknown> | null;
  const commentarySettings = resolveStreamWatchCommentarySettings(baseSettings);
  if (!commentarySettings.enabled) return;
  if (typeof manager.runRealtimeBrainReply !== "function") return;

  if (session.pendingResponse) return;
  if (isStreamWatchPlaybackBusy(session)) return;
  if (hasQueuedVoiceWork(manager, session)) return;

  const quietWindowMs = STREAM_WATCH_AUDIO_QUIET_WINDOW_MS;
  const now = Date.now();
  const sinceLastInboundAudio = now - Number(session.lastInboundAudioAt || 0);
  if (Number(session.lastInboundAudioAt || 0) > 0 && sinceLastInboundAudio < quietWindowMs) return;

  const sinceLastCommentary = now - Number(session.streamWatch.lastCommentaryAt || 0);
  const firstFrameTriggered = Number(session.streamWatch.ingestedFrameCount || 0) <= 1;
  const intervalTriggered = sinceLastCommentary >= commentarySettings.intervalSeconds * 1000;
  const changeState = getStreamWatchChangeState(session, baseSettings);
  const changeTriggered =
    sinceLastCommentary >= commentarySettings.changeMinIntervalSeconds * 1000 &&
    changeState.significantChange;
  if (!firstFrameTriggered && !intervalTriggered && !changeTriggered) return;

  const bufferedFrame = String(session.streamWatch?.latestFrameDataBase64 || "").trim();
  if (!bufferedFrame) return;

  const frozenFrameSnapshot = {
    mimeType: String(session.streamWatch?.latestFrameMimeType || "image/jpeg"),
    dataBase64: bufferedFrame
  };
  const speakerName = manager.resolveVoiceSpeakerName(session, streamerUserId) || "the streamer";
  const latestNoteEntries = Array.isArray(session.streamWatch?.noteEntries) ? session.streamWatch.noteEntries : [];
  const latestNote = normalizeVoiceText(
    latestNoteEntries[latestNoteEntries.length - 1]?.text || "",
    STREAM_WATCH_NOTE_LINE_MAX_CHARS
  );
  const triggerReason = firstFrameTriggered
    ? "share_start"
    : changeTriggered && !intervalTriggered
      ? "change_detected"
      : "interval";
  const normalizedStreamerUserId = String(streamerUserId || "").trim() || null;
  const botUserId = String(manager.client.user?.id || "").trim() || null;
  const transcript =
    triggerReason === "share_start"
      ? `[${speakerName} started screen sharing. You can see the latest frame.]`
      : triggerReason === "change_detected"
        ? `[${speakerName} is screen sharing. Something notable just happened on screen.]`
        : `[A fresh frame from ${speakerName}'s screen share is available.]`;
  const resolvedCommentarySettings =
    commentarySettings.provider && commentarySettings.model
      ? withStreamWatchCommentaryBinding(baseSettings, {
          provider: commentarySettings.provider,
          model: commentarySettings.model
        })
      : baseSettings;

  session.streamWatch.lastCommentaryAt = now;
  session.streamWatch.lastCommentaryNote = latestNote || null;

  void manager.runRealtimeBrainReply({
    session,
    settings: resolvedCommentarySettings,
    userId: session.streamWatch.targetUserId || streamerUserId || manager.client.user?.id || null,
    transcript,
    inputKind: "event",
    directAddressed: false,
    source: `stream_watch_brain_turn:${triggerReason}`,
    frozenFrameSnapshot,
    runtimeEventContext: {
      category: "screen_share",
      eventType: triggerReason,
      actorUserId: normalizedStreamerUserId,
      actorDisplayName: speakerName,
      actorRole:
        normalizedStreamerUserId && botUserId && normalizedStreamerUserId === botUserId
          ? "self"
          : normalizedStreamerUserId
            ? "other"
            : "unknown",
      hasVisibleFrame: true
    }
  }).catch((error: unknown) => {
    manager.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: manager.client.user?.id || null,
      content: `stream_watch_commentary_request_failed: ${String((error as Error)?.message || error)}`,
      metadata: {
        sessionId: session.id,
        source: String(source || "api_stream_ingest"),
        triggerReason
      }
    });
  });

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
      commentaryMode: "brain_turn",
      triggerReason,
      changeScore: changeState.latestChangeScore,
      emaChangeScore: changeState.latestEmaChangeScore,
      isSceneCut: changeState.isSceneCut,
      changeTriggered,
      commentaryProvider: commentarySettings.provider || null,
      commentaryModel: commentarySettings.model || null,
      latestNote: latestNote || null
    }
  });
}
