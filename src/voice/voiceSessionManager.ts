import { randomUUID } from "node:crypto";
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
import prism from "prism-media";
import { clamp } from "../utils.ts";
import { convertDiscordPcmToXaiInput, convertXaiOutputToDiscordPcm } from "./pcmAudio.ts";
import { SoundboardDirector } from "./soundboardDirector.ts";
import { XaiRealtimeClient } from "./xaiRealtimeClient.ts";

const MIN_MAX_SESSION_MINUTES = 1;
const MAX_MAX_SESSION_MINUTES = 120;
const MIN_INACTIVITY_SECONDS = 20;
const MAX_INACTIVITY_SECONDS = 3600;
const INPUT_SPEECH_END_SILENCE_MS = 900;
const BOT_TURN_SILENCE_RESET_MS = 1200;

export class VoiceSessionManager {
  constructor({ client, store, appConfig }) {
    this.client = client;
    this.store = store;
    this.appConfig = appConfig;
    this.sessions = new Map();
    this.soundboardDirector = new SoundboardDirector({
      client,
      store,
      appConfig
    });

    this.client.on("voiceStateUpdate", (oldState, newState) => {
      this.handleVoiceStateUpdate(oldState, newState).catch((error) => {
        this.store.logAction({
          kind: "voice_error",
          guildId: newState?.guild?.id || oldState?.guild?.id || null,
          channelId: newState?.channelId || oldState?.channelId || null,
          userId: this.client.user?.id || null,
          content: `voice_state_update: ${String(error?.message || error)}`
        });
      });
    });
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
      xai: session.xaiClient?.getState?.() || null
    }));

    return {
      activeCount: sessions.length,
      sessions
    };
  }

  async requestJoin({ message, settings, intentConfidence = null }) {
    if (!message?.guild || !message?.member || !message?.channel) return false;

    if (!settings?.voice?.enabled || !settings?.voice?.joinOnTextNL) {
      await this.sendToChannel(message.channel, "voice mode is off rn. ask an admin to enable it.");
      return true;
    }

    const guildId = String(message.guild.id);
    const userId = String(message.author?.id || "");
    if (!userId) return false;

    const blockedUsers = settings.voice?.blockedVoiceUserIds || [];
    if (blockedUsers.includes(userId)) {
      await this.sendToChannel(message.channel, "you are blocked from voice controls here.");
      return true;
    }

    const memberVoiceChannel = message.member.voice?.channel;
    if (!memberVoiceChannel) {
      await this.sendToChannel(message.channel, "join a vc first, then ping me to hop in.");
      return true;
    }

    const targetVoiceChannelId = String(memberVoiceChannel.id);
    const blockedChannels = settings.voice?.blockedVoiceChannelIds || [];
    const allowedChannels = settings.voice?.allowedVoiceChannelIds || [];

    if (blockedChannels.includes(targetVoiceChannelId)) {
      await this.sendToChannel(message.channel, "that voice channel is blocked for me.");
      return true;
    }

    if (allowedChannels.length > 0 && !allowedChannels.includes(targetVoiceChannelId)) {
      await this.sendToChannel(message.channel, "i can only join allowlisted voice channels here.");
      return true;
    }

    const maxSessionsPerDay = clamp(Number(settings.voice?.maxSessionsPerDay) || 0, 0, 120);
    if (maxSessionsPerDay > 0) {
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const startedLastDay = this.store.countActionsSince("voice_session_start", since24h);
      if (startedLastDay >= maxSessionsPerDay) {
        await this.sendToChannel(message.channel, "daily voice session limit hit for now.");
        return true;
      }
    }

    const existing = this.sessions.get(guildId);
    if (existing) {
      if (existing.voiceChannelId === targetVoiceChannelId) {
        this.touchActivity(guildId, settings);
        await this.sendToChannel(message.channel, "already in your vc.");
        return true;
      }

      await this.endSession({
        guildId,
        reason: "switch_channel",
        requestedByUserId: userId,
        announcement: "switching voice channels."
      });
    }

    const maxConcurrentGuildSessions = clamp(Number(settings.voice?.maxConcurrentGuildSessions) || 1, 1, 3);
    if (!existing && this.sessions.size >= maxConcurrentGuildSessions) {
      await this.sendToChannel(message.channel, "voice session cap reached right now.");
      return true;
    }

    if (!this.appConfig?.xaiApiKey) {
      await this.sendToChannel(message.channel, "voice runtime is not configured yet (missing `XAI_API_KEY`).");
      return true;
    }

    const maxSessionMinutes = clamp(
      Number(settings.voice?.maxSessionMinutes) || 10,
      MIN_MAX_SESSION_MINUTES,
      MAX_MAX_SESSION_MINUTES
    );

    let connection = null;
    let xaiClient = null;
    let audioPlayer = null;
    let botAudioStream = null;

    try {
      connection = joinVoiceChannel({
        channelId: memberVoiceChannel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
      });

      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

      xaiClient = new XaiRealtimeClient({
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
      await xaiClient.connect({
        voice: xaiSettings.voice || "Rex",
        instructions: this.buildVoiceInstructions(settings),
        region: xaiSettings.region || "us-east-1",
        inputAudioFormat: xaiSettings.audioFormat || "audio/pcm",
        outputAudioFormat: xaiSettings.audioFormat || "audio/pcm"
      });

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
        connection,
        xaiClient,
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
        userCaptures: new Map(),
        soundboard: {
          playCount: 0,
          lastPlayedAt: 0
        },
        cleanupHandlers: [],
        ending: false
      };

      this.sessions.set(guildId, session);
      this.bindAudioPlayerHandlers(session);
      this.bindSessionHandlers(session, settings);
      this.bindXaiHandlers(session);
      this.startSessionTimers(session, settings);

      this.store.logAction({
        kind: "voice_session_start",
        guildId,
        channelId: message.channelId,
        userId,
        content: `voice_joined:${targetVoiceChannelId}`,
        metadata: {
          sessionId: session.id,
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

      await this.sendToChannel(
        message.channel,
        `hopping in <#${targetVoiceChannelId}> for up to ${maxSessionMinutes}m.`
      );

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

      if (xaiClient) {
        await xaiClient.close().catch(() => undefined);
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

      await this.sendToChannel(message.channel, `couldn't join voice: ${shortError(errorText)}`);
      return true;
    }
  }

  async requestLeave({ message, reason = "nl_leave" }) {
    if (!message?.guild || !message?.channel) return false;

    const guildId = String(message.guild.id);
    if (!this.sessions.has(guildId)) {
      await this.sendToChannel(message.channel, "i'm not in vc right now.");
      return true;
    }

    await this.endSession({
      guildId,
      reason,
      requestedByUserId: message.author?.id || null,
      announceChannel: message.channel,
      announcement: "aight i'm leaving vc."
    });

    return true;
  }

  async requestStatus({ message }) {
    if (!message?.guild || !message?.channel) return false;

    const guildId = String(message.guild.id);
    const session = this.sessions.get(guildId);

    if (!session) {
      await this.sendToChannel(message.channel, "voice status: offline (not in vc).");
      return true;
    }

    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - session.startedAt) / 1000));
    const remainingSeconds = session.maxEndsAt
      ? Math.max(0, Math.ceil((session.maxEndsAt - Date.now()) / 1000))
      : null;
    const inactivitySeconds = session.inactivityEndsAt
      ? Math.max(0, Math.ceil((session.inactivityEndsAt - Date.now()) / 1000))
      : null;

    await this.sendToChannel(
      message.channel,
      `voice status: in <#${session.voiceChannelId}> | session ${elapsedSeconds}s | ` +
        `max-left ${remainingSeconds ?? "n/a"}s | idle-left ${inactivitySeconds ?? "n/a"}s | ` +
        `capturing ${session.userCaptures.size} speaker(s)`
    );

    return true;
  }

  async maybeHandleSoundboardIntent({ message, settings, text, directlyAddressed = false }) {
    if (!message?.guild || !message?.channel) return false;

    const session = this.getSession(message.guild.id);
    if (!session) return false;
    if (!settings?.voice?.soundboard?.enabled) return false;

    const requested = this.soundboardDirector.resolveManualSoundRequest(text, settings);
    if (!requested) {
      await this.maybeTriggerHeuristicSoundboard({
        message,
        settings,
        text,
        directlyAddressed,
        session
      });
      return false;
    }

    if (!directlyAddressed) {
      return false;
    }

    const result = await this.soundboardDirector.play({
      session,
      settings,
      soundId: requested.soundId,
      sourceGuildId: requested.sourceGuildId,
      reason: requested.reason,
      triggerMessage: message
    });

    if (result.ok) {
      await this.sendToChannel(
        message.channel,
        `soundboard played: ${requested.alias || requested.soundId}`
      );
    } else {
      await this.sendToChannel(message.channel, `can't play that sound rn: ${result.message}`);
    }

    return true;
  }

  async maybeTriggerHeuristicSoundboard({ message, settings, text, directlyAddressed, session }) {
    if (!directlyAddressed) return;

    const hypeCue = /\b(?:let'?s\s*go|lfg|clutch|insane|no\s*way|holy|gg)\b/i.test(String(text || ""));
    if (!hypeCue) return;

    const preferred = settings?.voice?.soundboard?.preferredSoundIds || [];
    if (!Array.isArray(preferred) || !preferred.length) return;

    const soundId = String(preferred[0] || "").trim();
    if (!soundId) return;

    await this.soundboardDirector.play({
      session,
      settings,
      soundId,
      reason: "heuristic_hype",
      triggerMessage: message
    });
  }

  async stopAll(reason = "shutdown") {
    const guildIds = [...this.sessions.keys()];
    for (const guildId of guildIds) {
      await this.endSession({ guildId, reason, announcement: null });
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
        announcement: `max session time (${maxSessionMinutes}m) reached, leaving vc.`
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
        announcement: `no one talked for ${inactivitySeconds}s, leaving vc.`
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

  bindXaiHandlers(session) {
    const onAudioDelta = (audioBase64) => {
      let chunk = null;
      try {
        chunk = Buffer.from(String(audioBase64 || ""), "base64");
      } catch {
        return;
      }
      if (!chunk || !chunk.length) return;

      const discordPcm = convertXaiOutputToDiscordPcm(chunk, 24000);
      if (!discordPcm.length) return;

      session.botAudioStream.write(discordPcm);
      this.markBotTurnOut(session);
    };

    const onTranscript = (text) => {
      const transcript = String(text || "").trim();
      if (!transcript) return;
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "xai_transcript",
        metadata: {
          sessionId: session.id,
          transcript
        }
      });
    };

    session.xaiClient.on("audio_delta", onAudioDelta);
    session.xaiClient.on("transcript", onTranscript);

    session.cleanupHandlers.push(() => {
      session.xaiClient.off("audio_delta", onAudioDelta);
      session.xaiClient.off("transcript", onTranscript);
    });
  }

  markBotTurnOut(session) {
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
          announcement: "voice connection dropped, i'm out."
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
      this.startInboundCapture({
        session,
        userId: String(userId || "")
      });
    };

    speaking.on("start", onSpeakingStart);
    session.cleanupHandlers.push(() => {
      speaking.removeListener("start", onSpeakingStart);
    });
  }

  startInboundCapture({ session, userId }) {
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
      bytesSent: 0
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

    pcmStream.on("data", (chunk) => {
      const normalizedPcm = convertDiscordPcmToXaiInput(chunk);
      if (!normalizedPcm.length) return;
      captureState.bytesSent += normalizedPcm.length;

      try {
        session.xaiClient.appendInputAudioPcm(normalizedPcm);
      } catch (error) {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          content: `audio_append_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id
          }
        });
      }
    });

    let captureFinalized = false;
    const finalizeUserTurn = () => {
      if (captureFinalized) return;
      captureFinalized = true;

      try {
        session.xaiClient.commitInputAudioBuffer();
        session.xaiClient.createAudioResponse();
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

      cleanupCapture();
    };

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

  async endSession({
    guildId,
    reason = "unknown",
    requestedByUserId = null,
    announceChannel = null,
    announcement = null
  }) {
    const session = this.sessions.get(String(guildId));
    if (!session) return false;
    if (session.ending) return false;

    session.ending = true;
    this.sessions.delete(String(guildId));

    if (session.maxTimer) clearTimeout(session.maxTimer);
    if (session.inactivityTimer) clearTimeout(session.inactivityTimer);
    if (session.botTurnResetTimer) clearTimeout(session.botTurnResetTimer);

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
      await session.xaiClient?.close?.();
    } catch {
      // ignore
    }

    try {
      session.connection?.destroy?.();
    } catch {
      // ignore
    }

    const fallbackConnection = getVoiceConnection(String(guildId));
    if (fallbackConnection) {
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
        voiceChannelId: session.voiceChannelId,
        durationSeconds,
        requestedByUserId
      }
    });

    const channel = announceChannel || this.client.channels.cache.get(session.textChannelId);
    const message = announcement === null ? null : announcement || defaultExitMessage(reason);
    if (message) {
      await this.sendToChannel(channel, message);
    }

    return true;
  }

  async handleVoiceStateUpdate(oldState, newState) {
    const botId = String(this.client.user?.id || "");
    if (!botId) return;

    const stateUserId = String(newState?.id || oldState?.id || "");
    if (stateUserId !== botId) return;

    const guildId = String(newState?.guild?.id || oldState?.guild?.id || "");
    if (!guildId) return;

    const session = this.sessions.get(guildId);
    if (!session) return;

    if (!newState?.channelId) {
      await this.endSession({
        guildId,
        reason: "bot_disconnected",
        announcement: "i got disconnected from vc."
      });
      return;
    }

    if (String(newState.channelId) !== session.voiceChannelId) {
      session.voiceChannelId = String(newState.channelId);
      session.lastActivityAt = Date.now();
    }
  }

  buildVoiceInstructions(settings) {
    const hardLimits = Array.isArray(settings?.persona?.hardLimits)
      ? settings.persona.hardLimits
      : [];

    return [
      `You are ${settings?.botName || "clanker conk"} speaking in live Discord voice chat.`,
      "Keep delivery calm, conversational, and low-drama.",
      "Use short turns by default and avoid monologues.",
      "Keep the same playful persona as text chat without being toxic.",
      "Never claim capabilities you do not have.",
      "Hard limitations:",
      ...hardLimits.slice(0, 12).map((line) => `- ${line}`)
    ].join("\n");
  }

  async sendToChannel(channel, text) {
    if (!channel || typeof channel.send !== "function") return false;
    const content = String(text || "").trim();
    if (!content) return false;

    try {
      await channel.send(content);
      return true;
    } catch {
      return false;
    }
  }
}

function defaultExitMessage(reason) {
  if (reason === "max_duration") return "time cap reached, dipping from vc.";
  if (reason === "inactivity_timeout") return "been quiet for a bit, leaving vc.";
  if (reason === "connection_lost" || reason === "bot_disconnected") return "lost the voice connection, i bounced.";
  if (reason === "switch_channel") return "moving channels.";
  return "leaving vc.";
}

function shortError(text) {
  return String(text || "unknown error")
    .replace(/\s+/g, " ")
    .slice(0, 220);
}
