import { randomUUID } from "node:crypto";
import {
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  StreamType,
  VoiceConnectionStatus
} from "@discordjs/voice";
import { clamp } from "../utils.ts";
import { OpenAiRealtimeClient } from "./openaiRealtimeClient.ts";
import { GeminiRealtimeClient } from "./geminiRealtimeClient.ts";
import { XaiRealtimeClient } from "./xaiRealtimeClient.ts";
import { ElevenLabsRealtimeClient } from "./elevenLabsRealtimeClient.ts";
import {
  createBotAudioPlaybackStream,
  SOUNDBOARD_MAX_CANDIDATES,
  isRealtimeMode,
  resolveRealtimeProvider,
  resolveVoiceRuntimeMode,
  shortError
} from "./voiceSessionHelpers.ts";

const MIN_MAX_SESSION_MINUTES = 1;
const MAX_MAX_SESSION_MINUTES = 120;
const MIN_INACTIVITY_SECONDS = 20;
const MAX_INACTIVITY_SECONDS = 3600;

function createRealtimeRuntimeLogger(manager, { guildId, channelId, botUserId }) {
  return ({ level, event, metadata }) => {
    manager.store.logAction({
      kind: level === "warn" ? "voice_error" : "voice_runtime",
      guildId,
      channelId,
      userId: botUserId,
      content: event,
      metadata
    });
  };
}

