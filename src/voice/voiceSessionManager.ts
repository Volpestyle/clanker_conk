import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  StreamType,
  VoiceConnectionStatus
} from "@discordjs/voice";
import { PermissionFlagsBits } from "discord.js";
import prism from "prism-media";
import {
  buildVoiceToneGuardrails,
  buildHardLimitsSection,
  getPromptBotName,
  getPromptStyle,
  PROMPT_CAPABILITY_HONESTY_LINE
} from "../promptCore.ts";
import { clamp } from "../utils.ts";
import { convertDiscordPcmToXaiInput, convertXaiOutputToDiscordPcm } from "./pcmAudio.ts";
import { GeminiRealtimeClient } from "./geminiRealtimeClient.ts";
import { OpenAiRealtimeClient } from "./openaiRealtimeClient.ts";
import { SoundboardDirector } from "./soundboardDirector.ts";
import {
  REALTIME_MEMORY_FACT_LIMIT,
  SOUNDBOARD_MAX_CANDIDATES,
  dedupeSoundboardCandidates,
  defaultExitMessage,
  encodePcm16MonoAsWav,
  ensureBotAudioPlaybackReady,
  extractSoundboardDirective,
  findMentionedSoundboardReference,
  formatNaturalList,
  getRealtimeCommitMinimumBytes,
  formatRealtimeMemoryFacts,
  formatSoundboardCandidateLine,
  getRealtimeRuntimeLabel,
  isRecoverableRealtimeError,
  isRealtimeMode,
  isVoiceTurnAddressedToBot,
  matchSoundboardReference,
  normalizeVoiceText,
  parsePreferredSoundboardReferences,
  parseRealtimeErrorPayload,
  parseResponseDoneId,
  parseResponseDoneStatus,
  resolveRealtimeProvider,
  resolveVoiceRuntimeMode,
  shortError,
  shouldAllowVoiceNsfwHumor,
  transcriptSourceFromEventType
} from "./voiceSessionHelpers.ts";
import { XaiRealtimeClient } from "./xaiRealtimeClient.ts";

const MIN_MAX_SESSION_MINUTES = 1;
const MAX_MAX_SESSION_MINUTES = 120;
const MIN_INACTIVITY_SECONDS = 20;
const MAX_INACTIVITY_SECONDS = 3600;
const INPUT_SPEECH_END_SILENCE_MS = 1400;
const SPEAKING_END_FINALIZE_GRACE_MS = 1200;
const SPEAKING_END_SHORT_CAPTURE_MS = 900;
const SPEAKING_END_FINALIZE_QUICK_MS = 140;
const CAPTURE_IDLE_FLUSH_MS = INPUT_SPEECH_END_SILENCE_MS + 220;
const CAPTURE_MAX_DURATION_MS = 14_000;
const BOT_TURN_SILENCE_RESET_MS = 1200;
const ACTIVITY_TOUCH_THROTTLE_MS = 2000;
const RESPONSE_FLUSH_DEBOUNCE_MS = 280;
const OPENAI_ACTIVE_RESPONSE_RETRY_MS = 260;
const MIN_RESPONSE_REQUEST_GAP_MS = 700;
const RESPONSE_SILENCE_RETRY_DELAY_MS = 5200;
const MAX_RESPONSE_SILENCE_RETRIES = 2;
const RESPONSE_DONE_SILENCE_GRACE_MS = 1400;
const PENDING_SUPERSEDE_MIN_AGE_MS = 1800;
const BOT_DISCONNECT_GRACE_MS = 2500;
const STT_CONTEXT_MAX_MESSAGES = 10;
const STT_TRANSCRIPT_MAX_CHARS = 700;
const STT_REPLY_MAX_CHARS = 520;
const VOICE_TURN_ADDRESSING_TRANSCRIPT_MAX_CHARS = 260;
const VOICE_DECIDER_HISTORY_MAX_TURNS = 8;
const VOICE_DECIDER_HISTORY_MAX_CHARS = 220;
const REALTIME_ECHO_SUPPRESSION_MS = 1800;
const REALTIME_INSTRUCTION_REFRESH_DEBOUNCE_MS = 220;
const REALTIME_CONTEXT_TRANSCRIPT_MAX_CHARS = 420;
const REALTIME_CONTEXT_MEMBER_LIMIT = 12;
const FOCUSED_SPEAKER_CONTINUATION_MS = 20_000;
const VOICE_LOW_SIGNAL_MIN_ALNUM_CHARS = 10;
const VOICE_LOW_SIGNAL_MIN_WORDS = 2;
const OPENAI_REALTIME_SHORT_CLIP_ASR_MS = 1200;
const PCM16_MONO_BYTES_PER_SAMPLE = 2;
const SOUNDBOARD_DECISION_TRANSCRIPT_MAX_CHARS = 280;
const SOUNDBOARD_CATALOG_REFRESH_MS = 60_000;
const STREAM_WATCH_AUDIO_QUIET_WINDOW_MS = 2200;
const STREAM_WATCH_COMMENTARY_PROMPT_MAX_CHARS = 220;
const STREAM_WATCH_COMMENTARY_LINE_MAX_CHARS = 160;
const STREAM_WATCH_VISION_MAX_OUTPUT_TOKENS = 72;

export class VoiceSessionManager {
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
    if (!message?.guild || !message?.member || !message?.channel) return false;

    const guildId = String(message.guild.id);
    const userId = String(message.author?.id || "");
    if (!userId) return false;

