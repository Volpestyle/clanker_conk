import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  getVoiceConnection,
  VoiceConnectionStatus
} from "@discordjs/voice";
import { PermissionFlagsBits } from "discord.js";
import prism from "prism-media";
import {
  buildVoiceToneGuardrails,
  buildHardLimitsSection,
  getPromptBotName,
  getPromptCapabilityHonestyLine,
  getPromptImpossibleActionLine,
  getPromptMemoryDisabledLine,
  getPromptMemoryEnabledLine,
  getPromptStyle,
  getPromptVoiceGuidance
} from "../promptCore.ts";
import { estimateUsdCost } from "../pricing.ts";
import { clamp } from "../utils.ts";
import { isLikelyBotNameVariantAddress } from "../addressingNameVariants.ts";
import { convertDiscordPcmToXaiInput, convertXaiOutputToDiscordPcm } from "./pcmAudio.ts";
import { SoundboardDirector } from "./soundboardDirector.ts";
import {
  defaultVoiceReplyDecisionModel,
  isLikelyWakeWordPing,
  isLowSignalVoiceFragment,
  normalizeVoiceReplyDecisionProvider,
  parseVoiceDecisionContract,
  shouldUseLlmForLowSignalTurn,
  resolveRealtimeTurnTranscriptionPlan
} from "./voiceDecisionRuntime.ts";
import {
  enableWatchStreamForUser,
  generateVisionFallbackStreamWatchCommentary,
  ingestStreamFrame,
  initializeStreamWatchState,
  isUserInSessionVoiceChannel,
  maybeTriggerStreamWatchCommentary,
  requestStopWatchingStream,
  requestStreamWatchStatus,
  requestWatchStream,
  resolveStreamWatchVisionProviderSettings,
  supportsStreamWatchCommentary,
  supportsVisionFallbackStreamWatchCommentary
} from "./voiceStreamWatch.ts";
import {
  resolveOperationalChannel,
  sendOperationalMessage,
  sendToChannel
} from "./voiceOperationalMessaging.ts";
import {
  REALTIME_MEMORY_FACT_LIMIT,
  SOUNDBOARD_MAX_CANDIDATES,
  dedupeSoundboardCandidates,
  encodePcm16MonoAsWav,
  ensureBotAudioPlaybackReady,
  extractSoundboardDirective,
  findMentionedSoundboardReference,
  getRealtimeCommitMinimumBytes,
  formatRealtimeMemoryFacts,
  formatSoundboardCandidateLine,
  getRealtimeRuntimeLabel,
  isLikelyVocativeAddressToOtherParticipant,
  isRecoverableRealtimeError,
  isRealtimeMode,
  isVoiceTurnAddressedToBot,
  matchSoundboardReference,
  normalizeVoiceText,
  parsePreferredSoundboardReferences,
  parseRealtimeErrorPayload,
  parseResponseDoneId,
  parseResponseDoneModel,
  parseResponseDoneStatus,
  parseResponseDoneUsage,
  resolveRealtimeProvider,
  shortError,
  shouldAllowVoiceNsfwHumor,
  transcriptSourceFromEventType
} from "./voiceSessionHelpers.ts";
import { requestJoin } from "./voiceJoinFlow.ts";
import {
  ACTIVITY_TOUCH_THROTTLE_MS,
  AUDIO_PLAYBACK_QUEUE_WARN_BYTES,
  AUDIO_PLAYBACK_QUEUE_WARN_COOLDOWN_MS,
  BOT_DISCONNECT_GRACE_MS,
  BOT_TURN_DEFERRED_COALESCE_MAX,
  BOT_TURN_DEFERRED_FLUSH_DELAY_MS,
  BOT_TURN_DEFERRED_QUEUE_MAX,
  BOT_TURN_SILENCE_RESET_MS,
  CAPTURE_IDLE_FLUSH_MS,
  CAPTURE_MAX_DURATION_MS,
  DISCORD_PCM_FRAME_BYTES,
  DISCORD_PCM_FRAME_MS,
  FOCUSED_SPEAKER_CONTINUATION_MS,
  INPUT_SPEECH_END_SILENCE_MS,
  MAX_INACTIVITY_SECONDS,
  MAX_MAX_SESSION_MINUTES,
  MAX_RESPONSE_SILENCE_RETRIES,
  MIN_INACTIVITY_SECONDS,
  MIN_MAX_SESSION_MINUTES,
  MIN_RESPONSE_REQUEST_GAP_MS,
  OPENAI_ACTIVE_RESPONSE_RETRY_MS,
  PENDING_SUPERSEDE_MIN_AGE_MS,
  JOIN_GREETING_LLM_WINDOW_MS,
  REALTIME_CONTEXT_MEMBER_LIMIT,
  REALTIME_CONTEXT_TRANSCRIPT_MAX_CHARS,
  REALTIME_INSTRUCTION_REFRESH_DEBOUNCE_MS,
  REALTIME_TURN_COALESCE_MAX_BYTES,
  REALTIME_TURN_COALESCE_WINDOW_MS,
  REALTIME_TURN_QUEUE_MAX,
  REALTIME_TURN_STALE_SKIP_MS,
  RESPONSE_DONE_SILENCE_GRACE_MS,
  RESPONSE_FLUSH_DEBOUNCE_MS,
  RESPONSE_SILENCE_RETRY_DELAY_MS,
  SOUNDBOARD_CATALOG_REFRESH_MS,
  SOUNDBOARD_DECISION_TRANSCRIPT_MAX_CHARS,
  SPEAKING_END_ADAPTIVE_BUSY_BACKLOG,
  SPEAKING_END_ADAPTIVE_BUSY_CAPTURE_COUNT,
  SPEAKING_END_ADAPTIVE_BUSY_SCALE,
  SPEAKING_END_ADAPTIVE_HEAVY_BACKLOG,
  SPEAKING_END_ADAPTIVE_HEAVY_CAPTURE_COUNT,
  SPEAKING_END_ADAPTIVE_HEAVY_SCALE,
  SPEAKING_END_FINALIZE_MICRO_MS,
  SPEAKING_END_FINALIZE_MIN_MS,
  SPEAKING_END_FINALIZE_QUICK_MS,
  SPEAKING_END_FINALIZE_SHORT_MS,
  SPEAKING_END_MICRO_CAPTURE_MS,
  SPEAKING_END_SHORT_CAPTURE_MS,
  STT_CONTEXT_MAX_MESSAGES,
  STT_REPLY_MAX_CHARS,
  STT_TRANSCRIPT_MAX_CHARS,
  STT_TTS_CONVERSION_CHUNK_MS,
  STT_TTS_CONVERSION_YIELD_EVERY_CHUNKS,
  VOICE_DECIDER_HISTORY_MAX_CHARS,
  VOICE_DECIDER_HISTORY_MAX_TURNS,
  VOICE_LOOKUP_BUSY_LOG_COOLDOWN_MS,
  VOICE_LOOKUP_BUSY_MAX_CHARS,
  VOICE_TURN_ADDRESSING_TRANSCRIPT_MAX_CHARS
} from "./voiceSessionManager.constants.ts";

export class VoiceSessionManager {
  client;
  store;
  appConfig;
  llm;
  memory;
  composeOperationalMessage;
  generateVoiceTurn;
  sessions;
  pendingSessionGuildIds;
  joinLocks;
  soundboardDirector;
  onVoiceStateUpdate;

  constructor({
    client,
    store,
    appConfig,
    llm = null,
    memory = null,
    composeOperationalMessage = null,
    generateVoiceTurn = null
  }) {
    this.client = client;
    this.store = store;
    this.appConfig = appConfig;
    this.llm = llm || null;
    this.memory = memory || null;
    this.composeOperationalMessage =
      typeof composeOperationalMessage === "function" ? composeOperationalMessage : null;
    this.generateVoiceTurn = typeof generateVoiceTurn === "function" ? generateVoiceTurn : null;
    this.sessions = new Map();
    this.pendingSessionGuildIds = new Set();
    this.joinLocks = new Map();
    this.soundboardDirector = new SoundboardDirector({
      client,
      store,
      appConfig
    });
    this.onVoiceStateUpdate = (oldState, newState) => {
      this.handleVoiceStateUpdate(oldState, newState).catch((error) => {
        this.store.logAction({
          kind: "voice_error",
          guildId: newState?.guild?.id || oldState?.guild?.id || null,
          channelId: newState?.channelId || oldState?.channelId || null,
          userId: this.client.user?.id || null,
          content: `voice_state_update: ${String(error?.message || error)}`
        });
      });
    };

    this.client.on("voiceStateUpdate", this.onVoiceStateUpdate);
  }

  getSession(guildId) {
    const id = String(guildId || "");
    if (!id) return null;
    return this.sessions.get(id) || null;
  }

  hasActiveSession(guildId) {
    return Boolean(this.getSession(guildId));
  }

  getRuntimeState() {
    const sessions = [...this.sessions.values()].map((session) => ({
      sessionId: session.id,
      guildId: session.guildId,
      voiceChannelId: session.voiceChannelId,
      textChannelId: session.textChannelId,
      startedAt: new Date(session.startedAt).toISOString(),
      lastActivityAt: new Date(session.lastActivityAt).toISOString(),
      maxEndsAt: session.maxEndsAt ? new Date(session.maxEndsAt).toISOString() : null,
      inactivityEndsAt: session.inactivityEndsAt ? new Date(session.inactivityEndsAt).toISOString() : null,
      activeInputStreams: session.userCaptures.size,
      soundboard: {
        playCount: session.soundboard?.playCount || 0,
        lastPlayedAt: session.soundboard?.lastPlayedAt
          ? new Date(session.soundboard.lastPlayedAt).toISOString()
          : null
      },
      mode: session.mode || "voice_agent",
      streamWatch: {
        active: Boolean(session.streamWatch?.active),
        targetUserId: session.streamWatch?.targetUserId || null,
        requestedByUserId: session.streamWatch?.requestedByUserId || null,
        lastFrameAt: session.streamWatch?.lastFrameAt
          ? new Date(session.streamWatch.lastFrameAt).toISOString()
          : null,
        lastCommentaryAt: session.streamWatch?.lastCommentaryAt
          ? new Date(session.streamWatch.lastCommentaryAt).toISOString()
          : null,
        ingestedFrameCount: Number(session.streamWatch?.ingestedFrameCount || 0)
      },
      stt: session.mode === "stt_pipeline"
        ? {
            pendingTurns: Number(session.pendingSttTurns || 0),
            contextMessages: Array.isArray(session.sttContextMessages)
              ? session.sttContextMessages.length
              : 0
          }
        : null,
      realtime: isRealtimeMode(session.mode)
        ? {
            provider: session.realtimeProvider || resolveRealtimeProvider(session.mode),
            inputSampleRateHz: Number(session.realtimeInputSampleRateHz) || 24000,
            outputSampleRateHz: Number(session.realtimeOutputSampleRateHz) || 24000,
            recentVoiceTurns: Array.isArray(session.recentVoiceTurns) ? session.recentVoiceTurns.length : 0,
            pendingTurns:
              (session.realtimeTurnDrainActive ? 1 : 0) +
              (Array.isArray(session.pendingRealtimeTurns) ? session.pendingRealtimeTurns.length : 0),
            state: session.realtimeClient?.getState?.() || null
          }
        : null
    }));

    return {
      activeCount: sessions.length,
      sessions
    };
  }

  async requestJoin({ message, settings, intentConfidence = null }) {
    return await requestJoin(this, { message, settings, intentConfidence });
  }

  async requestLeave({ message, settings, reason = "nl_leave" }) {
    if (!message?.guild || !message?.channel) return false;

    const guildId = String(message.guild.id);
    if (!this.sessions.has(guildId)) {
      await this.sendOperationalMessage({
        channel: message.channel,
        settings,
        guildId,
        channelId: message.channelId,
        userId: message.author?.id || null,
        messageId: message.id,
        event: "voice_leave_request",
        reason: "not_in_voice",
        details: {}
      });
      return true;
    }

    await this.endSession({
      guildId,
      reason,
      requestedByUserId: message.author?.id || null,
      announceChannel: message.channel,
      announcement: "aight i'm leaving vc.",
      settings,
      messageId: message.id
    });

    return true;
  }