export async function requestJoin(manager, { message, settings, intentConfidence = null }) {
  if (!message?.guild || !message?.member || !message?.channel) return false;

  const guildId = String(message.guild.id);
  const userId = String(message.author?.id || "");
  if (!userId) return false;

  return await manager.withJoinLock(guildId, async () => {
    if (!settings?.voice?.enabled) {
      await manager.sendOperationalMessage({
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
        }
      });
      return true;
    }

    const blockedUsers = settings.voice?.blockedVoiceUserIds || [];
    if (blockedUsers.includes(userId)) {
      await manager.sendOperationalMessage({
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
        }
      });
      return true;
    }

    const memberVoiceChannel = message.member.voice?.channel;
    if (!memberVoiceChannel) {
      await manager.sendOperationalMessage({
        channel: message.channel,
        settings,
        guildId,
        channelId: message.channelId,
        userId,
        messageId: message.id,
        event: "voice_join_request",
        reason: "requester_not_in_voice",
        details: {}
      });
      return true;
    }

    const targetVoiceChannelId = String(memberVoiceChannel.id);
    const blockedChannels = settings.voice?.blockedVoiceChannelIds || [];
    const allowedChannels = settings.voice?.allowedVoiceChannelIds || [];

    if (blockedChannels.includes(targetVoiceChannelId)) {
      await manager.sendOperationalMessage({
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
        }
      });
      return true;
    }

    if (allowedChannels.length > 0 && !allowedChannels.includes(targetVoiceChannelId)) {
      await manager.sendOperationalMessage({
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
        }
      });
      return true;
    }

    const maxSessionsPerDay = clamp(Number(settings.voice?.maxSessionsPerDay) || 0, 0, 120);
    if (maxSessionsPerDay > 0) {
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const startedLastDay = manager.store.countActionsSince("voice_session_start", since24h);
      if (startedLastDay >= maxSessionsPerDay) {
        await manager.sendOperationalMessage({
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
          }
        });
        return true;
      }
    }

    const existing = manager.sessions.get(guildId);
    if (existing) {
      if (existing.voiceChannelId === targetVoiceChannelId) {
        manager.touchActivity(guildId, settings);
        await manager.sendOperationalMessage({
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
          mustNotify: false
        });
        return true;
      }

      await manager.endSession({
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
    if (runtimeMode === "voice_agent" && !manager.appConfig?.xaiApiKey) {
      await manager.sendOperationalMessage({
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
        }
      });
      return true;
    }
    if (runtimeMode === "openai_realtime" && !manager.appConfig?.openaiApiKey) {
      await manager.sendOperationalMessage({
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
        }
      });
      return true;
    }
    if (runtimeMode === "gemini_realtime" && !manager.appConfig?.geminiApiKey) {
      await manager.sendOperationalMessage({
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
        }
      });
      return true;
    }
    if (runtimeMode === "elevenlabs_realtime" && !manager.appConfig?.elevenLabsApiKey) {
      await manager.sendOperationalMessage({
        channel: message.channel,
        settings,
        guildId,
        channelId: message.channelId,
        userId,
        messageId: message.id,
        event: "voice_join_request",
        reason: "elevenlabs_api_key_missing",
        details: {
          mode: runtimeMode
        }
      });
      return true;
    }
    if (runtimeMode === "elevenlabs_realtime") {
      const elevenLabsSettings = settings.voice?.elevenLabsRealtime || {};
      const elevenLabsAgentId = String(elevenLabsSettings.agentId || "").trim();
      if (!elevenLabsAgentId) {
        await manager.sendOperationalMessage({
          channel: message.channel,
          settings,
          guildId,
          channelId: message.channelId,
          userId,
          messageId: message.id,
          event: "voice_join_request",
          reason: "elevenlabs_agent_id_missing",
          details: {
            mode: runtimeMode
          }
        });
        return true;
      }
    }
    if (runtimeMode === "stt_pipeline") {
      if (!manager.llm?.isAsrReady?.()) {
        await manager.sendOperationalMessage({
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
          }
        });
        return true;
      }
      if (!manager.llm?.isSpeechSynthesisReady?.()) {
        await manager.sendOperationalMessage({
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
          }
        });
        return true;
      }
      if (typeof manager.generateVoiceTurn !== "function") {
        await manager.sendOperationalMessage({
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
          }
        });
        return true;
      }
    }

    const missingPermissionInfo = manager.getMissingJoinPermissionInfo({
      guild: message.guild,
      voiceChannel: memberVoiceChannel
    });
    if (missingPermissionInfo) {
      await manager.sendOperationalMessage({
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
        }
      });
      return true;
    }

    const maxSessionMinutes = clamp(
      Number(settings.voice?.maxSessionMinutes) || 30,
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
        const activeOrPendingSessions = manager.sessions.size + manager.pendingSessionGuildIds.size;
        if (activeOrPendingSessions >= maxConcurrentSessions) {
          await manager.sendOperationalMessage({
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
            }
          });
          return true;
        }

        manager.pendingSessionGuildIds.add(guildId);
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

      const initialSoundboardCandidateInfo = await manager.resolveSoundboardCandidates({
        settings,
        guild: message.guild
      });
      const initialSoundboardCandidates = Array.isArray(initialSoundboardCandidateInfo?.candidates)
        ? initialSoundboardCandidateInfo.candidates
        : [];
      const baseVoiceInstructions = manager.buildVoiceInstructions(settings, {
        soundboardCandidates: initialSoundboardCandidates
      });
      const realtimeRuntimeLogger = createRealtimeRuntimeLogger(manager, {
        guildId,
        channelId: message.channelId,
        botUserId: manager.client.user?.id || null
      });
      if (runtimeMode === "voice_agent") {
        realtimeClient = new XaiRealtimeClient({
          apiKey: manager.appConfig.xaiApiKey,
          logger: realtimeRuntimeLogger
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
          apiKey: manager.appConfig.openaiApiKey,
          logger: realtimeRuntimeLogger
        });

        const openAiRealtimeSettings = settings.voice?.openaiRealtime || {};
        realtimeInputSampleRateHz = 24000;
        realtimeOutputSampleRateHz = 24000;
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
          apiKey: manager.appConfig.geminiApiKey,
          baseUrl:
            String(geminiRealtimeSettings.apiBaseUrl || "https://generativelanguage.googleapis.com").trim() ||
            "https://generativelanguage.googleapis.com",
          logger: realtimeRuntimeLogger
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
      } else if (runtimeMode === "elevenlabs_realtime") {
        const elevenLabsRealtimeSettings = settings.voice?.elevenLabsRealtime || {};
        realtimeClient = new ElevenLabsRealtimeClient({
          apiKey: manager.appConfig.elevenLabsApiKey,
          baseUrl:
            String(elevenLabsRealtimeSettings.apiBaseUrl || "https://api.elevenlabs.io").trim() ||
            "https://api.elevenlabs.io",
          logger: realtimeRuntimeLogger
        });
        realtimeInputSampleRateHz = Number(elevenLabsRealtimeSettings.inputSampleRateHz) || 16000;
        realtimeOutputSampleRateHz = Number(elevenLabsRealtimeSettings.outputSampleRateHz) || 16000;
        await realtimeClient.connect({
          agentId: String(elevenLabsRealtimeSettings.agentId || "").trim(),
          instructions: baseVoiceInstructions,
          inputSampleRateHz: realtimeInputSampleRateHz,
          outputSampleRateHz: realtimeOutputSampleRateHz
        });
      }

      audioPlayer = createAudioPlayer();
      botAudioStream = createBotAudioPlaybackStream();
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
        transcriptTurns: [],
        modelContextSummary: {
          generation: null,
          decider: null
        },
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
        bargeInSuppressionUntil: 0,
        bargeInSuppressedAudioChunks: 0,
        bargeInSuppressedAudioBytes: 0,
        lastBotActivityTouchAt: 0,
        responseFlushTimer: null,
        responseWatchdogTimer: null,
        responseDoneGraceTimer: null,
        botDisconnectTimer: null,
        lastResponseRequestAt: 0,
        lastAudioDeltaAt: 0,
        lastAssistantReplyAt: 0,
        lastDirectAddressAt: 0,
        lastDirectAddressUserId: null,
        lastInboundAudioAt: 0,
        pendingRealtimeInputBytes: 0,
        lastAudioPipelineRepairAt: 0,
        lastBotAudioStreamLifecycle: null,
        nextResponseRequestId: 0,
        pendingResponse: null,
        pendingSttTurns: 0,
        sttTurnDrainActive: false,
        pendingSttTurnsQueue: [],
        realtimeTurnDrainActive: false,
        pendingRealtimeTurns: [],
        pendingDeferredTurns: [],
        deferredTurnFlushTimer: null,
        thoughtLoopTimer: null,
        thoughtLoopBusy: false,
        nextThoughtAt: 0,
        lastThoughtAttemptAt: 0,
        lastThoughtSpokenAt: 0,
        userCaptures: new Map(),
        streamWatch: {
          active: false,
          targetUserId: null,
          requestedByUserId: null,
          lastFrameAt: 0,
          lastCommentaryAt: 0,
          lastBrainContextAt: 0,
          lastBrainContextProvider: null,
          lastBrainContextModel: null,
          brainContextEntries: [],
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
        membershipEvents: [],
        voiceLookupBusyCount: 0,
        lastSuppressedCaptureLogAt: 0,
        baseVoiceInstructions,
        lastOpenAiRealtimeInstructions: "",
        lastOpenAiRealtimeInstructionsAt: 0,
        realtimeInstructionRefreshTimer: null,
        settingsSnapshot: settings,
        audioPlaybackQueue: {
          chunks: [],
          headOffset: 0,
          queuedBytes: 0,
          pumping: false,
          timer: null,
          waitingDrain: false,
          drainHandler: null,
          lastWarnAt: 0,
          lastTrimAt: 0
        },
        cleanupHandlers: [],
        ending: false
      };

      manager.sessions.set(guildId, session);
      manager.bindAudioPlayerHandlers(session);
      manager.bindBotAudioStreamLifecycle(session, {
        stream: botAudioStream,
        source: "session_start"
      });
      manager.bindSessionHandlers(session, settings);
      if (isRealtimeMode(runtimeMode)) {
        manager.bindRealtimeHandlers(session, settings);
      }
      if (runtimeMode === "openai_realtime") {
        manager.scheduleOpenAiRealtimeInstructionRefresh({
          session,
          settings,
          reason: "session_start"
        });
      }
      manager.startSessionTimers(session, settings);

      manager.store.logAction({
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
            Number(settings.voice?.inactivityLeaveSeconds) || 300,
            MIN_INACTIVITY_SECONDS,
            MAX_INACTIVITY_SECONDS
          ),
          intentConfidence
        }
      });

      return true;
    } catch (error) {
      const errorText = String(error?.message || error);
      manager.store.logAction({
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

      await manager.sendOperationalMessage({
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
        }
      });
      return true;
    } finally {
      if (reservedConcurrencySlot) {
        manager.pendingSessionGuildIds.delete(guildId);
      }
    }
  });
}