    return await this.withJoinLock(guildId, async () => {
      if (!settings?.voice?.enabled) {
        await this.sendOperationalMessage({
          channel: message.channel,
          settings,
          guildId,
          channelId: message.channelId,
          userId,
          messageId: message.id,
          event: "voice_join_request",
          reason: "voice_disabled",
          details: {
            voiceEnabled: Boolean(settings?.voice?.enabled)
          },
          fallback: "voice mode is off rn. ask an admin to enable it."
        });
        return true;
      }

      const blockedUsers = settings.voice?.blockedVoiceUserIds || [];
      if (blockedUsers.includes(userId)) {
        await this.sendOperationalMessage({
          channel: message.channel,
          settings,
          guildId,
          channelId: message.channelId,
          userId,
          messageId: message.id,
          event: "voice_join_request",
          reason: "requester_blocked",
          details: {
            blockedVoiceUserIdsCount: blockedUsers.length
          },
          fallback: "you are blocked from voice controls here."
        });
        return true;
      }

      const memberVoiceChannel = message.member.voice?.channel;
      if (!memberVoiceChannel) {
        await this.sendOperationalMessage({
          channel: message.channel,
          settings,
          guildId,
          channelId: message.channelId,
          userId,
          messageId: message.id,
          event: "voice_join_request",
          reason: "requester_not_in_voice",
          details: {},
          fallback: "join a vc first, then ping me to hop in."
        });
        return true;
      }

      const targetVoiceChannelId = String(memberVoiceChannel.id);
      const blockedChannels = settings.voice?.blockedVoiceChannelIds || [];
      const allowedChannels = settings.voice?.allowedVoiceChannelIds || [];

      if (blockedChannels.includes(targetVoiceChannelId)) {
        await this.sendOperationalMessage({
          channel: message.channel,
          settings,
          guildId,
          channelId: message.channelId,
          userId,
          messageId: message.id,
          event: "voice_join_request",
          reason: "channel_blocked",
          details: {
            targetVoiceChannelId
          },
          fallback: "that voice channel is blocked for me."
        });
        return true;
      }

      if (allowedChannels.length > 0 && !allowedChannels.includes(targetVoiceChannelId)) {
        await this.sendOperationalMessage({
          channel: message.channel,
          settings,
          guildId,
          channelId: message.channelId,
          userId,
          messageId: message.id,
          event: "voice_join_request",
          reason: "channel_not_allowlisted",
          details: {
            targetVoiceChannelId,
            allowlistedChannelCount: allowedChannels.length
          },
          fallback: "i can only join allowlisted voice channels here."
        });
        return true;
      }

      const maxSessionsPerDay = clamp(Number(settings.voice?.maxSessionsPerDay) || 0, 0, 120);
      if (maxSessionsPerDay > 0) {
        const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const startedLastDay = this.store.countActionsSince("voice_session_start", since24h);
        if (startedLastDay >= maxSessionsPerDay) {
          await this.sendOperationalMessage({
            channel: message.channel,
            settings,
            guildId,
            channelId: message.channelId,
            userId,
            messageId: message.id,
            event: "voice_join_request",
            reason: "max_sessions_per_day_reached",
            details: {
              startedLastDay,
              maxSessionsPerDay
            },
            fallback: "daily voice session limit hit for now."
          });
          return true;
        }
      }

      const existing = this.sessions.get(guildId);
      if (existing) {
        if (existing.voiceChannelId === targetVoiceChannelId) {
          this.touchActivity(guildId, settings);
          await this.sendOperationalMessage({
            channel: message.channel,
            settings,
            guildId,
            channelId: message.channelId,
            userId,
            messageId: message.id,
            event: "voice_join_request",
            reason: "already_in_channel",
            details: {
              voiceChannelId: targetVoiceChannelId
            },
            fallback: "already in your vc."
          });
          return true;
        }

        await this.endSession({
          guildId,
          reason: "switch_channel",
          requestedByUserId: userId,
          announceChannel: message.channel,
          announcement: "switching voice channels.",
          settings,
          messageId: message.id
        });
      }

      const runtimeMode = resolveVoiceRuntimeMode(settings);
      if (runtimeMode === "voice_agent" && !this.appConfig?.xaiApiKey) {
        await this.sendOperationalMessage({
          channel: message.channel,
          settings,
          guildId,
          channelId: message.channelId,
          userId,
          messageId: message.id,
          event: "voice_join_request",
          reason: "xai_api_key_missing",
          details: {
            mode: runtimeMode
          },
          fallback: "voice agent mode needs `XAI_API_KEY`."
        });
        return true;
      }
      if (runtimeMode === "openai_realtime" && !this.appConfig?.openaiApiKey) {
        await this.sendOperationalMessage({
          channel: message.channel,
          settings,
          guildId,
          channelId: message.channelId,
          userId,
          messageId: message.id,
          event: "voice_join_request",
          reason: "openai_api_key_missing",
          details: {
            mode: runtimeMode
          },
          fallback: "OpenAI realtime mode needs `OPENAI_API_KEY`."
        });
        return true;
      }
      if (runtimeMode === "gemini_realtime" && !this.appConfig?.geminiApiKey) {
        await this.sendOperationalMessage({
          channel: message.channel,
          settings,
          guildId,
          channelId: message.channelId,
          userId,
          messageId: message.id,
          event: "voice_join_request",
          reason: "gemini_api_key_missing",
          details: {
            mode: runtimeMode
          },
          fallback: "Gemini realtime mode needs `GOOGLE_API_KEY`."
        });
        return true;
      }
      if (runtimeMode === "stt_pipeline") {
        if (!this.llm?.isAsrReady?.()) {
          await this.sendOperationalMessage({
            channel: message.channel,
            settings,
            guildId,
            channelId: message.channelId,
            userId,
            messageId: message.id,
            event: "voice_join_request",
            reason: "stt_pipeline_asr_unavailable",
            details: {
              mode: runtimeMode
            },
            fallback: "stt pipeline needs `OPENAI_API_KEY` for speech-to-text."
          });
          return true;
        }
        if (!this.llm?.isSpeechSynthesisReady?.()) {
          await this.sendOperationalMessage({
            channel: message.channel,
            settings,
            guildId,
            channelId: message.channelId,
            userId,
            messageId: message.id,
            event: "voice_join_request",
            reason: "stt_pipeline_tts_unavailable",
            details: {
              mode: runtimeMode
            },
            fallback: "stt pipeline needs `OPENAI_API_KEY` for text-to-speech."
          });
          return true;
        }
        if (typeof this.generateVoiceTurn !== "function") {
          await this.sendOperationalMessage({
            channel: message.channel,
            settings,
            guildId,
            channelId: message.channelId,
            userId,
            messageId: message.id,
            event: "voice_join_request",
            reason: "stt_pipeline_brain_unavailable",
            details: {
              mode: runtimeMode
            },
            fallback: "stt pipeline brain callback is missing in runtime."
          });
          return true;
        }
      }

      const missingPermissionInfo = this.getMissingJoinPermissionInfo({
        guild: message.guild,
        voiceChannel: memberVoiceChannel
      });
      if (missingPermissionInfo) {
        await this.sendOperationalMessage({
          channel: message.channel,
          settings,
          guildId,
          channelId: message.channelId,
          userId,
          messageId: message.id,
          event: "voice_join_request",
          reason: missingPermissionInfo.reason,
          details: {
            missingPermissions: missingPermissionInfo.missingPermissions || []
          },
          fallback: this.composeMissingPermissionFallback(missingPermissionInfo)
        });
        return true;
      }

      const maxSessionMinutes = clamp(
        Number(settings.voice?.maxSessionMinutes) || 10,
        MIN_MAX_SESSION_MINUTES,
        MAX_MAX_SESSION_MINUTES
      );

      let connection = null;
      let realtimeClient = null;
      let audioPlayer = null;
      let botAudioStream = null;
      let reservedConcurrencySlot = false;
      let realtimeInputSampleRateHz = 24000;
      let realtimeOutputSampleRateHz = 24000;

      try {
        const maxConcurrentSessions = clamp(Number(settings.voice?.maxConcurrentSessions) || 1, 1, 3);
        if (!existing) {
          const activeOrPendingSessions = this.sessions.size + this.pendingSessionGuildIds.size;
          if (activeOrPendingSessions >= maxConcurrentSessions) {
            await this.sendOperationalMessage({
              channel: message.channel,
              settings,
              guildId,
              channelId: message.channelId,
              userId,
              messageId: message.id,
              event: "voice_join_request",
              reason: "max_concurrent_sessions_reached",
              details: {
                activeOrPendingSessions,
                maxConcurrentSessions
              },
              fallback: "voice session cap reached right now."
            });
            return true;
          }

          this.pendingSessionGuildIds.add(guildId);
          reservedConcurrencySlot = true;
        }

        connection = joinVoiceChannel({
          channelId: memberVoiceChannel.id,
          guildId: message.guild.id,
          adapterCreator: message.guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: false
        });

        await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

        const initialSoundboardCandidateInfo = await this.resolveSoundboardCandidates({
          settings,
          guild: message.guild
        });
        const initialSoundboardCandidates = Array.isArray(initialSoundboardCandidateInfo?.candidates)
          ? initialSoundboardCandidateInfo.candidates
          : [];
        const baseVoiceInstructions = this.buildVoiceInstructions(settings, {
          soundboardCandidates: initialSoundboardCandidates
        });
        if (runtimeMode === "voice_agent") {
          realtimeClient = new XaiRealtimeClient({
            apiKey: this.appConfig.xaiApiKey,
            logger: ({ level, event, metadata }) => {
              this.store.logAction({
                kind: level === "warn" ? "voice_error" : "voice_runtime",
                guildId,
                channelId: message.channelId,
                userId: this.client.user?.id || null,
                content: event,
                metadata
              });
            }
          });

          const xaiSettings = settings.voice?.xai || {};
          realtimeInputSampleRateHz = Number(xaiSettings.sampleRateHz) || 24000;
          realtimeOutputSampleRateHz = Number(xaiSettings.sampleRateHz) || 24000;
          await realtimeClient.connect({
            voice: xaiSettings.voice || "Rex",
            instructions: baseVoiceInstructions,
            region: xaiSettings.region || "us-east-1",
            inputAudioFormat: xaiSettings.audioFormat || "audio/pcm",
            outputAudioFormat: xaiSettings.audioFormat || "audio/pcm",
            inputSampleRateHz: realtimeInputSampleRateHz,
            outputSampleRateHz: realtimeOutputSampleRateHz
          });
        } else if (runtimeMode === "openai_realtime") {
          realtimeClient = new OpenAiRealtimeClient({
            apiKey: this.appConfig.openaiApiKey,
            logger: ({ level, event, metadata }) => {
              this.store.logAction({
                kind: level === "warn" ? "voice_error" : "voice_runtime",
                guildId,
                channelId: message.channelId,
                userId: this.client.user?.id || null,
                content: event,
                metadata
              });
            }
          });

          const openAiRealtimeSettings = settings.voice?.openaiRealtime || {};
          realtimeInputSampleRateHz = Number(openAiRealtimeSettings.inputSampleRateHz) || 24000;
          realtimeOutputSampleRateHz = Number(openAiRealtimeSettings.outputSampleRateHz) || 24000;
          await realtimeClient.connect({
            model: String(openAiRealtimeSettings.model || "gpt-realtime").trim() || "gpt-realtime",
            voice: String(openAiRealtimeSettings.voice || "alloy").trim() || "alloy",
            instructions: baseVoiceInstructions,
            inputAudioFormat: String(openAiRealtimeSettings.inputAudioFormat || "pcm16").trim() || "pcm16",
            outputAudioFormat: String(openAiRealtimeSettings.outputAudioFormat || "pcm16").trim() || "pcm16",
            inputTranscriptionModel:
              String(openAiRealtimeSettings.inputTranscriptionModel || "gpt-4o-mini-transcribe").trim() ||
              "gpt-4o-mini-transcribe"
          });
        } else if (runtimeMode === "gemini_realtime") {
          const geminiRealtimeSettings = settings.voice?.geminiRealtime || {};
          realtimeClient = new GeminiRealtimeClient({
            apiKey: this.appConfig.geminiApiKey,
            baseUrl:
              String(geminiRealtimeSettings.apiBaseUrl || "https://generativelanguage.googleapis.com").trim() ||
              "https://generativelanguage.googleapis.com",
            logger: ({ level, event, metadata }) => {
              this.store.logAction({
                kind: level === "warn" ? "voice_error" : "voice_runtime",
                guildId,
                channelId: message.channelId,
                userId: this.client.user?.id || null,
                content: event,
                metadata
              });
            }
          });

          realtimeInputSampleRateHz = Number(geminiRealtimeSettings.inputSampleRateHz) || 16000;
          realtimeOutputSampleRateHz = Number(geminiRealtimeSettings.outputSampleRateHz) || 24000;
          await realtimeClient.connect({
            model:
              String(geminiRealtimeSettings.model || "gemini-2.5-flash-native-audio-preview-12-2025").trim() ||
              "gemini-2.5-flash-native-audio-preview-12-2025",
            voice: String(geminiRealtimeSettings.voice || "Aoede").trim() || "Aoede",
            instructions: baseVoiceInstructions,
            inputSampleRateHz: realtimeInputSampleRateHz,
            outputSampleRateHz: realtimeOutputSampleRateHz
          });
        }

        audioPlayer = createAudioPlayer();
        botAudioStream = new PassThrough();
        const audioResource = createAudioResource(botAudioStream, {
          inputType: StreamType.Raw
        });
        audioPlayer.play(audioResource);
        connection.subscribe(audioPlayer);

        const now = Date.now();
        const session = {
          id: randomUUID(),
          guildId,
          voiceChannelId: targetVoiceChannelId,
          textChannelId: String(message.channelId),
          requestedByUserId: userId,
          mode: runtimeMode,
          realtimeProvider: resolveRealtimeProvider(runtimeMode),
          realtimeInputSampleRateHz,
          realtimeOutputSampleRateHz,
          recentVoiceTurns: [],
          connection,
          realtimeClient,
          audioPlayer,
          botAudioStream,
          startedAt: now,
          lastActivityAt: now,
          maxEndsAt: null,
          inactivityEndsAt: null,
          maxTimer: null,
          inactivityTimer: null,
          botTurnResetTimer: null,
          botTurnOpen: false,
          lastBotActivityTouchAt: 0,
          responseFlushTimer: null,
          responseWatchdogTimer: null,
          responseDoneGraceTimer: null,
          botDisconnectTimer: null,
          lastResponseRequestAt: 0,
          lastAudioDeltaAt: 0,
          lastInboundAudioAt: 0,
          pendingRealtimeInputBytes: 0,
          lastAudioPipelineRepairAt: 0,
          nextResponseRequestId: 0,
          pendingResponse: null,
          pendingSttTurns: 0,
          sttContextMessages: [],
          sttTurnChain: Promise.resolve(),
          realtimeTurnDrainActive: false,
          pendingRealtimeTurn: null,
          userCaptures: new Map(),
          streamWatch: {
            active: false,
            targetUserId: null,
            requestedByUserId: null,
            lastFrameAt: 0,
            lastCommentaryAt: 0,
            ingestedFrameCount: 0,
            acceptedFrameCountInWindow: 0,
            frameWindowStartedAt: 0,
            latestFrameMimeType: null,
            latestFrameDataBase64: "",
            latestFrameAt: 0
          },
          soundboard: {
            playCount: 0,
            lastPlayedAt: 0,
            catalogCandidates:
              String(initialSoundboardCandidateInfo?.source || "") === "guild_catalog"
                ? initialSoundboardCandidates.slice(0, SOUNDBOARD_MAX_CANDIDATES)
                : [],
            catalogFetchedAt:
              String(initialSoundboardCandidateInfo?.source || "") === "guild_catalog" ||
              String(initialSoundboardCandidateInfo?.source || "") === "none"
                ? now
                : 0,
            lastDirectiveKey: "",
            lastDirectiveAt: 0
          },
          focusedSpeakerUserId: null,
          focusedSpeakerAt: 0,
          baseVoiceInstructions,
          lastOpenAiRealtimeInstructions: "",
          lastOpenAiRealtimeInstructionsAt: 0,
          realtimeInstructionRefreshTimer: null,
          settingsSnapshot: settings,
          cleanupHandlers: [],
          ending: false
        };

        this.sessions.set(guildId, session);
        this.bindAudioPlayerHandlers(session);
        this.bindSessionHandlers(session, settings);
        if (isRealtimeMode(runtimeMode)) {
          this.bindRealtimeHandlers(session, settings);
        }
        if (runtimeMode === "openai_realtime") {
          this.scheduleOpenAiRealtimeInstructionRefresh({
            session,
            settings,
            reason: "session_start"
          });
        }
        this.startSessionTimers(session, settings);

        this.store.logAction({
          kind: "voice_session_start",
          guildId,
          channelId: message.channelId,
          userId,
          content: `voice_joined:${targetVoiceChannelId}`,
          metadata: {
            sessionId: session.id,
            mode: runtimeMode,
            requestedByUserId: userId,
            voiceChannelId: targetVoiceChannelId,
            maxSessionMinutes,
            inactivityLeaveSeconds: clamp(
              Number(settings.voice?.inactivityLeaveSeconds) || 90,
              MIN_INACTIVITY_SECONDS,
              MAX_INACTIVITY_SECONDS
            ),
            intentConfidence
          }
        });

        return true;
      } catch (error) {
        const errorText = String(error?.message || error);
        this.store.logAction({
          kind: "voice_error",
          guildId,
          channelId: message.channelId,
          userId,
          content: `voice_join_failed: ${errorText}`
        });

        if (realtimeClient) {
          await realtimeClient.close().catch(() => undefined);
        }

        if (botAudioStream) {
          try {
            botAudioStream.end();
          } catch {
            // ignore
          }
        }

        if (audioPlayer) {
          try {
            audioPlayer.stop(true);
          } catch {
            // ignore
          }
        }

        if (connection) {
          try {
            connection.destroy();
          } catch {
            // ignore
          }
        }

        await this.sendOperationalMessage({
          channel: message.channel,
          settings,
          guildId,
          channelId: message.channelId,
          userId,
          messageId: message.id,
          event: "voice_join_request",
          reason: "join_failed",
          details: {
            error: shortError(errorText)
          },
          fallback: `couldn't join voice: ${shortError(errorText)}`
        });
        return true;
      } finally {
        if (reservedConcurrencySlot) {
          this.pendingSessionGuildIds.delete(guildId);
        }
      }
    });
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
        details: {},
        fallback: "i'm not in vc right now."
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
        details: {},
        fallback: "voice status: offline (not in vc)."
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
      },
      fallback:
        `voice status: in <#${session.voiceChannelId}> | session ${elapsedSeconds}s | ` +
        `max-left ${remainingSeconds ?? "n/a"}s | idle-left ${inactivitySeconds ?? "n/a"}s | ` +
        `capturing ${session.userCaptures.size} speaker(s) | stream-watch ${session.streamWatch?.active ? "on" : "off"}`
    });

    return true;
  }

  async requestWatchStream({ message, settings, targetUserId = null }) {
    if (!message?.guild || !message?.channel) return false;

    const guildId = String(message.guild.id);
    const session = this.sessions.get(guildId);
    const requesterId = String(message.author?.id || "").trim() || null;
    if (!session) {
      await this.sendOperationalMessage({
        channel: message.channel,
        settings,
        guildId,
        channelId: message.channelId,
        userId: requesterId,
        messageId: message.id,
        event: "voice_stream_watch_request",
        reason: "offline",
        details: {},
        fallback: "i'm not in vc rn. ask me to join first."
      });
      return true;
    }

    if (String(message.member?.voice?.channelId || "") !== String(session.voiceChannelId || "")) {
      await this.sendOperationalMessage({
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
        },
        fallback: "you need to be in my vc for stream watch commands."
      });
      return true;
    }

    const streamWatchSettings = settings?.voice?.streamWatch || {};
    if (!streamWatchSettings.enabled) {
      await this.sendOperationalMessage({
        channel: message.channel,
        settings,
        guildId,
        channelId: message.channelId,
        userId: requesterId,
        messageId: message.id,
        event: "voice_stream_watch_request",
        reason: "stream_watch_disabled",
        details: {},
        fallback: "stream watch is disabled in settings rn."
      });
      return true;
    }

    if (!this.supportsStreamWatchCommentary(session, settings)) {
      await this.sendOperationalMessage({
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
        },
        fallback:
          "switch voice mode to `openai_realtime` or `gemini_realtime`, or configure a vision fallback provider for `voice_agent`."
      });
      return true;
    }

    this.initializeStreamWatchState({
      session,
      requesterUserId: requesterId,
      targetUserId: String(targetUserId || requesterId || "").trim() || null
    });

    await this.sendOperationalMessage({
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
      fallback: "bet, i'm watching your stream. pipe frames to `/api/voice/stream-ingest/frame`."
    });
    return true;
  }

  initializeStreamWatchState({ session, requesterUserId, targetUserId = null }) {
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

  supportsStreamWatchCommentary(session, settings = null) {
    if (!session || session.ending) return false;
    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    if (!isRealtimeMode(session.mode)) return false;
    const realtimeClient = session.realtimeClient;
    const hasNativeVideoCommentary = Boolean(
      realtimeClient &&
        typeof realtimeClient.appendInputVideoFrame === "function" &&
        typeof realtimeClient.requestVideoCommentary === "function"
    );
    if (hasNativeVideoCommentary) return true;
    return this.supportsVisionFallbackStreamWatchCommentary({ session, settings: resolvedSettings });
  }

  supportsVisionFallbackStreamWatchCommentary({ session, settings = null } = {}) {
    if (!session || session.ending) return false;
    if (session.mode !== "voice_agent") return false;
    const realtimeClient = session.realtimeClient;
    if (!realtimeClient || typeof realtimeClient.requestTextUtterance !== "function") return false;
    if (!this.llm || typeof this.llm.generate !== "function") return false;
    return Boolean(this.resolveStreamWatchVisionProviderSettings(settings));
  }

  resolveStreamWatchVisionProviderSettings(settings = null) {
    const llmSettings = settings?.llm && typeof settings.llm === "object" ? settings.llm : {};
    const candidates = [
      {
        provider: "openai",
        model: "gpt-4.1-mini"
      },
      {
        provider: "xai",
        model: "grok-2-vision-latest"
      },
      {
        provider: "anthropic",
        model: "claude-haiku-4-5"
      },
      {
        provider: "claude-code",
        model: "sonnet"
      }
    ];

    for (const candidate of candidates) {
      const configured = this.llm?.isProviderConfigured?.(candidate.provider);
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

  async generateVisionFallbackStreamWatchCommentary({
    session,
    settings,
    streamerUserId = null,
    frameMimeType = "image/jpeg",
    frameDataBase64 = ""
  }) {
    if (!session || session.ending) return null;
    if (!this.llm || typeof this.llm.generate !== "function") return null;
    const normalizedFrame = String(frameDataBase64 || "").trim();
    if (!normalizedFrame) return null;

    const providerSettings = this.resolveStreamWatchVisionProviderSettings(settings);
    if (!providerSettings) return null;
    const speakerName = this.resolveVoiceSpeakerName(session, streamerUserId) || "the streamer";
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

    const generated = await this.llm.generate({
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
        userId: this.client.user?.id || null,
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

  isUserInSessionVoiceChannel({ session, userId }) {
    const normalizedUserId = String(userId || "").trim();
    if (!session || !normalizedUserId) return false;
    const guild = this.client.guilds.cache.get(String(session.guildId || "")) || null;
    const voiceChannel = guild?.channels?.cache?.get(String(session.voiceChannelId || "")) || null;
    return Boolean(voiceChannel?.members?.has?.(normalizedUserId));
  }

  async enableWatchStreamForUser({
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

    const session = this.sessions.get(normalizedGuildId);
    if (!session) {
      return {
        ok: false,
        reason: "session_not_found",
        fallback: "i'm not in vc rn. ask me to join first."
      };
    }

    if (!this.isUserInSessionVoiceChannel({ session, userId: normalizedRequesterId })) {
      return {
        ok: false,
        reason: "requester_not_in_same_vc",
        fallback: "you need to be in my vc for screen sharing."
      };
    }

    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    const streamWatchSettings = resolvedSettings?.voice?.streamWatch || {};
    if (!streamWatchSettings.enabled) {
      return {
        ok: false,
        reason: "stream_watch_disabled",
        fallback: "stream watch is disabled in settings rn."
      };
    }

    if (!this.supportsStreamWatchCommentary(session, resolvedSettings)) {
      return {
        ok: false,
        reason: "stream_watch_provider_unavailable",
        fallback:
          "switch voice mode to `openai_realtime` or `gemini_realtime`, or configure a vision fallback provider for `voice_agent`."
      };
    }

    const resolvedTarget = String(targetUserId || normalizedRequesterId).trim() || normalizedRequesterId;
    this.initializeStreamWatchState({
      session,
      requesterUserId: normalizedRequesterId,
      targetUserId: resolvedTarget
    });
    this.store.logAction({
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

  async requestStopWatchingStream({ message, settings }) {
    if (!message?.guild || !message?.channel) return false;

    const guildId = String(message.guild.id);
    const session = this.sessions.get(guildId);
    const requesterId = String(message.author?.id || "").trim() || null;
    if (!session) {
      await this.sendOperationalMessage({
        channel: message.channel,
        settings,
        guildId,
        channelId: message.channelId,
        userId: requesterId,
        messageId: message.id,
        event: "voice_stream_watch_request",
        reason: "offline",
        details: {},
        fallback: "i'm not in vc right now."
      });
      return true;
    }

    if (!session.streamWatch?.active) {
      await this.sendOperationalMessage({
        channel: message.channel,
        settings,
        guildId,
        channelId: message.channelId,
        userId: requesterId,
        messageId: message.id,
        event: "voice_stream_watch_request",
        reason: "already_stopped",
        details: {},
        fallback: "i'm not watching any stream rn."
      });
      return true;
    }

    session.streamWatch.active = false;
    session.streamWatch.targetUserId = null;
    session.streamWatch.latestFrameMimeType = null;
    session.streamWatch.latestFrameDataBase64 = "";
    session.streamWatch.latestFrameAt = 0;

    await this.sendOperationalMessage({
      channel: message.channel,
      settings,
      guildId,
      channelId: message.channelId,
      userId: requesterId,
      messageId: message.id,
      event: "voice_stream_watch_request",
      reason: "watching_stopped",
      details: {},
      fallback: "stopped watching stream."
    });
    return true;
  }

  async requestStreamWatchStatus({ message, settings }) {
    if (!message?.guild || !message?.channel) return false;

    const guildId = String(message.guild.id);
    const session = this.sessions.get(guildId);
    const requesterId = String(message.author?.id || "").trim() || null;
    if (!session) {
      await this.sendOperationalMessage({
        channel: message.channel,
        settings,
        guildId,
        channelId: message.channelId,
        userId: requesterId,
        messageId: message.id,
        event: "voice_stream_watch_request",
        reason: "offline",
        details: {},
        fallback: "stream watch status: offline (not in vc)."
      });
      return true;
    }

    const streamWatch = session.streamWatch || {};
    const lastFrameAgoSec = Number(streamWatch.lastFrameAt || 0)
      ? Math.max(0, Math.floor((Date.now() - Number(streamWatch.lastFrameAt || 0)) / 1000))
      : null;
    const lastCommentaryAgoSec = Number(streamWatch.lastCommentaryAt || 0)
      ? Math.max(0, Math.floor((Date.now() - Number(streamWatch.lastCommentaryAt || 0)) / 1000))
      : null;

    await this.sendOperationalMessage({
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
      },
      fallback:
        `stream watch: ${streamWatch.active ? "on" : "off"} | mode ${session.mode} | ` +
        `target ${streamWatch.targetUserId || "none"} | last-frame ${lastFrameAgoSec ?? "n/a"}s | ` +
        `last-comment ${lastCommentaryAgoSec ?? "n/a"}s`
    });
    return true;
  }

  async ingestStreamFrame({
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

    const session = this.sessions.get(normalizedGuildId);
    if (!session || session.ending) {
      return {
        accepted: false,
        reason: "session_not_found"
      };
    }

    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    const streamWatchSettings = resolvedSettings?.voice?.streamWatch || {};
    if (!streamWatchSettings.enabled) {
      return {
        accepted: false,
        reason: "stream_watch_disabled"
      };
    }
    if (!this.supportsStreamWatchCommentary(session, resolvedSettings)) {
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
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: normalizedStreamerId || this.client.user?.id || null,
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
    this.touchActivity(session.guildId, resolvedSettings);

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: normalizedStreamerId || this.client.user?.id || null,
      content: "stream_watch_frame_ingested",
      metadata: {
        sessionId: session.id,
        source: String(source || "api_stream_ingest"),
        mimeType: resolvedMimeType,
        frameBytes: approxBytes,
        totalFrames: streamWatch.ingestedFrameCount
      }
    });

    await this.maybeTriggerStreamWatchCommentary({
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

  async maybeTriggerStreamWatchCommentary({
    session,
    settings,
    streamerUserId = null,
    source = "api_stream_ingest"
  }) {
    if (!session || session.ending) return;
    if (!this.supportsStreamWatchCommentary(session, settings)) return;
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

    const speakerName = this.resolveVoiceSpeakerName(session, streamerUserId) || "the streamer";
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
        const generated = await this.generateVisionFallbackStreamWatchCommentary({
          session,
          settings,
          streamerUserId,
          frameMimeType: session.streamWatch?.latestFrameMimeType || "image/jpeg",
          frameDataBase64: bufferedFrame
        });
        const line = normalizeVoiceText(generated?.text || "", STREAM_WATCH_COMMENTARY_LINE_MAX_CHARS);
        if (!line) return;
        const utterancePrompt = normalizeVoiceText(
          [
            `You're in Discord VC watching ${speakerName}'s live stream.`,
            `Speak exactly this one short stream commentary line and nothing else: ${line}`
          ].join(" "),
          STREAM_WATCH_COMMENTARY_PROMPT_MAX_CHARS
        );
        realtimeClient.requestTextUtterance(utterancePrompt);
        fallbackVisionMeta = {
          provider: generated?.provider || null,
          model: generated?.model || null
        };
      } else {
        return;
      }

      const created = this.createTrackedAudioResponse({
        session,
        userId: session.streamWatch.targetUserId || streamerUserId || this.client.user?.id || null,
        source: "stream_watch_commentary",
        resetRetryState: true,
        emitCreateEvent: false
      });
      if (!created) return;
      session.streamWatch.lastCommentaryAt = now;
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
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
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `stream_watch_commentary_request_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          source: String(source || "api_stream_ingest")
        }
      });
    }
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
      try {
        session.botAudioStream.write(discordPcm);
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
      if (!pending) return;

      const responseId = parseResponseDoneId(event);
      const responseStatus = parseResponseDoneStatus(event);
      const hadAudio = this.pendingResponseHasAudio(session, pending);

      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `${runtimeLabel}_response_done`,
        metadata: {
          sessionId: session.id,
          requestId: pending.requestId,
          responseId,
          responseStatus,
          hadAudio,
          retryCount: pending.retryCount,
          hardRecoveryAttempted: pending.hardRecoveryAttempted
        }
      });

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
      const finalizeDelayMs =
        captureAgeMs < SPEAKING_END_SHORT_CAPTURE_MS
          ? SPEAKING_END_FINALIZE_GRACE_MS
          : SPEAKING_END_FINALIZE_QUICK_MS;
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
      suppressedNearBotSpeech: false,
      lastActivityTouchAt: 0,
      idleFlushTimer: null,
      maxFlushTimer: null,
      speakingEndFinalizeTimer: null,
      finalize: null
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
      const suppressForEcho =
        isRealtimeMode(session.mode) &&
        (session.botTurnOpen ||
          (Number(session.lastAudioDeltaAt || 0) > 0 &&
            now - Number(session.lastAudioDeltaAt || 0) < REALTIME_ECHO_SUPPRESSION_MS));

      if (suppressForEcho) {
        captureState.suppressedNearBotSpeech = true;
        return;
      }

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
        if (captureState.suppressedNearBotSpeech && !session.ending) {
          this.store.logAction({
            kind: "voice_runtime",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId,
            content: "voice_turn_suppressed_near_bot_speech",
            metadata: {
              sessionId: session.id,
              reason: String(reason || "stream_end")
            }
          });
        }
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

  queueRealtimeTurn({ session, userId, pcmBuffer, captureReason = "stream_end" }) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;
    if (!pcmBuffer || !pcmBuffer.length) return;

    const queuedTurn = {
      session,
      userId,
      pcmBuffer,
      captureReason,
      queuedAt: Date.now()
    };

    if (session.realtimeTurnDrainActive) {
      const previousPending = session.pendingRealtimeTurn;
      session.pendingRealtimeTurn = queuedTurn;
      if (previousPending) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          content: "realtime_turn_superseded",
          metadata: {
            sessionId: session.id,
            replacedCaptureReason: String(previousPending.captureReason || "stream_end"),
            replacingCaptureReason: String(captureReason || "stream_end"),
            replacedQueueAgeMs: Math.max(0, Date.now() - Number(previousPending.queuedAt || Date.now()))
          }
        });
      }
      return;
    }

    this.drainRealtimeTurnQueue(queuedTurn).catch(() => undefined);
  }

  async drainRealtimeTurnQueue(initialTurn) {
    const session = initialTurn?.session;
    if (!session || session.ending) return;
    if (session.realtimeTurnDrainActive) return;

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

        const next = session.pendingRealtimeTurn;
        session.pendingRealtimeTurn = null;
        turn = next || null;
      }
    } finally {
      session.realtimeTurnDrainActive = false;
      if (session.ending) {
        session.pendingRealtimeTurn = null;
        return;
      }
      const pending = session.pendingRealtimeTurn;
      if (!pending) return;
      session.pendingRealtimeTurn = null;
      this.queueRealtimeTurn({
        session,
        userId: pending.userId,
        pcmBuffer: pending.pcmBuffer,
        captureReason: pending.captureReason
      });
    }
  }

  async runRealtimeTurn({ session, userId, pcmBuffer, captureReason = "stream_end", queuedAt = 0 }) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;
    if (!pcmBuffer?.length) return;
    const queueWaitMs = queuedAt ? Math.max(0, Date.now() - Number(queuedAt || Date.now())) : 0;

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

    if (!decision.allow) return;
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
        transcript: turnTranscript,
        captureReason
      });
    }
    this.scheduleResponseFromBufferedAudio({ session, userId });
  }

  async evaluateVoiceReplyDecision({ session, settings, userId, transcript, source = "voice_turn" }) {
    const normalizedTranscript = normalizeVoiceText(transcript, VOICE_TURN_ADDRESSING_TRANSCRIPT_MAX_CHARS);
    const normalizedUserId = String(userId || "").trim();
    const participantCount = this.countHumanVoiceParticipants(session);
    const directAddressed = normalizedTranscript ? isVoiceTurnAddressedToBot(normalizedTranscript, settings) : false;
    const replyEagerness = clamp(Number(settings?.voice?.replyEagerness) || 0, 0, 100);
    const now = Date.now();

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
    if (lowSignalFragment) {
      if (directAddressed && isLikelyWakeWordPing(normalizedTranscript)) {
        return {
          allow: true,
          reason: "direct_address_wake_ping",
          participantCount,
          directAddressed,
          transcript: normalizedTranscript
        };
      }
      return {
        allow: false,
        reason: "low_signal_fragment",
        participantCount,
        directAddressed,
        transcript: normalizedTranscript
      };
    }

    const focusedSpeakerUserId = String(session?.focusedSpeakerUserId || "").trim();
    const focusedSpeakerAgeMs = now - Number(session?.focusedSpeakerAt || 0);
    const focusedSpeakerFollowup =
      !directAddressed &&
      normalizedUserId &&
      focusedSpeakerUserId &&
      normalizedUserId === focusedSpeakerUserId &&
      focusedSpeakerAgeMs >= 0 &&
      focusedSpeakerAgeMs <= FOCUSED_SPEAKER_CONTINUATION_MS;
    if (focusedSpeakerFollowup) {
      return {
        allow: true,
        reason: "focused_speaker_followup",
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
    const llmProvider = normalizeVoiceReplyDecisionProvider(replyDecisionLlm?.provider);
    const llmModel = String(replyDecisionLlm?.model || defaultVoiceReplyDecisionModel(llmProvider))
      .trim()
      .slice(0, 120) || defaultVoiceReplyDecisionModel(llmProvider);

    if (!this.llm?.generate) {
      if (directAddressed) {
        return {
          allow: true,
          reason: "direct_address_no_decider",
          participantCount,
          directAddressed,
          transcript: normalizedTranscript,
          llmProvider,
          llmModel
        };
      }
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

    const speakerName = this.resolveVoiceSpeakerName(session, userId) || "someone";
    const botName = getPromptBotName(settings);
    const participantList = this.getVoiceChannelParticipants(session)
      .map((entry) => entry.displayName)
      .filter(Boolean)
      .slice(0, 10);
    const recentHistory = this.formatVoiceDecisionHistory(session, 6);
    const compactHistory = this.formatVoiceDecisionHistory(session, 3);
    const shouldLoadMemoryContext = Boolean(directAddressed);
    const memoryContext = shouldLoadMemoryContext
      ? await this.buildVoiceDecisionMemoryContext({
          session,
          settings,
          userId,
          transcript: normalizedTranscript,
          source
        })
      : "";
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

    const fullContextPromptParts = [
      `Reply eagerness: ${replyEagerness}/100.`,
      `Human participants in channel: ${participantCount}.`,
      `Current speaker: ${speakerName}.`,
      `Directly addressed: ${directAddressed ? "yes" : "no"}.`,
      `Latest transcript: "${normalizedTranscript}".`
    ];
    if (participantList.length) {
      fullContextPromptParts.push(`Participants: ${participantList.join(", ")}.`);
    }
    if (recentHistory) {
      fullContextPromptParts.push(`Recent voice turns:\n${recentHistory}`);
    }
    if (memoryContext) {
      fullContextPromptParts.push(`Decision context hints (never say these hints): ${memoryContext}`);
    }

    const compactContextPromptParts = [
      `Current speaker: ${speakerName}.`,
      `Directly addressed: ${directAddressed ? "yes" : "no"}.`,
      `Reply eagerness: ${replyEagerness}/100.`,
      `Participants: ${participantCount}.`,
      `Transcript: "${normalizedTranscript}".`
    ];
    if (participantList.length) {
      compactContextPromptParts.push(`Known participants: ${participantList.join(", ")}.`);
    }
    if (compactHistory) {
      compactContextPromptParts.push(`Recent turns:\n${compactHistory}`);
    }
    if (memoryContext) {
      compactContextPromptParts.push(`Hints: ${memoryContext}`);
    }

    const systemPromptCompact = [
      `You decide if "${botName}" should reply right now in a live Discord voice chat.`,
      "Output exactly one token: YES or NO.",
      "Prefer YES for direct wake-word mentions and likely ASR variants of the bot name.",
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
      "Treat likely ASR wake-word variants (for example clanky/planky/linky) as direct address.",
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
        userPrompt: `Directly addressed: ${directAddressed ? "yes" : "no"}.\nTranscript: "${normalizedTranscript}".`
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
          if (directAddressed && !parsed.allow) {
            return {
              allow: true,
              reason: index === 0 ? "direct_address_override_llm_no" : "direct_address_override_llm_no_retry",
              participantCount,
              directAddressed,
              transcript: normalizedTranscript,
              llmResponse: raw,
              llmProvider: resolvedProvider,
              llmModel: resolvedModel
            };
          }
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
      } catch (error) {
        generationErrors.push({
          step: step.label,
          error: String(error?.message || error)
        });
      }
    }

    if (!invalidOutputs.length && generationErrors.length) {
      if (directAddressed) {
        return {
          allow: true,
          reason: "direct_address_llm_error_fallback",
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
        reason: "llm_error",
        participantCount,
        directAddressed,
        transcript: normalizedTranscript,
        llmProvider,
        llmModel,
        error: generationErrors.map((row) => `${row.step}: ${row.error}`).join(" | ")
      };
    }

    if (directAddressed) {
      return {
        allow: true,
        reason: "direct_address_contract_fallback",
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

  async buildVoiceDecisionMemoryContext({ session, settings, userId, transcript = "", source = "voice_turn" }) {
    if (!settings?.memory?.enabled) return "";
    if (!this.memory || typeof this.memory.buildPromptMemorySlice !== "function") return "";

    const normalizedUserId = String(userId || "").trim();
    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedUserId || !normalizedTranscript) return "";

    try {
      const slice = await this.memory.buildPromptMemorySlice({
        userId: normalizedUserId,
        guildId: session.guildId,
        channelId: null,
        queryText: normalizedTranscript,
        settings,
        trace: {
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: normalizedUserId,
          source: "voice_reply_decision_memory",
          mode: session.mode,
          trigger: String(source || "voice_turn")
        }
      });
      const allFacts = [
        ...(Array.isArray(slice?.userFacts) ? slice.userFacts : []),
        ...(Array.isArray(slice?.relevantFacts) ? slice.relevantFacts : [])
      ];
      return formatRealtimeMemoryFacts(allFacts, 4);
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: normalizedUserId,
        content: `voice_reply_decision_memory_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
      return "";
    }
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

  updateFocusedSpeakerWindow({ session, userId = null, allow = false, directAddressed = false, reason = "" } = {}) {
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

  async prepareOpenAiRealtimeTurnContext({ session, settings, userId, transcript = "", captureReason = "stream_end" }) {
    if (!session || session.ending) return;
    if (session.mode !== "openai_realtime") return;

    const normalizedTranscript = normalizeVoiceText(transcript, REALTIME_CONTEXT_TRANSCRIPT_MAX_CHARS);
    const memorySlice = await this.buildOpenAiRealtimeMemorySlice({
      session,
      settings,
      userId,
      transcript: normalizedTranscript,
      captureReason
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

  async buildOpenAiRealtimeMemorySlice({ session, settings, userId, transcript = "", captureReason = "stream_end" }) {
    const empty = {
      userFacts: [],
      relevantFacts: []
    };

    if (!settings?.memory?.enabled) return empty;
    if (!this.memory || typeof this.memory !== "object") return empty;

    const normalizedUserId = String(userId || "").trim();
    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedUserId || !normalizedTranscript) return empty;

    if (typeof this.memory.ingestMessage === "function") {
      try {
        await this.memory.ingestMessage({
          messageId: `voice-${String(session.guildId || "guild")}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          authorId: normalizedUserId,
          authorName: this.resolveVoiceSpeakerName(session, normalizedUserId) || "unknown",
          content: normalizedTranscript,
          settings,
          trace: {
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: normalizedUserId,
            source: "voice_realtime_ingest"
          }
        });
      } catch (error) {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: normalizedUserId,
          content: `voice_realtime_memory_ingest_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id,
            captureReason: String(captureReason || "stream_end")
          }
        });
      }
    }

    if (typeof this.memory.buildPromptMemorySlice !== "function") {
      return empty;
    }

    try {
      const slice = await this.memory.buildPromptMemorySlice({
        userId: normalizedUserId,
        guildId: session.guildId,
        channelId: null,
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
    if (!turnDecision.allow) return;

    if (typeof this.generateVoiceTurn !== "function") return;

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
    try {
      const generated = await this.generateVoiceTurn({
        settings,
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        transcript,
        contextMessages,
        sessionId: session.id,
        isEagerTurn: !turnDecision.directAddressed,
        voiceEagerness: Number(settings?.voice?.replyEagerness) || 0,
        soundboardCandidates: soundboardCandidateLines
      });
      const generatedPayload =
        generated && typeof generated === "object"
          ? generated
          : {
              text: generated,
              soundboardRef: null
            };
      replyText = normalizeVoiceText(generatedPayload?.text || "", STT_REPLY_MAX_CHARS);
      requestedSoundboardRef = String(generatedPayload?.soundboardRef || "").trim().slice(0, 180);
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
    }
    if (!replyText || session.ending) return;

    session.sttContextMessages = [
      ...contextMessages,
      {
        role: "user",
        content: normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS)
      },
      {
        role: "assistant",
        content: replyText
      }
    ].slice(-STT_CONTEXT_MAX_MESSAGES);

    const ttsModel = String(sttSettings?.ttsModel || "gpt-4o-mini-tts").trim() || "gpt-4o-mini-tts";
    const ttsVoice = String(sttSettings?.ttsVoice || "alloy").trim() || "alloy";
    const ttsSpeedRaw = Number(sttSettings?.ttsSpeed);
    const ttsSpeed = Number.isFinite(ttsSpeedRaw) ? ttsSpeedRaw : 1;
    let ttsPcm = Buffer.alloc(0);
    try {
      const tts = await this.llm.synthesizeSpeech({
        text: replyText,
        model: ttsModel,
        voice: ttsVoice,
        speed: ttsSpeed,
        responseFormat: "pcm",
        trace: {
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          source: "voice_stt_pipeline_tts"
        }
      });
      ttsPcm = tts.audioBuffer;
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `stt_pipeline_tts_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          model: ttsModel,
          voice: ttsVoice
        }
      });
      return;
    }
    if (!ttsPcm.length || session.ending) return;

    const discordPcm = convertXaiOutputToDiscordPcm(ttsPcm, 24000);
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

    try {
      session.lastAudioDeltaAt = Date.now();
      session.botAudioStream.write(discordPcm);
      this.markBotTurnOut(session, settings);
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
    session.pendingResponse = null;

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
      const fallbackText = String(announcement === undefined ? defaultExitMessage(reason) : announcement || "").trim();
      if (fallbackText) {
        await this.sendOperationalMessage({
          channel,
          settings: settings || session.settingsSnapshot,
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: requestedByUserId || this.client.user?.id || null,
          messageId,
          event: "voice_session_end",
          reason,
          details: {
            voiceChannelId: session.voiceChannelId,
            durationSeconds
          },
          fallback: fallbackText
        });
      }
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
    const lines = [
      `You are ${botName}, a real-feeling regular in a Discord server, speaking in live voice chat.`,
      `Stay in-character as ${botName}. Style: ${style}.`,
      "Talk like a person hanging out, not like an assistant.",
      "Use occasional slang naturally (not every sentence).",
      ...voiceToneGuardrails,
      allowNsfwHumor
        ? "Adult/NSFW humor is allowed for consenting adults, but never include minors, coercion, or targeted harassment."
        : "Keep humor non-sexual by default unless users explicitly request a safe toned-down joke.",
      PROMPT_CAPABILITY_HONESTY_LINE,
      memoryEnabled
        ? "You have persistent memory across conversations via saved durable facts. Do not claim each conversation starts from zero."
        : "Persistent memory is disabled right now. Do not claim long-term memory across separate conversations.",
      "If asked to do something impossible, say it casually.",
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
    fallback = ""
  }) {
    const fallbackText = String(fallback || "").trim();
    const resolvedSettings =
      settings || (typeof this.store?.getSettings === "function" ? this.store.getSettings() : null);
    const detailsPayload =
      details && typeof details === "object" && !Array.isArray(details)
        ? details
        : { detail: String(details || "") };

    const resolvedChannel = await this.resolveOperationalChannel(channel, channelId, {
      guildId,
      userId,
      messageId,
      event,
      reason
    });
    if (!resolvedChannel) {
      this.store.logAction({
        kind: "voice_error",
        guildId: guildId || null,
        channelId: channelId || channel?.id || null,
        messageId: messageId || null,
        userId: userId || this.client.user?.id || null,
        content: "voice_message_channel_unavailable",
        metadata: {
          event,
          reason
        }
      });
      return false;
    }

    let composedText = "";
    if (this.composeOperationalMessage && resolvedSettings) {
      try {
        composedText = String(
          (await this.composeOperationalMessage({
            settings: resolvedSettings,
            guildId: guildId || null,
            channelId: channelId || channel?.id || null,
            userId: userId || null,
            messageId: messageId || null,
            event: String(event || "voice_runtime"),
            reason: reason ? String(reason) : null,
            details: detailsPayload,
            fallbackText
          })) || ""
        ).trim();
      } catch (error) {
        this.store.logAction({
          kind: "voice_error",
          guildId: guildId || null,
          channelId: channelId || channel?.id || null,
          messageId: messageId || null,
          userId: userId || this.client.user?.id || null,
          content: `voice_message_compose_failed: ${String(error?.message || error)}`,
          metadata: {
            event,
            reason
          }
        });
      }
    }

    const content = String(composedText || fallbackText).trim();
    if (!content) return false;
    return await this.sendToChannel(resolvedChannel, content, {
      guildId,
      channelId: channelId || resolvedChannel?.id || null,
      userId,
      messageId,
      event,
      reason
    });
  }

  async resolveOperationalChannel(channel, channelId, { guildId = null, userId = null, messageId = null, event, reason } = {}) {
    if (channel && typeof channel.send === "function") return channel;

    const resolvedChannelId = String(channelId || channel?.id || "").trim();
    if (!resolvedChannelId) return null;

    try {
      const fetched = await this.client.channels.fetch(resolvedChannelId);
      if (fetched && typeof fetched.send === "function") return fetched;
      return null;
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: guildId || null,
        channelId: resolvedChannelId || null,
        messageId: messageId || null,
        userId: userId || this.client.user?.id || null,
        content: `voice_message_channel_fetch_failed: ${String(error?.message || error)}`,
        metadata: {
          event,
          reason
        }
      });
      return null;
    }
  }

  async sendToChannel(channel, text, { guildId = null, channelId = null, userId = null, messageId = null, event, reason } = {}) {
    if (!channel || typeof channel.send !== "function") return false;
    const content = String(text || "").trim();
    if (!content) return false;

    try {
      await channel.send(content);
      return true;
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: guildId || null,
        channelId: channelId || channel?.id || null,
        messageId: messageId || null,
        userId: userId || this.client.user?.id || null,
        content: `voice_message_send_failed: ${String(error?.message || error)}`,
        metadata: {
          event,
          reason
        }
      });
      return false;
    }
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

  composeMissingPermissionFallback(permissionInfo) {
    if (!permissionInfo) return "";
    if (permissionInfo.reason === "bot_member_unavailable") {
      return "can't resolve my voice permissions in this server yet.";
    }

    const missing = Array.isArray(permissionInfo.missingPermissions)
      ? permissionInfo.missingPermissions.filter(Boolean)
      : [];
    if (!missing.length) {
      return "i need voice permissions in that vc before i can join.";
    }

    return `i need ${formatNaturalList(missing)} permissions in that vc before i can join.`;
  }
}

function isLowSignalVoiceFragment(transcript = "") {
  const normalized = String(transcript || "").trim();
  if (!normalized) return true;
  if (/[?¿؟？]/u.test(normalized)) return false;
  if (/^(who|what|when|where|why|how|can|could|would|should|do|does|did|is|are|am|will|won'?t)\b/i.test(normalized)) {
    return false;
  }

  const alnumChars = (normalized.match(/[\p{L}\p{N}]/gu) || []).length;
  const wordCount = normalized.split(/\s+/u).filter(Boolean).length;
  if (wordCount >= 3 && alnumChars >= 6) {
    return false;
  }
  if (alnumChars >= VOICE_LOW_SIGNAL_MIN_ALNUM_CHARS && wordCount >= VOICE_LOW_SIGNAL_MIN_WORDS) {
    return false;
  }

  return true;
}

function isLikelyWakeWordPing(transcript = "") {
  const normalized = String(transcript || "")
    .toLowerCase()
    .trim();
  if (!normalized) return false;

  const tokenCount = normalized
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/u)
    .filter(Boolean).length;
  return tokenCount > 0 && tokenCount <= 3;
}

function normalizeVoiceReplyDecisionProvider(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "anthropic") return "anthropic";
  if (normalized === "xai") return "xai";
  if (normalized === "claude-code") return "claude-code";
  return "openai";
}

export function resolveRealtimeTurnTranscriptionPlan({
  mode,
  configuredModel = "gpt-4o-mini-transcribe",
  pcmByteLength = 0,
  sampleRateHz = 24000
}) {
  const normalizedModel = String(configuredModel || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
  if (String(mode || "") !== "openai_realtime") {
    return {
      primaryModel: normalizedModel,
      fallbackModel: null,
      reason: "configured_model"
    };
  }

  if (normalizedModel !== "gpt-4o-mini-transcribe") {
    return {
      primaryModel: normalizedModel,
      fallbackModel: null,
      reason: "configured_non_mini_model"
    };
  }

  const clipDurationMs = estimatePcm16MonoDurationMs(pcmByteLength, sampleRateHz);
  if (clipDurationMs > 0 && clipDurationMs <= OPENAI_REALTIME_SHORT_CLIP_ASR_MS) {
    return {
      primaryModel: "gpt-4o-transcribe",
      fallbackModel: null,
      reason: "short_clip_prefers_full_model"
    };
  }

  return {
    primaryModel: normalizedModel,
    fallbackModel: "gpt-4o-transcribe",
    reason: "mini_with_full_fallback"
  };
}

function estimatePcm16MonoDurationMs(pcmByteLength, sampleRateHz = 24000) {
  const normalizedBytes = Math.max(0, Number(pcmByteLength) || 0);
  const normalizedRate = Math.max(1, Number(sampleRateHz) || 24000);
  return Math.round((normalizedBytes / (PCM16_MONO_BYTES_PER_SAMPLE * normalizedRate)) * 1000);
}

function defaultVoiceReplyDecisionModel(provider) {
  if (provider === "anthropic") return "claude-haiku-4-5";
  if (provider === "xai") return "grok-3-mini-latest";
  if (provider === "claude-code") return "sonnet";
  return "gpt-4.1-mini";
}

export function parseVoiceDecisionContract(rawText) {
  const normalized = String(rawText || "").trim();
  if (!normalized) {
    return {
      allow: false,
      confident: false
    };
  }

  const unwrapped = normalized.replace(/^```(?:[a-z]+)?\s*/i, "").replace(/```$/i, "").trim();
  try {
    const parsedJson = JSON.parse(unwrapped);
    const jsonDecisionValue =
      typeof parsedJson === "string"
        ? parsedJson
        : parsedJson && typeof parsedJson === "object"
          ? parsedJson.decision || parsedJson.answer || parsedJson.value || ""
          : "";
    const jsonDecision = String(jsonDecisionValue || "").trim().toUpperCase();
    if (jsonDecision === "YES") {
      return {
        allow: true,
        confident: true
      };
    }
    if (jsonDecision === "NO") {
      return {
        allow: false,
        confident: true
      };
    }
  } catch {
    // ignore invalid JSON and continue with token parsing fallback
  }

  const quoted = unwrapped
    .replace(/^["'`]\s*/g, "")
    .replace(/\s*["'`]$/g, "")
    .trim()
    .toUpperCase();
  if (quoted === "YES") {
    return {
      allow: true,
      confident: true
    };
  }
  if (quoted === "NO") {
    return {
      allow: false,
      confident: true
    };
  }

  return {
    allow: false,
    confident: false
  };
}