  async requestStatus({ message, settings }) {
    if (!message?.guild || !message?.channel) return false;

    const guildId = String(message.guild.id);
    const session = this.sessions.get(guildId);

    if (!session) {
      await this.sendOperationalMessage({
        channel: message.channel,
        settings,
        guildId,
        channelId: message.channelId,
        userId: message.author?.id || null,
        messageId: message.id,
        event: "voice_status_request",
        reason: "offline",
        details: {}
      });
      return true;
    }

    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - session.startedAt) / 1000));
    const remainingSeconds = session.maxEndsAt
      ? Math.max(0, Math.ceil((session.maxEndsAt - Date.now()) / 1000))
      : null;
    const inactivitySeconds = session.inactivityEndsAt
      ? Math.max(0, Math.ceil((session.inactivityEndsAt - Date.now()) / 1000))
      : null;

    await this.sendOperationalMessage({
      channel: message.channel,
      settings: settings || session.settingsSnapshot,
      guildId,
      channelId: message.channelId,
      userId: message.author?.id || null,
      messageId: message.id,
      event: "voice_status_request",
      reason: "online",
      details: {
        voiceChannelId: session.voiceChannelId,
        elapsedSeconds,
        remainingSeconds: remainingSeconds ?? null,
        inactivitySeconds: inactivitySeconds ?? null,
        activeCaptures: session.userCaptures.size,
        streamWatchActive: Boolean(session.streamWatch?.active),
        streamWatchTargetUserId: session.streamWatch?.targetUserId || null
      }
    });

    return true;
  }

  async requestWatchStream({ message, settings, targetUserId = null }) {
    return await requestWatchStream(this, { message, settings, targetUserId });
  }

  initializeStreamWatchState({ session, requesterUserId, targetUserId = null }) {
    return initializeStreamWatchState(this, { session, requesterUserId, targetUserId });
  }

  supportsStreamWatchCommentary(session, settings = null) {
    return supportsStreamWatchCommentary(this, session, settings);
  }

  supportsVisionFallbackStreamWatchCommentary({ session = null, settings = null } = {}) {
    return supportsVisionFallbackStreamWatchCommentary(this, { session, settings });
  }

  resolveStreamWatchVisionProviderSettings(settings = null) {
    return resolveStreamWatchVisionProviderSettings(this, settings);
  }

  async generateVisionFallbackStreamWatchCommentary({
    session,
    settings,
    streamerUserId = null,
    frameMimeType = "image/jpeg",
    frameDataBase64 = ""
  }) {
    return await generateVisionFallbackStreamWatchCommentary(this, {
      session,
      settings,
      streamerUserId,
      frameMimeType,
      frameDataBase64
    });
  }

  isUserInSessionVoiceChannel({ session, userId }) {
    return isUserInSessionVoiceChannel(this, { session, userId });
  }

  async enableWatchStreamForUser({
    guildId,
    requesterUserId,
    targetUserId = null,
    settings = null,
    source = "screen_share_link"
  }) {
    return await enableWatchStreamForUser(this, {
      guildId,
      requesterUserId,
      targetUserId,
      settings,
      source
    });
  }

  async requestStopWatchingStream({ message, settings }) {
    return await requestStopWatchingStream(this, { message, settings });
  }

  async requestStreamWatchStatus({ message, settings }) {
    return await requestStreamWatchStatus(this, { message, settings });
  }

  async ingestStreamFrame({
    guildId,
    streamerUserId = null,
    mimeType = "image/jpeg",
    dataBase64 = "",
    source = "api_stream_ingest",
    settings = null
  }) {
    return await ingestStreamFrame(this, {
      guildId,
      streamerUserId,
      mimeType,
      dataBase64,
      source,
      settings
    });
  }

  async maybeTriggerStreamWatchCommentary({
    session,
    settings,
    streamerUserId = null,
    source = "api_stream_ingest"
  }) {
    return await maybeTriggerStreamWatchCommentary(this, {
      session,
      settings,
      streamerUserId,
      source
    });
  }

  async maybeTriggerAssistantDirectedSoundboard({
    session,
    settings,
    userId = null,
    transcript = "",
    requestedRef = "",
    source = "voice_transcript"
  }) {
    if (!session || session.ending) return;

    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    if (!resolvedSettings?.voice?.soundboard?.enabled) return;
    const normalizedRef = String(requestedRef || "").trim().slice(0, 180);
    if (!normalizedRef) return;

    const normalizedTranscript = normalizeVoiceText(transcript, SOUNDBOARD_DECISION_TRANSCRIPT_MAX_CHARS);
    session.soundboard = session.soundboard || {
      playCount: 0,
      lastPlayedAt: 0,
      catalogCandidates: [],
      catalogFetchedAt: 0,
      lastDirectiveKey: "",
      lastDirectiveAt: 0
    };

    const directiveKey = [
      String(source || "voice_transcript").trim().toLowerCase(),
      normalizedRef.toLowerCase(),
      String(normalizedTranscript || "").trim().toLowerCase()
    ].join("|");
    const now = Date.now();
    if (
      directiveKey &&
      directiveKey === String(session.soundboard.lastDirectiveKey || "") &&
      now - Number(session.soundboard.lastDirectiveAt || 0) < 6_000
    ) {
      return;
    }
    session.soundboard.lastDirectiveKey = directiveKey;
    session.soundboard.lastDirectiveAt = now;

    const candidateInfo = await this.resolveSoundboardCandidates({
      session,
      settings: resolvedSettings
    });
    const candidates = Array.isArray(candidateInfo?.candidates) ? candidateInfo.candidates : [];
    const candidateSource = String(candidateInfo?.source || "none");
    const byReference = matchSoundboardReference(candidates, normalizedRef);
    const byMention = byReference ? null : findMentionedSoundboardReference(candidates, normalizedRef);
    const byName =
      byReference || byMention
        ? null
        : candidates.find((entry) => String(entry?.name || "").trim().toLowerCase() === normalizedRef.toLowerCase()) ||
          candidates.find((entry) =>
            String(entry?.name || "")
              .trim()
              .toLowerCase()
              .includes(normalizedRef.toLowerCase())
          );
    const matched = byReference || byMention || byName || null;

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: userId || this.client.user?.id || null,
      content: "voice_soundboard_directive_decision",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        source: String(source || "voice_transcript"),
        transcript: normalizedTranscript || null,
        requestedRef: normalizedRef,
        candidateCount: candidates.length,
        candidateSource,
        matchedReference: matched?.reference || null
      }
    });

    if (!matched) return;

    const result = await this.soundboardDirector.play({
      session,
      settings: resolvedSettings,
      soundId: matched.soundId,
      sourceGuildId: matched.sourceGuildId,
      reason: `assistant_directive_${String(source || "voice_transcript").slice(0, 50)}`
    });

    this.store.logAction({
      kind: result.ok ? "voice_runtime" : "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: userId || this.client.user?.id || null,
      content: result.ok ? "voice_soundboard_directive_played" : "voice_soundboard_directive_failed",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        source: String(source || "voice_transcript"),
        transcript: normalizedTranscript || null,
        requestedRef: normalizedRef,
        soundId: matched.soundId,
        sourceGuildId: matched.sourceGuildId,
        reason: result.reason || null,
        error: result.ok ? null : shortError(result.message || "")
      }
    });
  }

  async resolveSoundboardCandidates({ session = null, settings, guild = null }) {
    const preferred = parsePreferredSoundboardReferences(settings?.voice?.soundboard?.preferredSoundIds);
    if (preferred.length) {
      return {
        source: "preferred",
        candidates: preferred.slice(0, SOUNDBOARD_MAX_CANDIDATES)
      };
    }

    const guildCandidates = await this.fetchGuildSoundboardCandidates({
      session,
      guild
    });
    if (guildCandidates.length) {
      return {
        source: "guild_catalog",
        candidates: guildCandidates.slice(0, SOUNDBOARD_MAX_CANDIDATES)
      };
    }

    return {
      source: "none",
      candidates: []
    };
  }

  async fetchGuildSoundboardCandidates({ session = null, guild = null }) {
    if (session && session.ending) return [];
    const now = Date.now();

    let cached = [];
    if (session) {
      session.soundboard = session.soundboard || {
        playCount: 0,
        lastPlayedAt: 0,
        catalogCandidates: [],
        catalogFetchedAt: 0,
        lastDirectiveKey: "",
        lastDirectiveAt: 0
      };
      cached = Array.isArray(session.soundboard.catalogCandidates)
        ? session.soundboard.catalogCandidates.filter(Boolean)
        : [];
      const lastFetchedAt = Number(session.soundboard.catalogFetchedAt || 0);
      if (lastFetchedAt > 0 && now - lastFetchedAt < SOUNDBOARD_CATALOG_REFRESH_MS) {
        return cached;
      }
    }

    const resolvedGuild = guild || this.client.guilds.cache.get(String(session?.guildId || ""));
    if (!resolvedGuild?.soundboardSounds?.fetch) {
      return cached || [];
    }

    try {
      const fetched = await resolvedGuild.soundboardSounds.fetch();
      const candidates = [];
      fetched.forEach((sound) => {
        if (!sound || sound.available === false) return;
        const soundId = String(sound.soundId || "").trim();
        if (!soundId) return;
        const name = String(sound.name || "").trim();
        candidates.push({
          soundId,
          sourceGuildId: null,
          reference: soundId,
          name: name || null,
          origin: "guild_catalog"
        });
      });

      const deduped = dedupeSoundboardCandidates(candidates).slice(0, SOUNDBOARD_MAX_CANDIDATES);
      if (session?.soundboard) {
        session.soundboard.catalogCandidates = deduped;
        session.soundboard.catalogFetchedAt = now;
      }
      return deduped;
    } catch (error) {
      if (session) {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          content: `voice_soundboard_catalog_fetch_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id
          }
        });
        session.soundboard.catalogFetchedAt = now;
      }
      return cached || [];
    }
  }

  async stopAll(reason = "shutdown") {
    const guildIds = [...this.sessions.keys()];
    for (const guildId of guildIds) {
      await this.endSession({ guildId, reason, announcement: null });
    }
  }

  async dispose(reason = "shutdown") {
    if (this.onVoiceStateUpdate) {
      this.client.off("voiceStateUpdate", this.onVoiceStateUpdate);
      this.onVoiceStateUpdate = null;
    }

    await this.stopAll(reason);
    this.pendingSessionGuildIds.clear();
    this.joinLocks.clear();
  }

  async withJoinLock(guildId, fn) {
    const key = String(guildId || "");
    if (!key) return await fn();

    const previous = this.joinLocks.get(key) || Promise.resolve();
    let release = null;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.joinLocks.set(key, current);

    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      if (typeof release === "function") {
        release();
      }
      if (this.joinLocks.get(key) === current) {
        this.joinLocks.delete(key);
      }
    }
  }

  async reconcileSettings(settings) {
    const voiceEnabled = Boolean(settings?.voice?.enabled);
    const allowlist = new Set(settings?.voice?.allowedVoiceChannelIds || []);
    const blocklist = new Set(settings?.voice?.blockedVoiceChannelIds || []);

    for (const session of [...this.sessions.values()]) {
      session.settingsSnapshot = settings || session.settingsSnapshot;

      if (!voiceEnabled) {
        await this.endSession({
          guildId: session.guildId,
          reason: "settings_disabled",
          announcement: "voice mode was disabled, leaving vc.",
          settings
        });
        continue;
      }

      if (blocklist.has(session.voiceChannelId)) {
        await this.endSession({
          guildId: session.guildId,
          reason: "settings_channel_blocked",
          announcement: "this vc is now blocked for me, leaving.",
          settings
        });
        continue;
      }

      if (allowlist.size > 0 && !allowlist.has(session.voiceChannelId)) {
        await this.endSession({
          guildId: session.guildId,
          reason: "settings_channel_not_allowlisted",
          announcement: "this vc is no longer allowlisted, leaving.",
          settings
        });
        continue;
      }

      this.touchActivity(session.guildId, settings);
    }
  }

  startSessionTimers(session, settings) {
    const maxSessionMinutes = clamp(
      Number(settings.voice?.maxSessionMinutes) || 10,
      MIN_MAX_SESSION_MINUTES,
      MAX_MAX_SESSION_MINUTES
    );
    const maxDurationMs = maxSessionMinutes * 60_000;

    session.maxEndsAt = Date.now() + maxDurationMs;
    session.maxTimer = setTimeout(() => {
      this.endSession({
        guildId: session.guildId,
        reason: "max_duration",
        announcement: `max session time (${maxSessionMinutes}m) reached, leaving vc.`,
        settings
      }).catch(() => undefined);
    }, maxDurationMs);

    this.touchActivity(session.guildId, settings);
  }

  touchActivity(guildId, settings) {
    const session = this.sessions.get(String(guildId));
    if (!session) return;

    const inactivitySeconds = clamp(
      Number(settings?.voice?.inactivityLeaveSeconds) || 90,
      MIN_INACTIVITY_SECONDS,
      MAX_INACTIVITY_SECONDS
    );

    session.lastActivityAt = Date.now();
    if (session.inactivityTimer) clearTimeout(session.inactivityTimer);

    session.inactivityEndsAt = Date.now() + inactivitySeconds * 1000;
    session.inactivityTimer = setTimeout(() => {
      this.endSession({
        guildId: session.guildId,
        reason: "inactivity_timeout",
        announcement: `no one talked for ${inactivitySeconds}s, leaving vc.`,
        settings
      }).catch(() => undefined);
    }, inactivitySeconds * 1000);
  }

  bindAudioPlayerHandlers(session) {
    const onStateChange = (oldState, newState) => {
      if (oldState.status !== AudioPlayerStatus.Playing && newState.status === AudioPlayerStatus.Playing) {
        session.lastActivityAt = Date.now();
      }
    };

    session.audioPlayer.on("stateChange", onStateChange);
    session.cleanupHandlers.push(() => {
      session.audioPlayer.off("stateChange", onStateChange);
    });
  }

  bindRealtimeHandlers(session, settings = session.settingsSnapshot) {
    if (!session?.realtimeClient) return;
    const runtimeLabel = getRealtimeRuntimeLabel(session.mode);
    const onAudioDelta = (audioBase64) => {
      let chunk = null;
      try {
        chunk = Buffer.from(String(audioBase64 || ""), "base64");
      } catch {
        return;
      }
      if (!chunk || !chunk.length) return;

      const discordPcm = convertXaiOutputToDiscordPcm(
        chunk,
        Number(session.realtimeOutputSampleRateHz) || 24000
      );
      if (!discordPcm.length) return;

      if (
        !ensureBotAudioPlaybackReady({
          session,
          store: this.store,
          botUserId: this.client.user?.id || null
        })
      ) {
        return;
      }

      session.lastAudioDeltaAt = Date.now();
      if (
        !this.enqueueDiscordPcmForPlayback({
          session,
          discordPcm
        })
      ) {
        return;
      }
      this.markBotTurnOut(session, settings);
      if (session.mode === "openai_realtime") {
        session.pendingRealtimeInputBytes = 0;
      }

      if (this.pendingResponseHasAudio(session)) {
        const pending = session.pendingResponse;
        if (pending) {
          pending.audioReceivedAt = session.lastAudioDeltaAt;
        }
        this.clearResponseSilenceTimers(session);
      }
    };

    const onTranscript = (payload) => {
      const transcriptText =
        payload && typeof payload === "object" ? payload.text : payload;
      const transcriptEventType =
        payload && typeof payload === "object" ? String(payload.eventType || "") : "";
      const transcript = String(transcriptText || "").trim();
      if (!transcript) return;
      const transcriptSource = transcriptSourceFromEventType(transcriptEventType);
      const parsedDirective =
        transcriptSource === "output"
          ? extractSoundboardDirective(transcript)
          : {
              text: transcript,
              reference: null
            };
      const transcriptForLogs = String(parsedDirective?.text || transcript).trim();
      const requestedSoundboardRef = String(parsedDirective?.reference || "").trim();
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `${runtimeLabel}_transcript`,
        metadata: {
          sessionId: session.id,
          transcript: transcriptForLogs || transcript,
          transcriptEventType: transcriptEventType || null,
          transcriptSource,
          soundboardRef: requestedSoundboardRef || null
        }
      });

      if (session.mode === "openai_realtime" && transcriptSource === "output") {
        session.pendingRealtimeInputBytes = 0;
      }
      if (transcriptSource === "output" && transcriptForLogs) {
        this.recordVoiceTurn(session, {
          role: "assistant",
          userId: this.client.user?.id || null,
          text: transcriptForLogs
        });
      }

      if (transcriptSource === "output" && requestedSoundboardRef) {
        this.maybeTriggerAssistantDirectedSoundboard({
          session,
          settings: settings || session.settingsSnapshot || this.store.getSettings(),
          userId: this.client.user?.id || null,
          transcript: transcriptForLogs || transcript,
          requestedRef: requestedSoundboardRef,
          source: "realtime_output_transcript"
        }).catch(() => undefined);
      }
    };

    const onErrorEvent = (errorPayload) => {
      if (session.ending) return;
      const details = parseRealtimeErrorPayload(errorPayload);
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `${runtimeLabel}_error_event: ${details.message}`,
        metadata: {
          sessionId: session.id,
          code: details.code,
          param: details.param,
          lastOutboundEventType: details.lastOutboundEventType,
          lastOutboundEvent: details.lastOutboundEvent,
          recentOutboundEvents: details.recentOutboundEvents
        }
      });

      if (
        isRecoverableRealtimeError({
          mode: session.mode,
          code: details.code,
          message: details.message
        })
      ) {
        const normalizedCode = String(details.code || "")
          .trim()
          .toLowerCase();
        const isActiveResponseCollision =
          normalizedCode === "conversation_already_has_active_response" ||
          /active response in progress/i.test(String(details.message || ""));
        session.pendingRealtimeInputBytes = 0;
        const pending = session.pendingResponse;
        if (
          normalizedCode === "input_audio_buffer_commit_empty" &&
          pending &&
          !this.pendingResponseHasAudio(session, pending)
        ) {
          this.clearPendingResponse(session);
        } else if (isActiveResponseCollision && pending) {
          pending.handlingSilence = false;
          this.armResponseSilenceWatchdog({
            session,
            requestId: pending.requestId,
            userId: pending.userId
          });
        }
        return;
      }

      this.endSession({
        guildId: session.guildId,
        reason: "realtime_runtime_error",
        announcement: "voice runtime hit an error, leaving vc.",
        settings
      }).catch(() => undefined);
    };

    const onSocketClosed = (closeInfo) => {
      if (session.ending) return;
      const code = Number(closeInfo?.code || 0) || null;
      const reason = String(closeInfo?.reason || "").trim() || null;
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `${runtimeLabel}_socket_closed`,
        metadata: {
          sessionId: session.id,
          code,
          reason
        }
      });

      this.endSession({
        guildId: session.guildId,
        reason: "realtime_socket_closed",
        announcement: "lost realtime voice runtime, leaving vc.",
        settings
      }).catch(() => undefined);
    };

    const onSocketError = (socketError) => {
      if (session.ending) return;
      const message = String(socketError?.message || "unknown socket error");
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `${runtimeLabel}_socket_error: ${message}`,
        metadata: {
          sessionId: session.id
        }
      });
    };

    const onResponseDone = (event) => {
      if (session.ending) return;
      const pending = session.pendingResponse;
      const responseId = parseResponseDoneId(event);
      const responseStatus = parseResponseDoneStatus(event);
      const responseUsage = parseResponseDoneUsage(event);
      const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
      const resolvedResponseModel = session.mode === "openai_realtime"
        ? parseResponseDoneModel(event) ||
          String(session.realtimeClient?.sessionConfig?.model || "").trim() ||
          String(resolvedSettings?.voice?.openaiRealtime?.model || "gpt-realtime").trim() ||
          "gpt-realtime"
        : parseResponseDoneModel(event);
      const responseUsdCost =
        session.mode === "openai_realtime" && responseUsage
          ? estimateUsdCost({
              provider: "openai",
              model: resolvedResponseModel || "gpt-realtime",
              inputTokens: Number(responseUsage.inputTokens || 0),
              outputTokens: Number(responseUsage.outputTokens || 0),
              cacheReadTokens: Number(responseUsage.cacheReadTokens || 0),
              cacheWriteTokens: 0,
              customPricing: resolvedSettings?.llm?.pricing
            })
          : 0;
      const hadAudio = pending ? this.pendingResponseHasAudio(session, pending) : false;

      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `${runtimeLabel}_response_done`,
        usdCost: responseUsdCost,
        metadata: {
          sessionId: session.id,
          requestId: pending?.requestId || null,
          responseId,
          responseStatus,
          responseModel: resolvedResponseModel || null,
          responseUsage,
          hadAudio,
          retryCount: pending ? Number(pending.retryCount || 0) : null,
          hardRecoveryAttempted:
            pending && Object.hasOwn(pending, "hardRecoveryAttempted")
              ? Boolean(pending.hardRecoveryAttempted)
              : null
        }
      });

      if (!pending) return;

      if (hadAudio) {
        this.clearPendingResponse(session);
        return;
      }

      if (session.responseDoneGraceTimer) {
        clearTimeout(session.responseDoneGraceTimer);
      }

      const requestId = Number(pending.requestId || 0);
      const responseUserId = pending.userId || null;
      session.responseDoneGraceTimer = setTimeout(() => {
        session.responseDoneGraceTimer = null;
        if (!session || session.ending) return;
        const current = session.pendingResponse;
        if (!current || Number(current.requestId || 0) !== requestId) return;
        if (this.pendingResponseHasAudio(session, current)) {
          this.clearPendingResponse(session);
          return;
        }
        this.handleSilentResponse({
          session,
          userId: responseUserId,
          trigger: "response_done",
          responseId,
          responseStatus
        }).catch(() => undefined);
      }, RESPONSE_DONE_SILENCE_GRACE_MS);
    };

    session.realtimeClient.on("audio_delta", onAudioDelta);
    session.realtimeClient.on("transcript", onTranscript);
    session.realtimeClient.on("error_event", onErrorEvent);
    session.realtimeClient.on("socket_closed", onSocketClosed);
    session.realtimeClient.on("socket_error", onSocketError);
    session.realtimeClient.on("response_done", onResponseDone);

    session.cleanupHandlers.push(() => {
      session.realtimeClient.off("audio_delta", onAudioDelta);
      session.realtimeClient.off("transcript", onTranscript);
      session.realtimeClient.off("error_event", onErrorEvent);
      session.realtimeClient.off("socket_closed", onSocketClosed);
      session.realtimeClient.off("socket_error", onSocketError);
      session.realtimeClient.off("response_done", onResponseDone);
    });
  }

  ensureAudioPlaybackQueueState(session) {
    if (!session.audioPlaybackQueue || typeof session.audioPlaybackQueue !== "object") {
      session.audioPlaybackQueue = {
        chunks: [],
        headOffset: 0,
        queuedBytes: 0,
        pumping: false,
        timer: null,
        waitingDrain: false,
        drainHandler: null,
        lastWarnAt: 0
      };
    }
    return session.audioPlaybackQueue;
  }

  clearAudioPlaybackQueue(session) {
    if (!session) return;
    const state = this.ensureAudioPlaybackQueueState(session);
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.waitingDrain && state.drainHandler && typeof session.botAudioStream?.off === "function") {
      session.botAudioStream.off("drain", state.drainHandler);
    }
    state.waitingDrain = false;
    state.drainHandler = null;
    state.pumping = false;
    state.chunks = [];
    state.headOffset = 0;
    state.queuedBytes = 0;
    state.lastWarnAt = 0;
  }

  dequeueAudioPlaybackFrame(session, frameBytes = DISCORD_PCM_FRAME_BYTES) {
    const state = this.ensureAudioPlaybackQueueState(session);
    if (!Array.isArray(state.chunks) || !state.chunks.length) return Buffer.alloc(0);

    const boundedFrameBytes = Math.max(1, Math.floor(Number(frameBytes) || DISCORD_PCM_FRAME_BYTES));
    let remaining = boundedFrameBytes;
    const pieces = [];

    while (remaining > 0 && state.chunks.length) {
      const head = state.chunks[0];
      if (!Buffer.isBuffer(head) || !head.length) {
        state.chunks.shift();
        state.headOffset = 0;
        continue;
      }

      const available = head.length - state.headOffset;
      if (available <= 0) {
        state.chunks.shift();
        state.headOffset = 0;
        continue;
      }

      const takeBytes = Math.min(available, remaining);
      const start = state.headOffset;
      const end = start + takeBytes;
      pieces.push(head.subarray(start, end));
      state.headOffset = end;
      state.queuedBytes = Math.max(0, Number(state.queuedBytes || 0) - takeBytes);
      remaining -= takeBytes;

      if (state.headOffset >= head.length) {
        state.chunks.shift();
        state.headOffset = 0;
      }
    }

    if (!pieces.length) return Buffer.alloc(0);
    if (pieces.length === 1) return pieces[0];
    return Buffer.concat(pieces);
  }

  scheduleAudioPlaybackPump(session, delayMs = 0) {
    if (!session || session.ending) return;
    const state = this.ensureAudioPlaybackQueueState(session);
    if (state.timer || state.waitingDrain) return;

    const waitMs = Math.max(0, Math.floor(Number(delayMs) || 0));
    state.timer = setTimeout(() => {
      state.timer = null;
      this.pumpAudioPlaybackQueue(session);
    }, waitMs);
  }

  pumpAudioPlaybackQueue(session) {
    if (!session || session.ending) return;
    const state = this.ensureAudioPlaybackQueueState(session);
    if (state.pumping) return;
    if (!Array.isArray(state.chunks) || !state.chunks.length) return;

    state.pumping = true;
    try {
      if (
        !ensureBotAudioPlaybackReady({
          session,
          store: this.store,
          botUserId: this.client.user?.id || null
        })
      ) {
        this.scheduleAudioPlaybackPump(session, DISCORD_PCM_FRAME_MS);
        return;
      }

      const frame = this.dequeueAudioPlaybackFrame(session, DISCORD_PCM_FRAME_BYTES);
      if (!frame.length) return;

      try {
        const wrote = session.botAudioStream.write(frame);
        if (wrote === false && typeof session.botAudioStream?.once === "function") {
          if (!state.waitingDrain) {
            state.waitingDrain = true;
            const onDrain = () => {
              state.waitingDrain = false;
              state.drainHandler = null;
              if (!session.ending) {
                this.scheduleAudioPlaybackPump(session, 0);
              }
            };
            state.drainHandler = onDrain;
            session.botAudioStream.once("drain", onDrain);
          }
          return;
        }
      } catch (error) {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          content: `bot_audio_stream_write_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id
          }
        });
        this.clearAudioPlaybackQueue(session);
        return;
      }

      if (state.chunks.length) {
        this.scheduleAudioPlaybackPump(session, DISCORD_PCM_FRAME_MS);
      }
    } finally {
      state.pumping = false;
    }
  }

  enqueueDiscordPcmForPlayback({ session, discordPcm }) {
    if (!session || session.ending) return false;
    const pcm = Buffer.isBuffer(discordPcm) ? discordPcm : Buffer.from(discordPcm || []);
    if (!pcm.length) return false;

    if (
      !ensureBotAudioPlaybackReady({
        session,
        store: this.store,
        botUserId: this.client.user?.id || null
      })
    ) {
      return false;
    }

    const state = this.ensureAudioPlaybackQueueState(session);
    state.chunks.push(pcm);
    state.queuedBytes = Math.max(0, Number(state.queuedBytes || 0)) + pcm.length;
    const now = Date.now();
    if (
      state.queuedBytes >= AUDIO_PLAYBACK_QUEUE_WARN_BYTES &&
      now - Number(state.lastWarnAt || 0) >= AUDIO_PLAYBACK_QUEUE_WARN_COOLDOWN_MS
    ) {
      state.lastWarnAt = now;
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "bot_audio_queue_backlog",
        metadata: {
          sessionId: session.id,
          queuedBytes: state.queuedBytes
        }
      });
    }
    this.scheduleAudioPlaybackPump(session, 0);
    return true;
  }

  async enqueueChunkedTtsPcmForPlayback({
    session,
    ttsPcm,
    inputSampleRateHz = 24000
  }) {
    if (!session || session.ending) return false;
    const pcm = Buffer.isBuffer(ttsPcm) ? ttsPcm : Buffer.from(ttsPcm || []);
    if (!pcm.length) return false;

    const sampleRate = Math.max(8_000, Math.floor(Number(inputSampleRateHz) || 24_000));
    const chunkBytesRaw = Math.floor((sampleRate * 2 * STT_TTS_CONVERSION_CHUNK_MS) / 1000);
    const chunkBytes = Math.max(2, chunkBytesRaw - (chunkBytesRaw % 2));

    let queuedAny = false;
    let chunkCount = 0;
    for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
      if (session.ending) break;
      const chunk = pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length));
      const discordPcm = convertXaiOutputToDiscordPcm(chunk, sampleRate);
      if (discordPcm.length) {
        queuedAny = this.enqueueDiscordPcmForPlayback({
          session,
          discordPcm
        }) || queuedAny;
      }

      chunkCount += 1;
      if (chunkCount % STT_TTS_CONVERSION_YIELD_EVERY_CHUNKS === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    return queuedAny;
  }

  markBotTurnOut(session, settings = session.settingsSnapshot) {
    const now = Date.now();
    if (now - Number(session.lastBotActivityTouchAt || 0) >= ACTIVITY_TOUCH_THROTTLE_MS) {
      this.touchActivity(session.guildId, settings);
      session.lastBotActivityTouchAt = now;
    }

    if (!session.botTurnOpen) {
      session.botTurnOpen = true;
      this.store.logAction({
        kind: "voice_turn_out",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "bot_audio_started",
        metadata: {
          sessionId: session.id
        }
      });
    }

    if (session.botTurnResetTimer) {
      clearTimeout(session.botTurnResetTimer);
    }

    session.botTurnResetTimer = setTimeout(() => {
      session.botTurnOpen = false;
      session.botTurnResetTimer = null;
    }, BOT_TURN_SILENCE_RESET_MS);
  }

  getRealtimeTurnBacklogSize(session) {
    if (!session) return 0;
    const pendingQueueDepth = Array.isArray(session.pendingRealtimeTurns)
      ? session.pendingRealtimeTurns.length
      : 0;
    return Math.max(0, (session.realtimeTurnDrainActive ? 1 : 0) + pendingQueueDepth);
  }

  resolveSpeakingEndFinalizeDelayMs({ session, captureAgeMs }) {
    const normalizedCaptureAgeMs = Math.max(0, Number(captureAgeMs || 0));
    let baseDelayMs = SPEAKING_END_FINALIZE_QUICK_MS;
    if (normalizedCaptureAgeMs < SPEAKING_END_SHORT_CAPTURE_MS) {
      baseDelayMs =
        normalizedCaptureAgeMs < SPEAKING_END_MICRO_CAPTURE_MS
          ? SPEAKING_END_FINALIZE_MICRO_MS
          : SPEAKING_END_FINALIZE_SHORT_MS;
    }

    const activeCaptureCount = Number(session?.userCaptures?.size || 0);
    const realtimeTurnBacklog = this.getRealtimeTurnBacklogSize(session);
    const sttTurnBacklog = Number(session?.pendingSttTurns || 0);
    const turnBacklog = Math.max(0, realtimeTurnBacklog, sttTurnBacklog);

    if (
      activeCaptureCount >= SPEAKING_END_ADAPTIVE_HEAVY_CAPTURE_COUNT ||
      turnBacklog >= SPEAKING_END_ADAPTIVE_HEAVY_BACKLOG
    ) {
      return Math.max(
        SPEAKING_END_FINALIZE_MIN_MS,
        Math.round(baseDelayMs * SPEAKING_END_ADAPTIVE_HEAVY_SCALE)
      );
    }

    if (
      activeCaptureCount >= SPEAKING_END_ADAPTIVE_BUSY_CAPTURE_COUNT ||
      turnBacklog >= SPEAKING_END_ADAPTIVE_BUSY_BACKLOG
    ) {
      return Math.max(
        SPEAKING_END_FINALIZE_MIN_MS,
        Math.round(baseDelayMs * SPEAKING_END_ADAPTIVE_BUSY_SCALE)
      );
    }

    return baseDelayMs;
  }

  isInboundCaptureSuppressed(session) {
    if (!session || session.ending) return true;
    const activeLookupCount = Number(session.voiceLookupBusyCount || 0);
    return activeLookupCount > 0;
  }

  abortActiveInboundCaptures({ session, reason = "capture_suppressed" }) {
    if (!session || session.ending) return;
    const captures: Array<[
      string,
      {
        abort?: (reason?: string) => void;
        opusStream?: { destroy?: () => void };
        decoder?: { destroy?: () => void };
        pcmStream?: { destroy?: () => void };
      }
    ]> = [];
    if (session.userCaptures instanceof Map) {
      for (const [rawUserId, rawCapture] of session.userCaptures.entries()) {
        const normalizedCapture =
          rawCapture && typeof rawCapture === "object"
            ? { ...rawCapture }
            : {};
        captures.push([String(rawUserId || ""), normalizedCapture]);
      }
    }
    for (const [userId, capture] of captures) {
      if (capture && typeof capture.abort === "function") {
        capture.abort(reason);
        continue;
      }

      try {
        capture?.opusStream?.destroy?.();
      } catch {
        // ignore
      }
      try {
        capture?.decoder?.destroy?.();
      } catch {
        // ignore
      }
      try {
        capture?.pcmStream?.destroy?.();
      } catch {
        // ignore
      }
      session.userCaptures?.delete?.(String(userId || ""));
    }
  }

  beginVoiceWebLookupBusy({
    session,
    settings,
    userId = null,
    query = "",
    source = "voice_web_lookup"
  }) {
    if (!session || session.ending) {
      return () => undefined;
    }

    session.voiceLookupBusyCount = Number(session.voiceLookupBusyCount || 0) + 1;
    const busyCount = Number(session.voiceLookupBusyCount || 0);
    if (busyCount === 1) {
      this.abortActiveInboundCaptures({
        session,
        reason: "voice_web_lookup_busy"
      });
      this.announceVoiceWebLookupBusy({
        session,
        settings,
        userId,
        query,
        source
      }).catch(() => undefined);
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "voice_web_lookup_busy_start",
        metadata: {
          sessionId: session.id,
          mode: session.mode,
          source: String(source || "voice_web_lookup"),
          query: String(query || "").trim().slice(0, 220) || null
        }
      });
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const nextCount = Math.max(0, Number(session.voiceLookupBusyCount || 0) - 1);
      session.voiceLookupBusyCount = nextCount;
      if (nextCount > 0) return;
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "voice_web_lookup_busy_end",
        metadata: {
          sessionId: session.id,
          mode: session.mode,
          source: String(source || "voice_web_lookup")
        }
      });
    };
  }

  async announceVoiceWebLookupBusy({
    session,
    settings,
    userId = null,
    query = "",
    source = "voice_web_lookup"
  }) {
    if (!session || session.ending) return;
    const line = await this.generateVoiceLookupBusyLine({
      session,
      settings,
      userId,
      query
    });
    if (!line) return;

    if (isRealtimeMode(session.mode) && this.requestRealtimeTextUtterance({
      session,
      text: line,
      userId,
      source: `${String(source || "voice_web_lookup")}:busy_utterance`
    })) {
      return;
    }

    await this.speakVoiceLineWithTts({
      session,
      settings,
      text: line,
      source: `${String(source || "voice_web_lookup")}:busy_utterance`
    });
  }

  async generateVoiceLookupBusyLine({
    session,
    settings,
    userId = null,
    query = ""
  }) {
    if (!this.llm?.generate) return "";
    const normalizedQuery = normalizeVoiceText(query, 80);
    const tunedSettings = {
      ...settings,
      llm: {
        ...(settings?.llm || {}),
        temperature: clamp(Number(settings?.llm?.temperature) || 0.75, 0.2, 1.1),
        maxOutputTokens: clamp(Number(settings?.llm?.maxOutputTokens) || 28, 8, 40)
      }
    };
    const systemPrompt = [
      `You are ${getPromptBotName(settings)} speaking in live Discord VC.`,
      "Output one short spoken line only (4-12 words).",
      "Line must clearly indicate you're checking something on the web right now.",
      "Keep it casual and natural. No markdown, no tags, no directives."
    ].join("\n");
    const userPrompt = [
      normalizedQuery ? `Lookup query: ${normalizedQuery}` : "Lookup query: (not specified)",
      "Write one quick filler line before lookup results are ready."
    ].join("\n");

    try {
      const generation = await this.llm.generate({
        settings: tunedSettings,
        systemPrompt,
        userPrompt,
        contextMessages: [],
        trace: {
          guildId: session?.guildId || null,
          channelId: session?.textChannelId || null,
          userId: userId || null,
          source: "voice_web_lookup_busy_line"
        }
      });
      const line = normalizeVoiceText(String(generation?.text || ""), VOICE_LOOKUP_BUSY_MAX_CHARS);
      if (!line || line === "[SKIP]") return "";
      return line;
    } catch {
      return "";
    }
  }

  requestRealtimeTextUtterance({
    session,
    text,
    userId = null,
    source = "voice_text_utterance"
  }) {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode)) return false;
    const realtimeClient = session.realtimeClient;
    if (!realtimeClient || typeof realtimeClient.requestTextUtterance !== "function") return false;
    const line = normalizeVoiceText(text, STT_REPLY_MAX_CHARS);
    if (!line) return false;

    const utterancePrompt = normalizeVoiceText(
      `You're in live Discord voice chat. Say exactly this line and nothing else: ${line}`,
      420
    );
    if (!utterancePrompt) return false;

    try {
      realtimeClient.requestTextUtterance(utterancePrompt);
      this.createTrackedAudioResponse({
        session,
        userId: userId || this.client.user?.id || null,
        source,
        resetRetryState: true,
        emitCreateEvent: false
      });
      return true;
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `voice_text_utterance_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          source: String(source || "voice_text_utterance")
        }
      });
      return false;
    }
  }

  async speakVoiceLineWithTts({
    session,
    settings,
    text,
    source = "voice_tts_line"
  }) {
    if (!session || session.ending) return false;
    const line = normalizeVoiceText(text, STT_REPLY_MAX_CHARS);
    if (!line) return false;
    if (!this.llm?.synthesizeSpeech) return false;

    const sttSettings = settings?.voice?.sttPipeline || {};
    const ttsModel = String(sttSettings?.ttsModel || "gpt-4o-mini-tts").trim() || "gpt-4o-mini-tts";
    const ttsVoice = String(sttSettings?.ttsVoice || "alloy").trim() || "alloy";
    const ttsSpeedRaw = Number(sttSettings?.ttsSpeed);
    const ttsSpeed = Number.isFinite(ttsSpeedRaw) ? ttsSpeedRaw : 1;

    let ttsPcm = Buffer.alloc(0);
    try {
      const tts = await this.llm.synthesizeSpeech({
        text: line,
        model: ttsModel,
        voice: ttsVoice,
        speed: ttsSpeed,
        responseFormat: "pcm",
        trace: {
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          source
        }
      });
      ttsPcm = tts.audioBuffer;
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `voice_tts_line_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          source: String(source || "voice_tts_line")
        }
      });
      return false;
    }

    if (!ttsPcm.length || session.ending) return false;
    const queued = await this.enqueueChunkedTtsPcmForPlayback({
      session,
      ttsPcm,
      inputSampleRateHz: 24000
    });
    if (!queued) return false;
    this.markBotTurnOut(session, settings);
    return true;
  }

  bindSessionHandlers(session, settings) {
    const onStateChange = (_oldState, newState) => {
      if (session.ending) return;
      if (
        newState?.status === VoiceConnectionStatus.Destroyed ||
        newState?.status === VoiceConnectionStatus.Disconnected
      ) {
        this.endSession({
          guildId: session.guildId,
          reason: "connection_lost",
          announcement: "voice connection dropped, i'm out.",
          settings
        }).catch(() => undefined);
      }
    };

    session.connection.on("stateChange", onStateChange);
    session.cleanupHandlers.push(() => {
      session.connection.off("stateChange", onStateChange);
    });

    const speaking = session.connection.receiver?.speaking;
    if (!speaking?.on) return;

    const onSpeakingStart = (userId) => {
      if (String(userId || "") === String(this.client.user?.id || "")) return;
      this.touchActivity(session.guildId, settings);
      if (this.isInboundCaptureSuppressed(session)) {
        const now = Date.now();
        if (now - Number(session.lastSuppressedCaptureLogAt || 0) >= VOICE_LOOKUP_BUSY_LOG_COOLDOWN_MS) {
          session.lastSuppressedCaptureLogAt = now;
          this.store.logAction({
            kind: "voice_runtime",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: String(userId || "").trim() || null,
            content: "voice_input_suppressed",
            metadata: {
              sessionId: session.id,
              mode: session.mode,
              reason: "voice_web_lookup_busy"
            }
          });
        }
        return;
      }
      const normalizedUserId = String(userId || "");
      const activeCapture = session.userCaptures.get(normalizedUserId);
      if (activeCapture?.speakingEndFinalizeTimer) {
        clearTimeout(activeCapture.speakingEndFinalizeTimer);
        activeCapture.speakingEndFinalizeTimer = null;
      }
      this.startInboundCapture({
        session,
        userId: normalizedUserId,
        settings
      });
    };

    const onSpeakingEnd = (userId) => {
      if (String(userId || "") === String(this.client.user?.id || "")) return;
      const capture = session.userCaptures.get(String(userId || ""));
      if (!capture || typeof capture.finalize !== "function") return;
      if (capture.speakingEndFinalizeTimer) return;
      const captureAgeMs = Math.max(0, Date.now() - Number(capture.startedAt || Date.now()));
      const finalizeDelayMs = this.resolveSpeakingEndFinalizeDelayMs({
        session,
        captureAgeMs
      });
      capture.speakingEndFinalizeTimer = setTimeout(() => {
        capture.speakingEndFinalizeTimer = null;
        capture.finalize("speaking_end");
      }, finalizeDelayMs);
    };

    speaking.on("start", onSpeakingStart);
    speaking.on("end", onSpeakingEnd);
    session.cleanupHandlers.push(() => {
      speaking.removeListener("start", onSpeakingStart);
      speaking.removeListener("end", onSpeakingEnd);
    });
  }

  startInboundCapture({ session, userId, settings = session?.settingsSnapshot }) {
    if (!session || !userId) return;
    if (session.userCaptures.has(userId)) return;

    const opusStream = session.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: INPUT_SPEECH_END_SILENCE_MS
      }
    });

    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960
    });

    const pcmStream = opusStream.pipe(decoder);
    const captureState = {
      userId,
      opusStream,
      decoder,
      pcmStream,
      startedAt: Date.now(),
      bytesSent: 0,
      pcmChunks: [],
      lastActivityTouchAt: 0,
      idleFlushTimer: null,
      maxFlushTimer: null,
      speakingEndFinalizeTimer: null,
      finalize: null,
      abort: null
    };

    session.userCaptures.set(userId, captureState);

    this.store.logAction({
      kind: "voice_turn_in",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "voice_activity_started",
      metadata: {
        sessionId: session.id
      }
    });

    const cleanupCapture = () => {
      const current = session.userCaptures.get(userId);
      if (!current) return;
      session.userCaptures.delete(userId);

      if (current.idleFlushTimer) {
        clearTimeout(current.idleFlushTimer);
      }
      if (current.maxFlushTimer) {
        clearTimeout(current.maxFlushTimer);
      }
      if (current.speakingEndFinalizeTimer) {
        clearTimeout(current.speakingEndFinalizeTimer);
      }

      try {
        current.opusStream.destroy();
      } catch {
        // ignore
      }

      try {
        current.decoder.destroy?.();
      } catch {
        // ignore
      }

      try {
        current.pcmStream.destroy();
      } catch {
        // ignore
      }
    };

    const scheduleIdleFlush = () => {
      if (captureState.idleFlushTimer) {
        clearTimeout(captureState.idleFlushTimer);
      }
      captureState.idleFlushTimer = setTimeout(() => {
        finalizeUserTurn("idle_timeout");
      }, CAPTURE_IDLE_FLUSH_MS);
    };

    pcmStream.on("data", (chunk) => {
      const now = Date.now();
      const normalizedPcm = convertDiscordPcmToXaiInput(
        chunk,
        isRealtimeMode(session.mode) ? Number(session.realtimeInputSampleRateHz) || 24000 : 24000
      );
      if (!normalizedPcm.length) return;
      captureState.bytesSent += normalizedPcm.length;
      captureState.pcmChunks.push(normalizedPcm);
      if (captureState.speakingEndFinalizeTimer) {
        clearTimeout(captureState.speakingEndFinalizeTimer);
        captureState.speakingEndFinalizeTimer = null;
      }
      scheduleIdleFlush();

      session.lastInboundAudioAt = now;
      if (now - captureState.lastActivityTouchAt >= ACTIVITY_TOUCH_THROTTLE_MS) {
        this.touchActivity(session.guildId, settings);
        captureState.lastActivityTouchAt = now;
      }

    });

    let captureFinalized = false;
    const finalizeUserTurn = (reason = "stream_end") => {
      if (captureFinalized) return;
      captureFinalized = true;

      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "voice_turn_finalized",
        metadata: {
          sessionId: session.id,
          reason: String(reason || "stream_end"),
          bytesSent: captureState.bytesSent,
          durationMs: Math.max(0, Date.now() - captureState.startedAt)
        }
      });

      if (captureState.bytesSent <= 0 || session.ending) {
        cleanupCapture();
        return;
      }

      const pcmBuffer = Buffer.concat(captureState.pcmChunks);
      if (session.mode === "stt_pipeline") {
        this.queueSttPipelineTurn({
          session,
          userId,
          pcmBuffer,
          captureReason: reason
        });
      } else {
        this.queueRealtimeTurn({
          session,
          userId,
          pcmBuffer,
          captureReason: reason
        });
      }

      cleanupCapture();
    };
    captureState.finalize = finalizeUserTurn;
    captureState.abort = (reason = "capture_suppressed") => {
      if (captureFinalized) return;
      captureFinalized = true;
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "voice_turn_dropped",
        metadata: {
          sessionId: session.id,
          reason: String(reason || "capture_suppressed"),
          bytesSent: captureState.bytesSent,
          durationMs: Math.max(0, Date.now() - captureState.startedAt)
        }
      });
      cleanupCapture();
    };
    captureState.maxFlushTimer = setTimeout(() => {
      finalizeUserTurn("max_duration");
    }, CAPTURE_MAX_DURATION_MS);

    opusStream.once("error", (error) => {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: `inbound_audio_receive_error: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
      finalizeUserTurn("receive_error");
    });
    decoder.once("error", (error) => {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: `inbound_audio_decode_error: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
      finalizeUserTurn("decode_error");
    });
    pcmStream.once("end", finalizeUserTurn);
    pcmStream.once("close", finalizeUserTurn);
    pcmStream.once("error", (error) => {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: `inbound_audio_stream_error: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
      finalizeUserTurn();
    });
  }

  shouldCoalesceRealtimeTurn(prevTurn, nextTurn) {
    if (!prevTurn || !nextTurn) return false;
    const prevUserId = String(prevTurn.userId || "").trim();
    const nextUserId = String(nextTurn.userId || "").trim();
    if (!prevUserId || !nextUserId || prevUserId !== nextUserId) return false;

    const prevCaptureReason = String(prevTurn.captureReason || "").trim();
    const nextCaptureReason = String(nextTurn.captureReason || "").trim();
    if (!prevCaptureReason || !nextCaptureReason || prevCaptureReason !== nextCaptureReason) return false;

    const prevQueuedAt = Number(prevTurn.queuedAt || 0);
    const nextQueuedAt = Number(nextTurn.queuedAt || 0);
    if (!prevQueuedAt || !nextQueuedAt) return false;
    if (nextQueuedAt - prevQueuedAt > REALTIME_TURN_COALESCE_WINDOW_MS) return false;

    const prevBuffer = Buffer.isBuffer(prevTurn.pcmBuffer) ? prevTurn.pcmBuffer : null;
    const nextBuffer = Buffer.isBuffer(nextTurn.pcmBuffer) ? nextTurn.pcmBuffer : null;
    if (!prevBuffer?.length || !nextBuffer?.length) return false;
    if (prevBuffer.length + nextBuffer.length > REALTIME_TURN_COALESCE_MAX_BYTES) return false;

    return true;
  }

  queueRealtimeTurn({ session, userId, pcmBuffer, captureReason = "stream_end" }) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;
    if (!pcmBuffer || !pcmBuffer.length) return;
    const pendingQueue = Array.isArray(session.pendingRealtimeTurns) ? session.pendingRealtimeTurns : [];
    if (!Array.isArray(session.pendingRealtimeTurns)) {
      session.pendingRealtimeTurns = pendingQueue;
    }

    const queuedTurn = {
      session,
      userId,
      pcmBuffer,
      captureReason,
      queuedAt: Date.now()
    };

    if (session.realtimeTurnDrainActive) {
      const lastQueuedTurn = pendingQueue[pendingQueue.length - 1] || null;
      if (this.shouldCoalesceRealtimeTurn(lastQueuedTurn, queuedTurn)) {
        lastQueuedTurn.pcmBuffer = Buffer.concat([lastQueuedTurn.pcmBuffer, queuedTurn.pcmBuffer]);
        lastQueuedTurn.captureReason = queuedTurn.captureReason;
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          content: "realtime_turn_coalesced",
          metadata: {
            sessionId: session.id,
            captureReason: String(captureReason || "stream_end"),
            combinedBytes: lastQueuedTurn.pcmBuffer.length,
            queueDepth: pendingQueue.length
          }
        });
        return;
      }

      if (pendingQueue.length >= REALTIME_TURN_QUEUE_MAX) {
        const droppedTurn = pendingQueue.shift();
        if (droppedTurn) {
          this.store.logAction({
            kind: "voice_runtime",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId,
            content: "realtime_turn_superseded",
            metadata: {
              sessionId: session.id,
              replacedCaptureReason: String(droppedTurn.captureReason || "stream_end"),
              replacingCaptureReason: String(captureReason || "stream_end"),
              replacedQueueAgeMs: Math.max(0, Date.now() - Number(droppedTurn.queuedAt || Date.now())),
              maxQueueDepth: REALTIME_TURN_QUEUE_MAX
            }
          });
        }
      }
      pendingQueue.push(queuedTurn);
      return;
    }

    if (pendingQueue.length > 0) {
      pendingQueue.push(queuedTurn);
      const nextTurn = pendingQueue.shift();
      if (!nextTurn) return;
      this.drainRealtimeTurnQueue(nextTurn).catch(() => undefined);
      return;
    }

    this.drainRealtimeTurnQueue(queuedTurn).catch(() => undefined);
  }

  async drainRealtimeTurnQueue(initialTurn) {
    const session = initialTurn?.session;
    if (!session || session.ending) return;
    if (session.realtimeTurnDrainActive) return;
    const pendingQueue = Array.isArray(session.pendingRealtimeTurns) ? session.pendingRealtimeTurns : [];
    if (!Array.isArray(session.pendingRealtimeTurns)) {
      session.pendingRealtimeTurns = pendingQueue;
    }

    session.realtimeTurnDrainActive = true;
    let turn = initialTurn;

    try {
      while (turn && !session.ending) {
        try {
          await this.runRealtimeTurn(turn);
        } catch (error) {
          this.store.logAction({
            kind: "voice_error",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: turn.userId,
            content: `realtime_turn_failed: ${String(error?.message || error)}`,
            metadata: {
              sessionId: session.id
            }
          });
        }

        const next = pendingQueue.shift();
        turn = next || null;
      }
    } finally {
      session.realtimeTurnDrainActive = false;
      if (session.ending) {
        session.pendingRealtimeTurns = [];
      } else {
        const pending = pendingQueue.shift();
        if (pending) {
          this.drainRealtimeTurnQueue(pending).catch(() => undefined);
        }
      }
    }
  }

  async runRealtimeTurn({ session, userId, pcmBuffer, captureReason = "stream_end", queuedAt = 0 }) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;
    if (!pcmBuffer?.length) return;
    const queueWaitMs = queuedAt ? Math.max(0, Date.now() - Number(queuedAt || Date.now())) : 0;
    const pendingQueueDepth = Array.isArray(session.pendingRealtimeTurns) ? session.pendingRealtimeTurns.length : 0;
    if (
      pendingQueueDepth > 0 &&
      queueWaitMs >= REALTIME_TURN_STALE_SKIP_MS &&
      String(captureReason || "") !== "bot_turn_open_deferred_flush"
    ) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "realtime_turn_skipped_stale",
        metadata: {
          sessionId: session.id,
          captureReason: String(captureReason || "stream_end"),
          queueWaitMs,
          pendingQueueDepth,
          pcmBytes: pcmBuffer.length
        }
      });
      return;
    }

    const settings = session.settingsSnapshot || this.store.getSettings();
    const preferredModel =
      session.mode === "openai_realtime"
        ? settings?.voice?.openaiRealtime?.inputTranscriptionModel
        : settings?.voice?.sttPipeline?.transcriptionModel;
    const transcriptionModel = String(preferredModel || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
    const sampleRateHz = Number(session.realtimeInputSampleRateHz) || 24000;
    const transcriptionPlan = resolveRealtimeTurnTranscriptionPlan({
      mode: session.mode,
      configuredModel: transcriptionModel,
      pcmByteLength: pcmBuffer.length,
      sampleRateHz
    });
    let turnTranscript = "";
    if (this.llm?.isAsrReady?.() && this.llm?.transcribeAudio) {
      turnTranscript = await this.transcribePcmTurn({
        session,
        userId,
        pcmBuffer,
        model: transcriptionPlan.primaryModel,
        sampleRateHz,
        captureReason,
        traceSource: "voice_realtime_turn_decider",
        errorPrefix: "voice_realtime_transcription_failed"
      });

      if (!turnTranscript && transcriptionPlan.fallbackModel) {
        turnTranscript = await this.transcribePcmTurn({
          session,
          userId,
          pcmBuffer,
          model: transcriptionPlan.fallbackModel,
          sampleRateHz,
          captureReason,
          traceSource: "voice_realtime_turn_decider_fallback",
          errorPrefix: "voice_realtime_transcription_fallback_failed"
        });
      }
    }

    if (turnTranscript) {
      this.recordVoiceTurn(session, {
        role: "user",
        userId,
        text: turnTranscript
      });
      this.queueVoiceMemoryIngest({
        session,
        settings,
        userId,
        transcript: turnTranscript,
        source: "voice_realtime_ingest",
        captureReason,
        errorPrefix: "voice_realtime_memory_ingest_failed"
      });
    }

    const decision = await this.evaluateVoiceReplyDecision({
      session,
      settings,
      userId,
      transcript: turnTranscript,
      source: "realtime"
    });
    this.updateFocusedSpeakerWindow({
      session,
      userId,
      allow: Boolean(decision.allow),
      directAddressed: Boolean(decision.directAddressed),
      reason: decision.reason
    });

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "voice_turn_addressing",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        source: "realtime",
        captureReason: String(captureReason || "stream_end"),
        queueWaitMs,
        allow: Boolean(decision.allow),
        reason: decision.reason,
        participantCount: Number(decision.participantCount || 0),
        directAddressed: Boolean(decision.directAddressed),
        transcript: decision.transcript || turnTranscript || null,
        transcriptionModelPrimary: transcriptionPlan.primaryModel,
        transcriptionModelFallback: transcriptionPlan.fallbackModel || null,
        transcriptionPlanReason: transcriptionPlan.reason,
        llmResponse: decision.llmResponse || null,
        llmProvider: decision.llmProvider || null,
        llmModel: decision.llmModel || null,
        error: decision.error || null
      }
    });

    if (!decision.allow) {
      if (decision.reason === "bot_turn_open") {
        this.queueDeferredBotTurnOpenTurn({
          session,
          userId,
          transcript: decision.transcript || turnTranscript,
          pcmBuffer,
          captureReason,
          source: "realtime",
          directAddressed: Boolean(decision.directAddressed)
        });
      }
      return;
    }
    const handledLookupReply = await this.maybeHandleRealtimeWebLookupReply({
      session,
      settings,
      userId,
      transcript: turnTranscript,
      directAddressed: Boolean(decision.directAddressed)
    });
    if (handledLookupReply) return;

    await this.forwardRealtimeTurnAudio({
      session,
      settings,
      userId,
      transcript: turnTranscript,
      pcmBuffer,
      captureReason
    });
  }

  queueDeferredBotTurnOpenTurn({
    session,
    userId = null,
    transcript = "",
    pcmBuffer = null,
    captureReason = "stream_end",
    source = "voice_turn",
    directAddressed = false
  }) {
    if (!session || session.ending) return;
    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedTranscript) return;
    const pendingQueue = Array.isArray(session.pendingDeferredTurns) ? session.pendingDeferredTurns : [];
    if (!Array.isArray(session.pendingDeferredTurns)) {
      session.pendingDeferredTurns = pendingQueue;
    }
    if (pendingQueue.length >= BOT_TURN_DEFERRED_QUEUE_MAX) {
      pendingQueue.shift();
    }
    pendingQueue.push({
      userId: String(userId || "").trim() || null,
      transcript: normalizedTranscript,
      pcmBuffer: pcmBuffer?.length ? pcmBuffer : null,
      captureReason: String(captureReason || "stream_end"),
      source: String(source || "voice_turn"),
      directAddressed: Boolean(directAddressed),
      queuedAt: Date.now()
    });
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "voice_turn_deferred_bot_turn_open",
      metadata: {
        sessionId: session.id,
        source: String(source || "voice_turn"),
        mode: session.mode,
        captureReason: String(captureReason || "stream_end"),
        directAddressed: Boolean(directAddressed),
        deferredQueueSize: pendingQueue.length
      }
    });
    this.scheduleDeferredBotTurnOpenFlush({ session });
  }

  scheduleDeferredBotTurnOpenFlush({ session, delayMs = BOT_TURN_DEFERRED_FLUSH_DELAY_MS }) {
    if (!session || session.ending) return;
    if (session.deferredTurnFlushTimer) {
      clearTimeout(session.deferredTurnFlushTimer);
    }
    session.deferredTurnFlushTimer = setTimeout(() => {
      session.deferredTurnFlushTimer = null;
      this.flushDeferredBotTurnOpenTurns({ session }).catch(() => undefined);
    }, Math.max(20, Number(delayMs) || BOT_TURN_DEFERRED_FLUSH_DELAY_MS));
  }

  async flushDeferredBotTurnOpenTurns({ session }) {
    if (!session || session.ending) return;
    const pendingQueue = Array.isArray(session.pendingDeferredTurns) ? session.pendingDeferredTurns : [];
    if (!pendingQueue.length) return;

    if (session.botTurnOpen || Number(session.userCaptures?.size || 0) > 0) {
      this.scheduleDeferredBotTurnOpenFlush({ session });
      return;
    }

    const deferredTurns = pendingQueue.splice(0, pendingQueue.length);
    if (!deferredTurns.length) return;
    const coalescedTurns = deferredTurns.slice(-BOT_TURN_DEFERRED_COALESCE_MAX);
    const latestTurn = coalescedTurns[coalescedTurns.length - 1];
    const coalescedTranscript = normalizeVoiceText(
      coalescedTurns
        .map((entry) => String(entry?.transcript || "").trim())
        .filter(Boolean)
        .join(" "),
      STT_TRANSCRIPT_MAX_CHARS
    );
    if (!coalescedTranscript) return;
    const coalescedPcmBuffer = isRealtimeMode(session.mode)
      ? Buffer.concat(
          coalescedTurns
            .map((entry) => (entry?.pcmBuffer?.length ? entry.pcmBuffer : null))
            .filter(Boolean)
        )
      : null;

    const settings = session.settingsSnapshot || this.store.getSettings();
    const decision = await this.evaluateVoiceReplyDecision({
      session,
      settings,
      userId: latestTurn?.userId || null,
      transcript: coalescedTranscript,
      source: "bot_turn_open_deferred_flush"
    });
    this.updateFocusedSpeakerWindow({
      session,
      userId: latestTurn?.userId || null,
      allow: Boolean(decision.allow),
      directAddressed: Boolean(decision.directAddressed),
      reason: decision.reason
    });

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: latestTurn?.userId || null,
      content: "voice_turn_addressing",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        source: "bot_turn_open_deferred_flush",
        captureReason: latestTurn?.captureReason || "stream_end",
        allow: Boolean(decision.allow),
        reason: decision.reason,
        participantCount: Number(decision.participantCount || 0),
        directAddressed: Boolean(decision.directAddressed),
        transcript: decision.transcript || coalescedTranscript || null,
        deferredTurnCount: coalescedTurns.length,
        llmResponse: decision.llmResponse || null,
        llmProvider: decision.llmProvider || null,
        llmModel: decision.llmModel || null,
        error: decision.error || null
      }
    });
    if (!decision.allow) {
      if (decision.reason === "bot_turn_open") {
        this.queueDeferredBotTurnOpenTurn({
          session,
          userId: latestTurn?.userId || null,
          transcript: coalescedTranscript,
          pcmBuffer: coalescedPcmBuffer,
          captureReason: latestTurn?.captureReason || "stream_end",
          source: "bot_turn_open_deferred_flush",
          directAddressed: Boolean(decision.directAddressed)
        });
      }
      return;
    }

    if (session.mode === "stt_pipeline") {
      await this.runSttPipelineReply({
        session,
        settings,
        userId: latestTurn?.userId || null,
        transcript: coalescedTranscript,
        directAddressed: Boolean(decision.directAddressed)
      });
      return;
    }

    if (!isRealtimeMode(session.mode)) return;
    if (!coalescedPcmBuffer?.length) return;
    await this.forwardRealtimeTurnAudio({
      session,
      settings,
      userId: latestTurn?.userId || null,
      transcript: coalescedTranscript,
      pcmBuffer: coalescedPcmBuffer,
      captureReason: "bot_turn_open_deferred_flush"
    });
  }

  async forwardRealtimeTurnAudio({ session, settings, userId, transcript = "", pcmBuffer, captureReason = "stream_end" }) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;
    if (!pcmBuffer?.length) return;
    try {
      session.realtimeClient.appendInputAudioPcm(pcmBuffer);
      session.pendingRealtimeInputBytes = Math.max(0, Number(session.pendingRealtimeInputBytes || 0)) + pcmBuffer.length;
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: `audio_append_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          mode: session.mode
        }
      });
      return;
    }

    if (session.mode === "openai_realtime") {
      await this.prepareOpenAiRealtimeTurnContext({
        session,
        settings,
        userId,
        transcript,
        captureReason
      });
    }
    this.scheduleResponseFromBufferedAudio({ session, userId });
  }

  queueVoiceMemoryIngest({
    session,
    settings,
    userId,
    transcript,
    source = "voice_stt_pipeline_ingest",
    captureReason = "stream_end",
    errorPrefix = "voice_stt_memory_ingest_failed"
  }) {
    if (!settings?.memory?.enabled) return;
    if (!this.memory || typeof this.memory.ingestMessage !== "function") return;

    const normalizedUserId = String(userId || "").trim();
    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedUserId || !normalizedTranscript) return;

    void this.memory
      .ingestMessage({
        messageId: `voice-${String(session.guildId || "guild")}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        authorId: normalizedUserId,
        authorName: this.resolveVoiceSpeakerName(session, normalizedUserId) || "unknown",
        content: normalizedTranscript,
        settings,
        trace: {
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: normalizedUserId,
          source: String(source || "voice_stt_pipeline_ingest")
        }
      })
      .catch((error) => {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: normalizedUserId || null,
          content: `${String(errorPrefix || "voice_stt_memory_ingest_failed")}: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id,
            captureReason: String(captureReason || "stream_end")
          }
        });
      });
  }

  async evaluateVoiceReplyDecision({ session, settings, userId, transcript, source: _source = "stt_pipeline" }) {
    const normalizedTranscript = normalizeVoiceText(transcript, VOICE_TURN_ADDRESSING_TRANSCRIPT_MAX_CHARS);
    const normalizedUserId = String(userId || "").trim();
    const participantCount = this.countHumanVoiceParticipants(session);
    const speakerName = this.resolveVoiceSpeakerName(session, userId) || "someone";
    const participantList = this.getVoiceChannelParticipants(session)
      .map((entry) => entry.displayName)
      .filter(Boolean)
      .slice(0, 10);
    const addressedToOtherParticipant = isLikelyVocativeAddressToOtherParticipant({
      transcript: normalizedTranscript,
      participantDisplayNames: participantList,
      botName: getPromptBotName(settings),
      speakerName
    });
    const now = Date.now();
    const directAddressedByName = normalizedTranscript
      ? (
        isVoiceTurnAddressedToBot(normalizedTranscript, settings) ||
        isLikelyBotNameVariantAddress(normalizedTranscript, settings?.botName || "")
      )
      : false;
    const joinWindowAgeMs = Math.max(0, now - Number(session?.startedAt || 0));
    const joinWindowActive = Boolean(session?.startedAt) && joinWindowAgeMs <= JOIN_GREETING_LLM_WINDOW_MS;
    const directAddressed = directAddressedByName;
    const replyEagerness = clamp(Number(settings?.voice?.replyEagerness) || 0, 0, 100);

    if (!normalizedTranscript) {
      return {
        allow: false,
        reason: "missing_transcript",
        participantCount,
        directAddressed,
        transcript: ""
      };
    }

    if (session?.botTurnOpen) {
      return {
        allow: false,
        reason: "bot_turn_open",
        participantCount,
        directAddressed,
        transcript: normalizedTranscript
      };
    }

    const lowSignalFragment = isLowSignalVoiceFragment(normalizedTranscript);
    const wakeWordPing = isLikelyWakeWordPing(normalizedTranscript);
    const lowSignalLlmEligible =
      !directAddressed &&
      (joinWindowActive || shouldUseLlmForLowSignalTurn(normalizedTranscript));
    if (lowSignalFragment) {
      if (directAddressed && wakeWordPing) {
        return {
          allow: true,
          reason: "direct_address_wake_ping",
          participantCount,
          directAddressed,
          transcript: normalizedTranscript
        };
      }
      if (!lowSignalLlmEligible) {
        return {
          allow: false,
          reason: "low_signal_fragment",
          participantCount,
          directAddressed,
          transcript: normalizedTranscript
        };
      }
    }

    const focusedSpeakerUserId = String(session?.focusedSpeakerUserId || "").trim();
    const focusedSpeakerAgeMs = now - Number(session?.focusedSpeakerAt || 0);
    const focusedSpeakerFollowup =
      !directAddressed &&
      normalizedUserId &&
      focusedSpeakerUserId &&
      normalizedUserId === focusedSpeakerUserId &&
      focusedSpeakerAgeMs >= 0 &&
      focusedSpeakerAgeMs <= FOCUSED_SPEAKER_CONTINUATION_MS &&
      !addressedToOtherParticipant;
    if (focusedSpeakerFollowup) {
      return {
        allow: true,
        reason: "focused_speaker_followup",
        participantCount,
        directAddressed,
        transcript: normalizedTranscript
      };
    }

    if (directAddressed) {
      return {
        allow: true,
        reason: "direct_address_fast_path",
        participantCount,
        directAddressed,
        transcript: normalizedTranscript
      };
    }

    if (!directAddressed && replyEagerness <= 0) {
      return {
        allow: false,
        reason: "eagerness_disabled_without_direct_address",
        participantCount,
        directAddressed,
        transcript: normalizedTranscript
      };
    }

    const replyDecisionLlm = settings?.voice?.replyDecisionLlm || {};
    const sessionMode = String(session?.mode || settings?.voice?.mode || "")
      .trim()
      .toLowerCase();
    const classifierEnabled =
      replyDecisionLlm?.enabled !== undefined ? Boolean(replyDecisionLlm.enabled) : true;
    const requestedDecisionProvider = replyDecisionLlm?.provider;
    const llmProvider = normalizeVoiceReplyDecisionProvider(requestedDecisionProvider);
    const requestedDecisionModel = replyDecisionLlm?.model;
    const llmModel = String(requestedDecisionModel || defaultVoiceReplyDecisionModel(llmProvider))
      .trim()
      .slice(0, 120) || defaultVoiceReplyDecisionModel(llmProvider);

    if (!classifierEnabled) {
      return {
        allow: sessionMode === "stt_pipeline",
        reason:
          sessionMode === "stt_pipeline"
            ? "classifier_disabled_merged_with_generation"
            : "classifier_disabled",
        participantCount,
        directAddressed,
        transcript: normalizedTranscript,
        llmProvider,
        llmModel
      };
    }

    if (!this.llm?.generate) {
      return {
        allow: false,
        reason: "llm_generate_unavailable",
        participantCount,
        directAddressed,
        transcript: normalizedTranscript,
        llmProvider,
        llmModel
      };
    }

    const botName = getPromptBotName(settings);
    const recentHistory = this.formatVoiceDecisionHistory(session, 6);
    const configuredMaxDecisionAttempts = Number(replyDecisionLlm?.maxAttempts);
    const maxDecisionAttempts = clamp(
      Math.floor(Number.isFinite(configuredMaxDecisionAttempts) ? configuredMaxDecisionAttempts : 1),
      1,
      3
    );
    const primaryDecisionSettings = {
      ...settings,
      llm: {
        ...(settings?.llm || {}),
        provider: llmProvider,
        model: llmModel,
        temperature: 0,
        maxOutputTokens: 2
      }
    };

    const wakeVariantHint =
      [
        "Treat near-phonetic or misspelled tokens that appear to target the bot name as direct address.",
        "Short callouts like \"yo <name-ish-token>\" or \"hi <name-ish-token>\" usually indicate direct address.",
        "Questions like \"is that you <name-ish-token>?\" usually indicate direct address."
      ].join(" ");

    const fullContextPromptParts = [
      `Bot name: ${botName}.`,
      `Reply eagerness: ${replyEagerness}/100.`,
      `Human participants in channel: ${participantCount}.`,
      `Current speaker: ${speakerName}.`,
      `Join window active: ${joinWindowActive ? "yes" : "no"}.`,
      `Join window age ms: ${joinWindowAgeMs}.`,
      `Directly addressed: ${directAddressed ? "yes" : "no"}.`,
      `Likely aimed at another participant: ${addressedToOtherParticipant ? "yes" : "no"}.`,
      `Latest transcript: "${normalizedTranscript}".`,
      wakeVariantHint
    ];
    if (participantList.length) {
      fullContextPromptParts.push(`Participants: ${participantList.join(", ")}.`);
    }
    if (recentHistory) {
      fullContextPromptParts.push(`Recent voice turns:\n${recentHistory}`);
    }

    const compactContextPromptParts = [
      `Bot name: ${botName}.`,
      `Current speaker: ${speakerName}.`,
      `Join window active: ${joinWindowActive ? "yes" : "no"}.`,
      `Directly addressed: ${directAddressed ? "yes" : "no"}.`,
      `Likely aimed at another participant: ${addressedToOtherParticipant ? "yes" : "no"}.`,
      `Reply eagerness: ${replyEagerness}/100.`,
      `Participants: ${participantCount}.`,
      `Transcript: "${normalizedTranscript}".`,
      wakeVariantHint
    ];
    if (participantList.length) {
      compactContextPromptParts.push(`Known participants: ${participantList.join(", ")}.`);
    }
    if (recentHistory) {
      compactContextPromptParts.push(`Recent turns:\n${recentHistory}`);
    }

    const systemPromptCompact = [
      `You decide if "${botName}" should reply right now in a live Discord voice chat.`,
      "Output exactly one token: YES or NO.",
      "Prefer YES for direct wake-word mentions and likely ASR variants of the bot name.",
      "Treat near-phonetic or misspelled tokens that appear to target the bot name as direct address.",
      "Short callouts like \"yo <name-ish-token>\" or \"hi <name-ish-token>\" should usually be YES.",
      "Questions like \"is that you <name-ish-token>?\" should usually be YES.",
      "Do not use rhyme alone as evidence of direct address.",
      "Generic chatter such as prank/stank/stinky phrasing without a clear name-like callout should usually be NO.",
      "Priority rule: when Join window active is yes, treat short greetings/check-ins as targeted at the bot unless another human target is explicit.",
      "Examples of join-window short greetings/check-ins: hi, hey, hello, yo, hola, what's up, what up, salam, marhaba, ciao, bonjour, こんにちは, مرحبا.",
      "In join window, a single-token greeting/check-in should usually be YES, not filler.",
      "Prefer YES for clear questions/requests that seem aimed at the bot or the current speaker flow.",
      "If this sounds like a follow-up from an engaged speaker, lean YES.",
      "Prefer NO for filler/noise, pure acknowledgements, or turns clearly aimed at another human.",
      "When uncertain and the utterance is a clear question, prefer YES.",
      "Never output anything except YES or NO."
    ].join("\n");
    const systemPromptFull = [
      `You classify whether "${botName}" should reply now in Discord voice chat.`,
      "Output exactly one token: YES or NO.",
      "If directly addressed, strongly prefer YES unless transcript is too unclear to answer.",
      "If not directly addressed, use reply eagerness and flow; prefer NO if interruptive or low value.",
      "In small conversations, prefer YES for clear questions and active back-and-forth.",
      "Treat likely ASR wake-word variants of the bot name as direct address when context supports it.",
      "Short callouts like \"yo <name-ish-token>\" or \"hi <name-ish-token>\" should usually be YES.",
      "Questions like \"is that you <name-ish-token>?\" should usually be YES.",
      "Priority rule: when Join window active is yes, treat short greetings/check-ins as aimed at the bot unless another human target is explicit.",
      "Examples of join-window short greetings/check-ins: hi, hey, hello, yo, hola, what's up, what up, salam, marhaba, ciao, bonjour, こんにちは, مرحبا.",
      "In join window, a single-token greeting/check-in should usually be YES, not filler.",
      "Do not treat rhyme-only similarity as wake-word evidence.",
      "Generic prank/stank/stinky chatter without a clear name-like callout should usually be NO.",
      "Never output anything except YES or NO."
    ].join("\n");
    const systemPromptStrict = [
      "Binary classifier.",
      "Output exactly one token: YES or NO.",
      "No punctuation. No explanation."
    ].join("\n");

    const decisionProcedure = [
      {
        label: "primary_compact_context",
        settings: primaryDecisionSettings,
        systemPrompt: systemPromptCompact,
        userPrompt: compactContextPromptParts.join("\n")
      },
      {
        label: "primary_full_context",
        settings: primaryDecisionSettings,
        systemPrompt: systemPromptFull,
        userPrompt: fullContextPromptParts.join("\n\n")
      },
      {
        label: "primary_minimal_context",
        settings: primaryDecisionSettings,
        systemPrompt: systemPromptStrict,
        userPrompt:
          `Join window active: ${joinWindowActive ? "yes" : "no"}.\n` +
          `Directly addressed: ${directAddressed ? "yes" : "no"}.\n` +
          `Transcript: "${normalizedTranscript}".`
      }
    ].slice(0, maxDecisionAttempts);
    const claudeDecisionJsonSchema =
      llmProvider === "claude-code"
        ? JSON.stringify({
            type: "object",
            additionalProperties: false,
            properties: {
              decision: {
                type: "string",
                enum: ["YES", "NO"]
              }
            },
            required: ["decision"]
          })
        : "";

    const invalidOutputs = [];
    const generationErrors = [];
    for (let index = 0; index < decisionProcedure.length; index += 1) {
      const step = decisionProcedure[index];
      try {
        const generation = await this.llm.generate({
          settings: step.settings,
          systemPrompt: step.systemPrompt,
          userPrompt: step.userPrompt,
          contextMessages: [],
          jsonSchema: claudeDecisionJsonSchema,
          trace: {
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId,
            source: "voice_reply_decision",
            event: step.label
          }
        });
        const raw = String(generation?.text || "").trim();
        const parsed = parseVoiceDecisionContract(raw);
        if (parsed.confident) {
          const resolvedProvider = generation?.provider || llmProvider;
          const resolvedModel = generation?.model || step?.settings?.llm?.model || llmModel;
          return {
            allow: parsed.allow,
            reason: parsed.allow ? (index === 0 ? "llm_yes" : "llm_yes_retry") : index === 0 ? "llm_no" : "llm_no_retry",
            participantCount,
            directAddressed,
            transcript: normalizedTranscript,
            llmResponse: raw,
            llmProvider: resolvedProvider,
            llmModel: resolvedModel
          };
        }

        invalidOutputs.push({
          step: step.label,
          text: raw || "(empty)"
        });
        break;
      } catch (error) {
        generationErrors.push({
          step: step.label,
          error: String(error?.message || error)
        });
      }
    }

    if (!invalidOutputs.length && generationErrors.length) {
      return {
        allow: false,
        reason: "llm_error",
        participantCount,
        directAddressed,
        transcript: normalizedTranscript,
        llmProvider,
        llmModel,
        error: generationErrors.map((row) => `${row.step}: ${row.error}`).join(" | ")
      };
    }

    return {
      allow: false,
      reason: "llm_contract_violation",
      participantCount,
      directAddressed,
      transcript: normalizedTranscript,
      llmResponse: invalidOutputs.map((row) => `${row.step}=${row.text}`).join(" | "),
      llmProvider,
      llmModel,
      error: generationErrors.length
        ? generationErrors.map((row) => `${row.step}: ${row.error}`).join(" | ")
        : undefined
    };
  }

  formatVoiceDecisionHistory(session, maxTurns = 6) {
    const turns = Array.isArray(session?.recentVoiceTurns) ? session.recentVoiceTurns : [];
    if (!turns.length) return "";
    return turns
      .slice(-Math.max(1, Number(maxTurns) || 6))
      .map((turn) => {
        const role = turn?.role === "assistant" ? "assistant" : "user";
        const text = normalizeVoiceText(turn?.text || "", VOICE_DECIDER_HISTORY_MAX_CHARS);
        if (!text) return "";
        const speaker =
          role === "assistant"
            ? getPromptBotName(session?.settingsSnapshot || this.store.getSettings())
            : String(turn?.speakerName || "someone").trim() || "someone";
        return `${speaker}: "${text}"`;
      })
      .filter(Boolean)
      .join("\n");
  }

  recordVoiceTurn(session, { role = "user", userId = null, text = "" } = {}) {
    if (!session || session.ending) return;
    const normalizedText = normalizeVoiceText(text, VOICE_DECIDER_HISTORY_MAX_CHARS);
    if (!normalizedText) return;

    const normalizedRole = role === "assistant" ? "assistant" : "user";
    const normalizedUserId = String(userId || "").trim() || null;
    const turns = Array.isArray(session.recentVoiceTurns) ? session.recentVoiceTurns : [];
    const speakerName =
      normalizedRole === "assistant"
        ? getPromptBotName(session.settingsSnapshot || this.store.getSettings())
        : this.resolveVoiceSpeakerName(session, normalizedUserId) || "someone";
    const previous = turns[turns.length - 1];
    if (
      previous &&
      previous.role === normalizedRole &&
      String(previous.userId || "") === String(normalizedUserId || "") &&
      String(previous.text || "") === normalizedText
    ) {
      return;
    }

    session.recentVoiceTurns = [
      ...turns,
      {
        role: normalizedRole,
        userId: normalizedUserId,
        speakerName: String(speakerName || "").trim() || "someone",
        text: normalizedText,
        at: Date.now()
      }
    ].slice(-VOICE_DECIDER_HISTORY_MAX_TURNS);
  }

  updateFocusedSpeakerWindow({
    session = null,
    userId = null,
    allow = false,
    directAddressed = false,
    reason = ""
  } = {}) {
    if (!session || session.ending) return;
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return;

    const now = Date.now();
    if (
      Boolean(allow) &&
      (Boolean(directAddressed) || String(reason || "") === "focused_speaker_followup")
    ) {
      session.focusedSpeakerUserId = normalizedUserId;
      session.focusedSpeakerAt = now;
      return;
    }
    if (Boolean(directAddressed) && String(reason || "") === "bot_turn_open") {
      session.focusedSpeakerUserId = normalizedUserId;
      session.focusedSpeakerAt = now;
      return;
    }

    if (now - Number(session.focusedSpeakerAt || 0) > FOCUSED_SPEAKER_CONTINUATION_MS) {
      session.focusedSpeakerUserId = null;
      session.focusedSpeakerAt = 0;
    }
  }

  countHumanVoiceParticipants(session) {
    const guild = this.client.guilds.cache.get(String(session?.guildId || ""));
    const voiceChannelId = String(session?.voiceChannelId || "");
    if (!guild || !voiceChannelId) return 1;

    const channel = guild.channels?.cache?.get(voiceChannelId) || null;
    if (channel?.members && typeof channel.members.forEach === "function") {
      let count = 0;
      channel.members.forEach((member) => {
        if (!member?.user?.bot) count += 1;
      });
      return Math.max(0, count);
    }

    if (guild.members?.cache) {
      let count = 0;
      guild.members.cache.forEach((member) => {
        if (member?.user?.bot) return;
        if (String(member?.voice?.channelId || "") !== voiceChannelId) return;
        count += 1;
      });
      return Math.max(0, count);
    }

    return 1;
  }

  async prepareOpenAiRealtimeTurnContext({ session, settings, userId, transcript = "", captureReason: _captureReason = "stream_end" }) {
    if (!session || session.ending) return;
    if (session.mode !== "openai_realtime") return;

    const normalizedTranscript = normalizeVoiceText(transcript, REALTIME_CONTEXT_TRANSCRIPT_MAX_CHARS);
    const memorySlice = await this.buildOpenAiRealtimeMemorySlice({
      session,
      settings,
      userId,
      transcript: normalizedTranscript
    });

    await this.refreshOpenAiRealtimeInstructions({
      session,
      settings,
      reason: "turn_context",
      speakerUserId: userId,
      transcript: normalizedTranscript,
      memorySlice
    });
  }

  async buildOpenAiRealtimeMemorySlice({ session, settings, userId, transcript = "" }) {
    const empty = {
      userFacts: [],
      relevantFacts: []
    };

    if (!settings?.memory?.enabled) return empty;
    if (!this.memory || typeof this.memory !== "object") return empty;

    const normalizedUserId = String(userId || "").trim();
    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedUserId || !normalizedTranscript) return empty;

    if (typeof this.memory.buildPromptMemorySlice !== "function") {
      return empty;
    }

    try {
      const slice = await this.memory.buildPromptMemorySlice({
        userId: normalizedUserId,
        guildId: session.guildId,
        channelId: session.textChannelId,
        queryText: normalizedTranscript,
        settings,
        trace: {
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: normalizedUserId,
          source: "voice_realtime_instruction_context"
        }
      });

      return {
        userFacts: Array.isArray(slice?.userFacts) ? slice.userFacts : [],
        relevantFacts: Array.isArray(slice?.relevantFacts) ? slice.relevantFacts : []
      };
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: normalizedUserId,
        content: `voice_realtime_memory_slice_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
      return empty;
    }
  }

  scheduleOpenAiRealtimeInstructionRefresh({
    session,
    settings,
    reason = "voice_context_refresh",
    speakerUserId = null,
    transcript = "",
    memorySlice = null
  }) {
    if (!session || session.ending) return;
    if (session.mode !== "openai_realtime") return;

    if (session.realtimeInstructionRefreshTimer) {
      clearTimeout(session.realtimeInstructionRefreshTimer);
      session.realtimeInstructionRefreshTimer = null;
    }

    session.realtimeInstructionRefreshTimer = setTimeout(() => {
      session.realtimeInstructionRefreshTimer = null;
      this.refreshOpenAiRealtimeInstructions({
        session,
        settings: settings || session.settingsSnapshot || this.store.getSettings(),
        reason,
        speakerUserId,
        transcript,
        memorySlice
      }).catch(() => undefined);
    }, REALTIME_INSTRUCTION_REFRESH_DEBOUNCE_MS);
  }

  async refreshOpenAiRealtimeInstructions({
    session,
    settings,
    reason = "voice_context_refresh",
    speakerUserId = null,
    transcript = "",
    memorySlice = null
  }) {
    if (!session || session.ending) return;
    if (session.mode !== "openai_realtime") return;
    if (!session.realtimeClient || typeof session.realtimeClient.updateInstructions !== "function") return;

    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    const instructions = this.buildOpenAiRealtimeInstructions({
      session,
      settings: resolvedSettings,
      speakerUserId,
      transcript,
      memorySlice
    });
    if (!instructions) return;
    if (instructions === session.lastOpenAiRealtimeInstructions) return;

    try {
      session.realtimeClient.updateInstructions(instructions);
      session.lastOpenAiRealtimeInstructions = instructions;
      session.lastOpenAiRealtimeInstructionsAt = Date.now();

      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "openai_realtime_instructions_updated",
        metadata: {
          sessionId: session.id,
          reason: String(reason || "voice_context_refresh"),
          speakerUserId: speakerUserId ? String(speakerUserId) : null,
          participantCount: this.getVoiceChannelParticipants(session).length,
          transcriptChars: transcript ? String(transcript).length : 0,
          userFactCount: Array.isArray(memorySlice?.userFacts) ? memorySlice.userFacts.length : 0,
          relevantFactCount: Array.isArray(memorySlice?.relevantFacts) ? memorySlice.relevantFacts.length : 0,
          instructionsChars: instructions.length
        }
      });
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `openai_realtime_instruction_update_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          reason: String(reason || "voice_context_refresh")
        }
      });
    }
  }

  buildOpenAiRealtimeInstructions({ session, settings, speakerUserId = null, transcript = "", memorySlice = null }) {
    const baseInstructions = String(session?.baseVoiceInstructions || this.buildVoiceInstructions(settings)).trim();
    const speakerName = this.resolveVoiceSpeakerName(session, speakerUserId);
    const normalizedTranscript = normalizeVoiceText(transcript, REALTIME_CONTEXT_TRANSCRIPT_MAX_CHARS);
    const participants = this.getVoiceChannelParticipants(session);
    const guild = this.client.guilds.cache.get(String(session?.guildId || "")) || null;
    const voiceChannel = guild?.channels?.cache?.get(String(session?.voiceChannelId || "")) || null;
    const roster =
      participants.length > 0
        ? participants
            .slice(0, REALTIME_CONTEXT_MEMBER_LIMIT)
            .map((participant) => participant.displayName)
            .join(", ")
        : "unknown";
    const userFacts = formatRealtimeMemoryFacts(memorySlice?.userFacts, REALTIME_MEMORY_FACT_LIMIT);
    const relevantFacts = formatRealtimeMemoryFacts(memorySlice?.relevantFacts, REALTIME_MEMORY_FACT_LIMIT);

    const sections = [baseInstructions];
    sections.push(
      [
        "Live server context:",
        `- Server: ${String(guild?.name || "unknown").trim() || "unknown"}`,
        `- Voice channel: ${String(voiceChannel?.name || "unknown").trim() || "unknown"}`,
        `- Humans currently in channel: ${roster}`
      ].join("\n")
    );

    if (speakerName || normalizedTranscript) {
      sections.push(
        [
          "Current turn context:",
          speakerName ? `- Active speaker: ${speakerName}` : null,
          normalizedTranscript ? `- Latest speaker transcript: ${normalizedTranscript}` : null
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    if (userFacts || relevantFacts) {
      sections.push(
        [
          "Durable memory context:",
          userFacts ? `- Known facts about active speaker: ${userFacts}` : null,
          relevantFacts ? `- Other relevant memory: ${relevantFacts}` : null
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    return sections.join("\n\n").slice(0, 5200);
  }

  getVoiceChannelParticipants(session) {
    const guild = this.client.guilds.cache.get(String(session?.guildId || ""));
    const voiceChannelId = String(session?.voiceChannelId || "");
    if (!guild || !voiceChannelId) return [];

    const channel = guild.channels?.cache?.get(voiceChannelId) || null;
    if (!channel?.members || typeof channel.members.forEach !== "function") return [];

    const participants = [];
    channel.members.forEach((member) => {
      if (!member || member.user?.bot) return;
      const displayName = String(member.displayName || member.user?.globalName || member.user?.username || "").trim();
      if (!displayName) return;
      participants.push({
        userId: String(member.id || ""),
        displayName
      });
    });

    return participants.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  resolveVoiceSpeakerName(session, userId) {
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return "";

    const participants = this.getVoiceChannelParticipants(session);
    const inChannel = participants.find((participant) => participant.userId === normalizedUserId);
    if (inChannel?.displayName) return inChannel.displayName;

    const guild = this.client.guilds.cache.get(String(session?.guildId || "")) || null;
    const guildName =
      guild?.members?.cache?.get(normalizedUserId)?.displayName ||
      guild?.members?.cache?.get(normalizedUserId)?.user?.globalName ||
      guild?.members?.cache?.get(normalizedUserId)?.user?.username ||
      null;
    if (guildName) return String(guildName);

    const userName = this.client.users?.cache?.get(normalizedUserId)?.username || "";
    return String(userName || "").trim();
  }

  queueSttPipelineTurn({ session, userId, pcmBuffer, captureReason = "stream_end" }) {
    if (!session || session.ending) return;
    if (session.mode !== "stt_pipeline") return;
    if (!pcmBuffer || !pcmBuffer.length) return;

    session.pendingSttTurns = Number(session.pendingSttTurns || 0) + 1;
    const chain = Promise.resolve(session.sttTurnChain || Promise.resolve());
    session.sttTurnChain = chain
      .catch(() => undefined)
      .then(async () => {
        await this.runSttPipelineTurn({
          session,
          userId,
          pcmBuffer,
          captureReason
        });
      })
      .catch((error) => {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          content: `stt_pipeline_turn_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id
          }
        });
      })
      .finally(() => {
        session.pendingSttTurns = Math.max(0, Number(session.pendingSttTurns || 0) - 1);
      });
  }

  async runSttPipelineTurn({ session, userId, pcmBuffer, captureReason = "stream_end" }) {
    if (!session || session.ending) return;
    if (session.mode !== "stt_pipeline") return;
    if (!pcmBuffer?.length) return;
    if (!this.llm?.transcribeAudio || !this.llm?.synthesizeSpeech) return;

    const settings = session.settingsSnapshot || this.store.getSettings();
    const sttSettings = settings?.voice?.sttPipeline || {};
    const transcriptionModel =
      String(sttSettings?.transcriptionModel || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
    const transcript = await this.transcribePcmTurn({
      session,
      userId,
      pcmBuffer,
      model: transcriptionModel,
      captureReason
    });
    if (!transcript) return;
    if (session.ending) return;

    this.touchActivity(session.guildId, settings);
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "stt_pipeline_transcript",
      metadata: {
        sessionId: session.id,
        captureReason: String(captureReason || "stream_end"),
        transcript
      }
    });
    this.recordVoiceTurn(session, {
      role: "user",
      userId,
      text: transcript
    });

    this.queueVoiceMemoryIngest({
      session,
      settings,
      userId,
      transcript,
      source: "voice_stt_pipeline_ingest",
      captureReason,
      errorPrefix: "voice_stt_memory_ingest_failed"
    });

    const turnDecision = await this.evaluateVoiceReplyDecision({
      session,
      settings,
      userId,
      transcript,
      source: "stt_pipeline"
    });
    this.updateFocusedSpeakerWindow({
      session,
      userId,
      allow: Boolean(turnDecision.allow),
      directAddressed: Boolean(turnDecision.directAddressed),
      reason: turnDecision.reason
    });

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "voice_turn_addressing",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        source: "stt_pipeline",
        captureReason: String(captureReason || "stream_end"),
        allow: Boolean(turnDecision.allow),
        reason: turnDecision.reason,
        participantCount: Number(turnDecision.participantCount || 0),
        directAddressed: Boolean(turnDecision.directAddressed),
        transcript: turnDecision.transcript || transcript || null,
        llmResponse: turnDecision.llmResponse || null,
        llmProvider: turnDecision.llmProvider || null,
        llmModel: turnDecision.llmModel || null,
        error: turnDecision.error || null
      }
    });
    if (!turnDecision.allow) {
      if (turnDecision.reason === "bot_turn_open") {
        this.queueDeferredBotTurnOpenTurn({
          session,
          userId,
          transcript: turnDecision.transcript || transcript,
          captureReason,
          source: "stt_pipeline",
          directAddressed: Boolean(turnDecision.directAddressed)
        });
      }
      return;
    }

    await this.runSttPipelineReply({
      session,
      settings,
      userId,
      transcript,
      directAddressed: Boolean(turnDecision.directAddressed)
    });
  }

  async runSttPipelineReply({ session, settings, userId, transcript, directAddressed = false }) {
    if (!session || session.ending) return;
    if (session.mode !== "stt_pipeline") return;
    if (!this.llm?.synthesizeSpeech) return;
    if (typeof this.generateVoiceTurn !== "function") return;

    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedTranscript) return;
    const contextMessages = Array.isArray(session.sttContextMessages)
      ? session.sttContextMessages
          .filter((row) => row && typeof row === "object")
          .map((row) => ({
            role: row.role === "assistant" ? "assistant" : "user",
            content: normalizeVoiceText(row.content, STT_REPLY_MAX_CHARS)
          }))
          .filter((row) => row.content)
          .slice(-STT_CONTEXT_MAX_MESSAGES)
      : [];
    const soundboardCandidateInfo = await this.resolveSoundboardCandidates({
      session,
      settings
    });
    const soundboardCandidateLines = (Array.isArray(soundboardCandidateInfo?.candidates)
      ? soundboardCandidateInfo.candidates
      : []
    )
      .map((entry) => formatSoundboardCandidateLine(entry))
      .filter(Boolean)
      .slice(0, SOUNDBOARD_MAX_CANDIDATES);

    let replyText = "";
    let requestedSoundboardRef = "";
    let usedWebSearchFollowup = false;
    let releaseLookupBusy = null;
    try {
      const generated = await this.generateVoiceTurn({
        settings,
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        transcript: normalizedTranscript,
        contextMessages,
        sessionId: session.id,
        isEagerTurn: !directAddressed,
        voiceEagerness: Number(settings?.voice?.replyEagerness) || 0,
        soundboardCandidates: soundboardCandidateLines,
        onWebLookupStart: async ({ query }) => {
          if (typeof releaseLookupBusy === "function") return;
          releaseLookupBusy = this.beginVoiceWebLookupBusy({
            session,
            settings,
            userId,
            query,
            source: "stt_pipeline_web_lookup"
          });
        },
        onWebLookupComplete: async () => {
          if (typeof releaseLookupBusy !== "function") return;
          releaseLookupBusy();
          releaseLookupBusy = null;
        },
        webSearchTimeoutMs: Number(settings?.voice?.webSearchTimeoutMs)
      });
      const generatedPayload =
        generated && typeof generated === "object"
          ? generated
          : {
              text: generated,
              soundboardRef: null,
              usedWebSearchFollowup: false
            };
      replyText = normalizeVoiceText(generatedPayload?.text || "", STT_REPLY_MAX_CHARS);
      requestedSoundboardRef = String(generatedPayload?.soundboardRef || "").trim().slice(0, 180);
      usedWebSearchFollowup = Boolean(generatedPayload?.usedWebSearchFollowup);
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: `stt_pipeline_generation_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
      return;
    } finally {
      if (typeof releaseLookupBusy === "function") {
        releaseLookupBusy();
        releaseLookupBusy = null;
      }
    }
    if (!replyText || session.ending) return;

    session.sttContextMessages = [
      ...contextMessages,
      {
        role: "user",
        content: normalizedTranscript
      },
      {
        role: "assistant",
        content: replyText
      }
    ].slice(-STT_CONTEXT_MAX_MESSAGES);

    const spokeLine = await this.speakVoiceLineWithTts({
      session,
      settings,
      text: replyText,
      source: "voice_stt_pipeline_tts"
    });
    if (!spokeLine) return;

    try {
      session.lastAudioDeltaAt = Date.now();
      this.recordVoiceTurn(session, {
        role: "assistant",
        userId: this.client.user?.id || null,
        text: replyText
      });
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "stt_pipeline_reply_spoken",
        metadata: {
          sessionId: session.id,
          replyText,
          soundboardRef: requestedSoundboardRef || null,
          usedWebSearchFollowup
        }
      });
      if (requestedSoundboardRef) {
        await this.maybeTriggerAssistantDirectedSoundboard({
          session,
          settings,
          userId: this.client.user?.id || null,
          transcript: replyText,
          requestedRef: requestedSoundboardRef,
          source: "stt_pipeline_reply"
        });
      }
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `stt_pipeline_audio_write_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
    }
  }

  shouldAttemptRealtimeWebLookup({ settings, transcript = "" }) {
    if (!settings?.webSearch?.enabled) return false;
    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedTranscript) return false;
    if (isLowSignalVoiceFragment(normalizedTranscript)) return false;
    if (/\?/.test(normalizedTranscript)) return true;
    return /\b(?:latest|news|today|current|price|weather|update|lookup|search|who|what|when|where|why|how)\b/i.test(
      normalizedTranscript
    );
  }

  async maybeHandleRealtimeWebLookupReply({
    session,
    settings,
    userId,
    transcript = "",
    directAddressed = false
  }) {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode)) return false;
    if (typeof this.generateVoiceTurn !== "function") return false;
    if (!this.shouldAttemptRealtimeWebLookup({ settings, transcript })) return false;

    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedTranscript) return false;
    const contextMessages = Array.isArray(session.recentVoiceTurns)
      ? session.recentVoiceTurns
          .filter((row) => row && typeof row === "object")
          .map((row) => ({
            role: row.role === "assistant" ? "assistant" : "user",
            content: normalizeVoiceText(row.text, STT_REPLY_MAX_CHARS)
          }))
          .filter((row) => row.content)
          .slice(-STT_CONTEXT_MAX_MESSAGES)
      : [];
    const soundboardCandidateInfo = await this.resolveSoundboardCandidates({
      session,
      settings
    });
    const soundboardCandidateLines = (Array.isArray(soundboardCandidateInfo?.candidates)
      ? soundboardCandidateInfo.candidates
      : []
    )
      .map((entry) => formatSoundboardCandidateLine(entry))
      .filter(Boolean)
      .slice(0, SOUNDBOARD_MAX_CANDIDATES);

    let releaseLookupBusy = null;
    let generatedPayload = null;
    try {
      const generated = await this.generateVoiceTurn({
        settings,
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        transcript: normalizedTranscript,
        contextMessages,
        sessionId: session.id,
        isEagerTurn: !directAddressed,
        voiceEagerness: Number(settings?.voice?.replyEagerness) || 0,
        soundboardCandidates: soundboardCandidateLines,
        onWebLookupStart: async ({ query }) => {
          if (typeof releaseLookupBusy === "function") return;
          releaseLookupBusy = this.beginVoiceWebLookupBusy({
            session,
            settings,
            userId,
            query,
            source: "realtime_web_lookup"
          });
        },
        onWebLookupComplete: async () => {
          if (typeof releaseLookupBusy !== "function") return;
          releaseLookupBusy();
          releaseLookupBusy = null;
        },
        webSearchTimeoutMs: Number(settings?.voice?.webSearchTimeoutMs)
      });
      generatedPayload =
        generated && typeof generated === "object"
          ? generated
          : {
              text: generated,
              soundboardRef: null,
              usedWebSearchFollowup: false
            };
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: `realtime_web_lookup_generation_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
      return false;
    } finally {
      if (typeof releaseLookupBusy === "function") {
        releaseLookupBusy();
      }
    }

    if (!generatedPayload?.usedWebSearchFollowup) return false;
    const replyText = normalizeVoiceText(generatedPayload?.text || "", STT_REPLY_MAX_CHARS);
    const requestedSoundboardRef = String(generatedPayload?.soundboardRef || "").trim().slice(0, 180);
    if (!replyText) return true;

    const requestedRealtimeUtterance = this.requestRealtimeTextUtterance({
      session,
      text: replyText,
      userId: this.client.user?.id || null,
      source: "realtime_web_lookup_reply"
    });
    if (!requestedRealtimeUtterance) {
      const spokeFallback = await this.speakVoiceLineWithTts({
        session,
        settings,
        text: replyText,
        source: "realtime_web_lookup_tts"
      });
      if (!spokeFallback) return false;
      session.lastAudioDeltaAt = Date.now();
    }

    this.recordVoiceTurn(session, {
      role: "assistant",
      userId: this.client.user?.id || null,
      text: replyText
    });
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.client.user?.id || null,
      content: "realtime_web_lookup_reply_requested",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        replyText,
        soundboardRef: requestedSoundboardRef || null
      }
    });

    if (requestedSoundboardRef) {
      await this.maybeTriggerAssistantDirectedSoundboard({
        session,
        settings,
        userId: this.client.user?.id || null,
        transcript: replyText,
        requestedRef: requestedSoundboardRef,
        source: "realtime_web_lookup_reply"
      });
    }

    return true;
  }

  async transcribePcmTurn({
    session,
    userId,
    pcmBuffer,
    model,
    sampleRateHz = 24000,
    captureReason = "stream_end",
    traceSource = "voice_stt_pipeline_turn",
    errorPrefix = "stt_pipeline_transcription_failed"
  }) {
    if (!this.llm?.transcribeAudio || !pcmBuffer?.length) return "";
    const resolvedModel = String(model || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-voice-stt-"));
    const wavPath = path.join(tempDir, "turn.wav");
    try {
      await fs.writeFile(wavPath, encodePcm16MonoAsWav(pcmBuffer, sampleRateHz));
      const transcript = await this.llm.transcribeAudio({
        filePath: wavPath,
        model: resolvedModel,
        trace: {
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          source: String(traceSource || "voice_stt_pipeline_turn")
        }
      });
      return normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: `${String(errorPrefix || "stt_pipeline_transcription_failed")}: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          model: resolvedModel,
          captureReason: String(captureReason || "stream_end")
        }
      });
      return "";
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  scheduleResponseFromBufferedAudio({ session, userId = null }) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;

    if (session.responseFlushTimer) {
      clearTimeout(session.responseFlushTimer);
    }

    session.responseFlushTimer = setTimeout(() => {
      session.responseFlushTimer = null;
      this.flushResponseFromBufferedAudio({ session, userId });
    }, RESPONSE_FLUSH_DEBOUNCE_MS);
  }

  flushResponseFromBufferedAudio({ session, userId = null }) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;

    const now = Date.now();
    const msSinceLastRequest = now - Number(session.lastResponseRequestAt || 0);
    if (msSinceLastRequest < MIN_RESPONSE_REQUEST_GAP_MS) {
      const waitMs = Math.max(20, MIN_RESPONSE_REQUEST_GAP_MS - msSinceLastRequest);
      session.responseFlushTimer = setTimeout(() => {
        session.responseFlushTimer = null;
        this.flushResponseFromBufferedAudio({ session, userId });
      }, waitMs);
      return;
    }

    // Don't commit/request while users are still actively streaming audio chunks.
    // This avoids partial-turn commits that can return no-audio responses.
    if (session.userCaptures.size > 0) {
      this.scheduleResponseFromBufferedAudio({ session, userId });
      return;
    }

    // Keep one tracked assistant response in flight at a time.
    if (session.pendingResponse) {
      const pending = session.pendingResponse;
      const pendingRequestedAt = Number(pending.requestedAt || 0);
      const pendingAgeMs = pendingRequestedAt ? now - pendingRequestedAt : 0;
      const hasNewerInboundAudio = Number(session.lastInboundAudioAt || 0) > pendingRequestedAt;

      if (!hasNewerInboundAudio || pendingAgeMs < PENDING_SUPERSEDE_MIN_AGE_MS) {
        this.scheduleResponseFromBufferedAudio({
          session,
          userId: pending.userId || userId
        });
        return;
      }

      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "pending_response_superseded",
        metadata: {
          sessionId: session.id,
          requestId: pending.requestId,
          source: pending.source || null,
          pendingAgeMs
        }
      });
      this.clearPendingResponse(session);
    }

    const pendingInputBytes = Math.max(0, Number(session.pendingRealtimeInputBytes || 0));
    const minCommitBytes = getRealtimeCommitMinimumBytes(
      session.mode,
      Number(session.realtimeInputSampleRateHz) || 24000
    );
    if (pendingInputBytes < minCommitBytes) {
      return;
    }

    if (this.getRealtimeTurnBacklogSize(session) > 0) {
      this.scheduleResponseFromBufferedAudio({ session, userId });
      return;
    }

    if (this.isOpenAiRealtimeResponseActive(session)) {
      session.responseFlushTimer = setTimeout(() => {
        session.responseFlushTimer = null;
        this.flushResponseFromBufferedAudio({ session, userId });
      }, OPENAI_ACTIVE_RESPONSE_RETRY_MS);
      return;
    }

    try {
      session.realtimeClient.commitInputAudioBuffer();
      session.pendingRealtimeInputBytes = 0;
      const created = this.createTrackedAudioResponse({
        session,
        userId,
        source: "turn_flush",
        resetRetryState: true,
        emitCreateEvent: session.mode !== "openai_realtime"
      });
      if (!created) {
        this.scheduleResponseFromBufferedAudio({ session, userId });
      }
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: `audio_commit_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
    }
  }

  createTrackedAudioResponse({
    session,
    userId = null,
    source = "turn_flush",
    resetRetryState = false,
    emitCreateEvent = true
  }) {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode)) return false;
    if (emitCreateEvent && this.isOpenAiRealtimeResponseActive(session)) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "response_create_skipped_active_response",
        metadata: {
          sessionId: session.id,
          source: String(source || "turn_flush")
        }
      });
      return false;
    }
    if (emitCreateEvent) {
      session.realtimeClient.createAudioResponse();
    }

    const now = Date.now();
    const requestId = Number(session.nextResponseRequestId || 0) + 1;
    session.nextResponseRequestId = requestId;
    const previous = session.pendingResponse;

    session.pendingResponse = {
      requestId,
      userId: userId || previous?.userId || null,
      requestedAt: now,
      retryCount: resetRetryState ? 0 : Number(previous?.retryCount || 0),
      hardRecoveryAttempted: resetRetryState ? false : Boolean(previous?.hardRecoveryAttempted),
      source: String(source || "turn_flush"),
      handlingSilence: false,
      audioReceivedAt: 0
    };
    session.lastResponseRequestAt = now;
    this.clearResponseSilenceTimers(session);
    this.armResponseSilenceWatchdog({
      session,
      requestId,
      userId: session.pendingResponse.userId
    });
    return true;
  }

  pendingResponseHasAudio(session, pendingResponse = session?.pendingResponse) {
    if (!session || !pendingResponse) return false;
    const requestedAt = Number(pendingResponse.requestedAt || 0);
    if (!requestedAt) return false;
    return Number(session.lastAudioDeltaAt || 0) >= requestedAt;
  }

  clearResponseSilenceTimers(session) {
    if (!session) return;
    if (session.responseWatchdogTimer) {
      clearTimeout(session.responseWatchdogTimer);
      session.responseWatchdogTimer = null;
    }
    if (session.responseDoneGraceTimer) {
      clearTimeout(session.responseDoneGraceTimer);
      session.responseDoneGraceTimer = null;
    }
  }

  clearPendingResponse(session) {
    if (!session) return;
    this.clearResponseSilenceTimers(session);
    session.pendingResponse = null;
  }

  isOpenAiRealtimeResponseActive(session) {
    if (!session || session.mode !== "openai_realtime") return false;
    const checker = session.realtimeClient?.isResponseInProgress;
    if (typeof checker !== "function") return false;
    try {
      return Boolean(checker.call(session.realtimeClient));
    } catch {
      return false;
    }
  }

  armResponseSilenceWatchdog({ session, requestId, userId = null }) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;
    if (!Number.isFinite(Number(requestId)) || Number(requestId) <= 0) return;

    if (session.responseWatchdogTimer) {
      clearTimeout(session.responseWatchdogTimer);
    }

    session.responseWatchdogTimer = setTimeout(() => {
      session.responseWatchdogTimer = null;
      if (!session || session.ending) return;
      const pending = session.pendingResponse;
      if (!pending) return;
      if (Number(pending.requestId || 0) !== Number(requestId)) return;
      if (this.pendingResponseHasAudio(session, pending)) {
        this.clearPendingResponse(session);
        return;
      }
      this.handleSilentResponse({
        session,
        userId: pending.userId || userId,
        trigger: "watchdog"
      }).catch(() => undefined);
    }, RESPONSE_SILENCE_RETRY_DELAY_MS);
  }

  async handleSilentResponse({
    session,
    userId = null,
    trigger = "watchdog",
    responseId = null,
    responseStatus = null
  }) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;
    const pending = session.pendingResponse;
    if (!pending) return;
    if (pending.handlingSilence) return;
    if (this.pendingResponseHasAudio(session, pending)) {
      this.clearPendingResponse(session);
      return;
    }

    const pendingRequestedAt = Number(pending.requestedAt || 0);
    const hasNewerInboundAudio = Number(session.lastInboundAudioAt || 0) > pendingRequestedAt;
    if (hasNewerInboundAudio) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "pending_response_replaced_by_newer_input",
        metadata: {
          sessionId: session.id,
          requestId: pending.requestId,
          source: pending.source || null
        }
      });
      this.clearPendingResponse(session);
      this.scheduleResponseFromBufferedAudio({
        session,
        userId: pending.userId || userId
      });
      return;
    }

    pending.handlingSilence = true;
    this.clearResponseSilenceTimers(session);

    if (session.userCaptures.size > 0) {
      pending.handlingSilence = false;
      this.armResponseSilenceWatchdog({
        session,
        requestId: pending.requestId,
        userId: pending.userId || userId
      });
      return;
    }

    const resolvedUserId = pending.userId || userId || this.client.user?.id || null;
    const setHandlingDone = () => {
      const active = session.pendingResponse;
      if (active && Number(active.requestId || 0) === Number(pending.requestId || 0)) {
        active.handlingSilence = false;
      }
    };

    if (pending.retryCount < MAX_RESPONSE_SILENCE_RETRIES) {
      pending.retryCount += 1;
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: resolvedUserId,
        content: "response_silent_retry",
        metadata: {
          sessionId: session.id,
          requestId: pending.requestId,
          retryCount: pending.retryCount,
          maxRetries: MAX_RESPONSE_SILENCE_RETRIES,
          responseRequestedAt: pending.requestedAt,
          trigger,
          responseId,
          responseStatus
        }
      });

      try {
        const created = this.createTrackedAudioResponse({
          session,
          userId: resolvedUserId,
          source: "silent_retry",
          resetRetryState: false
        });
        if (!created) {
          this.armResponseSilenceWatchdog({
            session,
            requestId: pending.requestId,
            userId: pending.userId || userId
          });
        }
      } catch (error) {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: resolvedUserId,
          content: `response_retry_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id,
            requestId: pending.requestId
          }
        });
        this.clearPendingResponse(session);
        await this.endSession({
          guildId: session.guildId,
          reason: "response_stalled",
          announcement: "voice output stalled and stayed silent, leaving vc.",
          settings: session.settingsSnapshot
        });
      } finally {
        setHandlingDone();
      }
      return;
    }

    if (!pending.hardRecoveryAttempted) {
      pending.hardRecoveryAttempted = true;
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: resolvedUserId,
        content: "response_silent_hard_recovery",
        metadata: {
          sessionId: session.id,
          requestId: pending.requestId,
          retryCount: pending.retryCount,
          trigger,
          responseId,
          responseStatus
        }
      });

      try {
        const pendingInputBytes = Math.max(0, Number(session.pendingRealtimeInputBytes || 0));
        const minCommitBytes = getRealtimeCommitMinimumBytes(
          session.mode,
          Number(session.realtimeInputSampleRateHz) || 24000
        );
        if (pendingInputBytes >= minCommitBytes) {
          session.realtimeClient.commitInputAudioBuffer();
          session.pendingRealtimeInputBytes = 0;
        }
        const created = this.createTrackedAudioResponse({
          session,
          userId: resolvedUserId,
          source: "hard_recovery",
          resetRetryState: false
        });
        if (!created) {
          this.armResponseSilenceWatchdog({
            session,
            requestId: pending.requestId,
            userId: pending.userId || userId
          });
        }
      } catch (error) {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: resolvedUserId,
          content: `response_hard_recovery_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id,
            requestId: pending.requestId
          }
        });
        this.clearPendingResponse(session);
        await this.endSession({
          guildId: session.guildId,
          reason: "response_stalled",
          announcement: "voice output stalled and stayed silent, leaving vc.",
          settings: session.settingsSnapshot
        });
      } finally {
        setHandlingDone();
      }
      return;
    }

    this.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: resolvedUserId,
      content: "response_silent_fallback",
      metadata: {
        sessionId: session.id,
        requestId: pending.requestId,
        retryCount: pending.retryCount,
        hardRecoveryAttempted: pending.hardRecoveryAttempted,
        trigger,
        responseId,
        responseStatus
      }
    });
    this.clearPendingResponse(session);
    // Drop this stuck turn and keep the VC session alive; a fresh user turn can recover.
  }

  async endSession({
    guildId,
    reason = "unknown",
    requestedByUserId = null,
    announceChannel = null,
    announcement = undefined,
    settings = null,
    messageId = null
  }) {
    const session = this.sessions.get(String(guildId));
    if (!session) return false;
    if (session.ending) return false;

    session.ending = true;
    this.sessions.delete(String(guildId));

    if (session.maxTimer) clearTimeout(session.maxTimer);
    if (session.inactivityTimer) clearTimeout(session.inactivityTimer);
    if (session.botTurnResetTimer) clearTimeout(session.botTurnResetTimer);
    if (session.botDisconnectTimer) clearTimeout(session.botDisconnectTimer);
    if (session.responseFlushTimer) clearTimeout(session.responseFlushTimer);
    if (session.responseWatchdogTimer) clearTimeout(session.responseWatchdogTimer);
    if (session.responseDoneGraceTimer) clearTimeout(session.responseDoneGraceTimer);
    if (session.realtimeInstructionRefreshTimer) clearTimeout(session.realtimeInstructionRefreshTimer);
    if (session.deferredTurnFlushTimer) clearTimeout(session.deferredTurnFlushTimer);
    session.pendingResponse = null;
    session.pendingRealtimeTurns = [];
    session.pendingDeferredTurns = [];
    this.clearAudioPlaybackQueue(session);

    for (const capture of session.userCaptures.values()) {
      try {
        capture.opusStream.destroy();
      } catch {
        // ignore
      }
      try {
        capture.decoder.destroy?.();
      } catch {
        // ignore
      }
      try {
        capture.pcmStream.destroy();
      } catch {
        // ignore
      }
    }
    session.userCaptures.clear();

    for (const cleanup of session.cleanupHandlers || []) {
      try {
        cleanup();
      } catch {
        // ignore
      }
    }

    try {
      session.botAudioStream?.end?.();
    } catch {
      // ignore
    }

    try {
      session.audioPlayer?.stop?.(true);
    } catch {
      // ignore
    }

    try {
      await session.realtimeClient?.close?.();
    } catch {
      // ignore
    }

    try {
      session.connection?.destroy?.();
    } catch {
      // ignore
    }

    const fallbackConnection = getVoiceConnection(String(guildId));
    if (fallbackConnection && fallbackConnection !== session.connection) {
      try {
        fallbackConnection.destroy();
      } catch {
        // ignore
      }
    }

    const durationSeconds = Math.max(0, Math.floor((Date.now() - session.startedAt) / 1000));
    this.store.logAction({
      kind: "voice_session_end",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: requestedByUserId || this.client.user?.id || null,
      content: reason,
      metadata: {
        sessionId: session.id,
        mode: session.mode || "voice_agent",
        voiceChannelId: session.voiceChannelId,
        durationSeconds,
        requestedByUserId
      }
    });

    const channel = announceChannel || this.client.channels.cache.get(session.textChannelId);
    if (announcement !== null) {
      const normalizedReason = String(reason || "")
        .trim()
        .toLowerCase();
      const mustNotify = normalizedReason !== "switch_channel" && normalizedReason !== "nl_leave";
      const announcementHint = String(announcement || "").trim();
      const details = {
        voiceChannelId: session.voiceChannelId,
        durationSeconds,
        announcementHint: announcementHint || null
      };
      await this.sendOperationalMessage({
        channel,
        settings: settings || session.settingsSnapshot,
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: requestedByUserId || this.client.user?.id || null,
        messageId,
        event: "voice_session_end",
        reason,
        details,
        mustNotify
      });
    }

    return true;
  }

  async handleVoiceStateUpdate(oldState, newState) {
    const botId = String(this.client.user?.id || "");
    if (!botId) return;

    const stateUserId = String(newState?.id || oldState?.id || "");
    const guildId = String(newState?.guild?.id || oldState?.guild?.id || "");
    if (!guildId) return;

    const session = this.sessions.get(guildId);
    if (!session) return;
    const oldChannelId = String(oldState?.channelId || "");
    const newChannelId = String(newState?.channelId || "");
    const sessionVoiceChannelId = String(session.voiceChannelId || "");

    if (stateUserId !== botId) {
      if (
        session.mode === "openai_realtime" &&
        sessionVoiceChannelId &&
        (oldChannelId === sessionVoiceChannelId || newChannelId === sessionVoiceChannelId)
      ) {
        this.scheduleOpenAiRealtimeInstructionRefresh({
          session,
          settings: session.settingsSnapshot,
          reason: "voice_membership_changed",
          speakerUserId: stateUserId
        });
      }
      return;
    }

    if (!newState?.channelId) {
      if (!session.botDisconnectTimer) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          content: "bot_disconnect_grace_started",
          metadata: {
            sessionId: session.id,
            graceMs: BOT_DISCONNECT_GRACE_MS
          }
        });
        session.botDisconnectTimer = setTimeout(() => {
          session.botDisconnectTimer = null;
          const liveSession = this.sessions.get(guildId);
          if (!liveSession || liveSession.ending) return;

          const guild = this.client.guilds.cache.get(guildId) || null;
          const liveChannelId = String(guild?.members?.me?.voice?.channelId || "").trim();
          if (liveChannelId) {
            liveSession.voiceChannelId = liveChannelId;
            liveSession.lastActivityAt = Date.now();
            this.scheduleOpenAiRealtimeInstructionRefresh({
              session: liveSession,
              settings: liveSession.settingsSnapshot,
              reason: "voice_channel_recovered"
            });
            this.store.logAction({
              kind: "voice_runtime",
              guildId,
              channelId: liveSession.textChannelId,
              userId: this.client.user?.id || null,
              content: "bot_disconnect_grace_resolved",
              metadata: {
                sessionId: liveSession.id,
                voiceChannelId: liveChannelId
              }
            });
            return;
          }

          this.endSession({
            guildId,
            reason: "bot_disconnected",
            announcement: "i got disconnected from vc.",
            settings: liveSession.settingsSnapshot
          }).catch(() => undefined);
        }, BOT_DISCONNECT_GRACE_MS);
      }
      return;
    }

    if (session.botDisconnectTimer) {
      clearTimeout(session.botDisconnectTimer);
      session.botDisconnectTimer = null;
      this.store.logAction({
        kind: "voice_runtime",
        guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "bot_disconnect_grace_cleared",
        metadata: {
          sessionId: session.id,
          voiceChannelId: String(newState.channelId)
        }
      });
    }

    if (String(newState.channelId) !== session.voiceChannelId) {
      session.voiceChannelId = String(newState.channelId);
      session.lastActivityAt = Date.now();
      this.scheduleOpenAiRealtimeInstructionRefresh({
        session,
        settings: session.settingsSnapshot,
        reason: "voice_channel_changed"
      });
    }
  }

  buildVoiceInstructions(settings, { soundboardCandidates = [] } = {}) {
    const botName = getPromptBotName(settings);
    const style = getPromptStyle(settings, "playful slang");
    const allowNsfwHumor = shouldAllowVoiceNsfwHumor(settings);
    const memoryEnabled = Boolean(settings?.memory?.enabled);
    const soundboardEnabled = Boolean(settings?.voice?.soundboard?.enabled);
    const soundboardCandidateLines = (Array.isArray(soundboardCandidates) ? soundboardCandidates : [])
      .map((entry) => formatSoundboardCandidateLine(entry))
      .filter(Boolean)
      .slice(0, SOUNDBOARD_MAX_CANDIDATES);
    const voiceToneGuardrails = buildVoiceToneGuardrails();
    const voiceGuidance = getPromptVoiceGuidance(settings, [
      "Talk like a person hanging out, not like an assistant.",
      "Use occasional slang naturally (not every sentence)."
    ]);
    const lines = [
      `You are ${botName}, a real-feeling regular in a Discord server, speaking in live voice chat.`,
      `Stay in-character as ${botName}. Style: ${style}.`,
      ...voiceGuidance,
      ...voiceToneGuardrails,
      allowNsfwHumor
        ? "Adult/NSFW humor is allowed for consenting adults, but never include minors, coercion, or targeted harassment."
        : "Keep humor non-sexual by default unless users explicitly request a safe toned-down joke.",
      getPromptCapabilityHonestyLine(settings),
      memoryEnabled
        ? getPromptMemoryEnabledLine(
            settings,
            "You have persistent memory across conversations via saved durable facts. Do not claim each conversation starts from zero."
          )
        : getPromptMemoryDisabledLine(settings),
      getPromptImpossibleActionLine(settings, "If asked to do something impossible, say it casually."),
      ...buildHardLimitsSection(settings, { maxItems: 12 })
    ];

    if (soundboardEnabled && soundboardCandidateLines.length) {
      lines.push("Soundboard control is enabled.");
      lines.push("Available sound refs:");
      lines.push(soundboardCandidateLines.join("\n"));
      lines.push(
        "If you want to trigger a soundboard effect, append exactly one trailing directive: [[SOUNDBOARD:<sound_ref>]] using an exact ref from the list."
      );
      lines.push("If no sound should play, omit that directive.");
      lines.push("Never mention or explain the directive in normal speech.");
    }

    return lines.join("\n");
  }

  async sendOperationalMessage({
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
    return await sendOperationalMessage(this, {
      channel,
      settings,
      guildId,
      channelId,
      userId,
      messageId,
      event,
      reason,
      details,
      mustNotify
    });
  }

  async resolveOperationalChannel(
    channel,
    channelId,
    { guildId = null, userId = null, messageId = null, event = null, reason = null } = {}
  ) {
    return await resolveOperationalChannel(this, channel, channelId, {
      guildId,
      userId,
      messageId,
      event,
      reason
    });
  }

  async sendToChannel(
    channel,
    text,
    { guildId = null, channelId = null, userId = null, messageId = null, event = null, reason = null } = {}
  ) {
    return await sendToChannel(this, channel, text, {
      guildId,
      channelId,
      userId,
      messageId,
      event,
      reason
    });
  }

  getMissingJoinPermissionInfo({ guild, voiceChannel }) {
    const me = guild?.members?.me;
    if (!me) {
      return {
        reason: "bot_member_unavailable",
        missingPermissions: []
      };
    }

    const perms = voiceChannel?.permissionsFor?.(me);
    const missingPermissions = [];
    if (!perms?.has(PermissionFlagsBits.Connect)) missingPermissions.push("CONNECT");
    if (!perms?.has(PermissionFlagsBits.Speak)) missingPermissions.push("SPEAK");
    if (!missingPermissions.length) return null;
    return {
      reason: "missing_voice_permissions",
      missingPermissions
    };
  }

}


export {
  parseVoiceDecisionContract,
  resolveRealtimeTurnTranscriptionPlan
} from "./voiceDecisionRuntime.ts";
