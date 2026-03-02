/**
 * Node.js subprocess entry point for Discord voice.
 *
 * Runs under `node --experimental-strip-types` and owns the entire
 * @discordjs/voice layer: VoiceConnection (UDP), AudioPlayer (20ms timer),
 * Opus encoding, and voice receiver (user audio).
 *
 * Communicates with the main Bun process exclusively via IPC
 * (process.send / process.on("message")).
 */

import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  joinVoiceChannel,
  StreamType,
  VoiceConnectionStatus,
  entersState,
  type AudioPlayer,
  type VoiceConnection
} from "@discordjs/voice";
import { PassThrough } from "node:stream";
import OpusScript from "opusscript";
import prism from "prism-media";
import { convertXaiOutputToDiscordPcm, convertDiscordPcmToXaiInput } from "./pcmAudio.ts";

const AUDIO_DEBUG = !!process.env.AUDIO_DEBUG;
const DISCORD_PCM_FRAME_BYTES = 3840; // 20ms @ 48kHz stereo 16-bit
const OPUS_FRAME_SAMPLES = 960;
const OPUS_SET_BITRATE = 4002;
const OPUS_SET_FEC = 4012;
const OPUS_BITRATE = 64000;

// --- State ---

let connection: VoiceConnection | null = null;
let audioPlayer: AudioPlayer | null = null;
let botAudioStream: PassThrough | null = null;
let adapterMethods: { onVoiceServerUpdate: (data: any) => void; onVoiceStateUpdate: (data: any) => void } | null = null;
let opusEncoder: any = null;
const userSubscriptions = new Map<string, { opusStream: any; decoder: any; pcmStream: any }>();
let defaultSilenceDurationMs = 700;

// --- IPC helpers ---

function send(msg: any) {
  if (typeof process.send === "function") {
    process.send(msg);
  }
}

function sendError(message: string) {
  send({ type: "error", message });
}

// --- Opus encoder ---

function getOpusEncoder() {
  if (!opusEncoder) {
    opusEncoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
    try { opusEncoder.encoderCTL(OPUS_SET_BITRATE, OPUS_BITRATE); } catch { /* ignore */ }
    try { opusEncoder.encoderCTL(OPUS_SET_FEC, 1); } catch { /* ignore */ }
  }
  return opusEncoder;
}

function destroyOpusEncoder() {
  if (opusEncoder) {
    try { opusEncoder.delete?.(); } catch { /* ignore */ }
    opusEncoder = null;
  }
}

// --- Audio playback pipeline ---

function resetPlayback() {
  if (botAudioStream) {
    try { botAudioStream.destroy(); } catch { /* ignore */ }
    botAudioStream = null;
  }
  if (audioPlayer) {
    try { audioPlayer.stop(true); } catch { /* ignore */ }
  }
}

function ensurePlaybackStream() {
  if (botAudioStream && !botAudioStream.destroyed) return true;
  if (!audioPlayer || !connection) return false;

  botAudioStream = new PassThrough();
  const resource = createAudioResource(botAudioStream, {
    inputType: StreamType.Opus
  });
  audioPlayer.play(resource);
  connection.subscribe(audioPlayer);
  return true;
}

function encodePcmToOpus(pcmBuffer: Buffer): Buffer[] {
  const encoder = getOpusEncoder();
  const packets: Buffer[] = [];
  let offset = 0;

  while (offset + DISCORD_PCM_FRAME_BYTES <= pcmBuffer.length) {
    const frame = pcmBuffer.subarray(offset, offset + DISCORD_PCM_FRAME_BYTES);
    offset += DISCORD_PCM_FRAME_BYTES;
    try {
      const opusPacket = encoder.encode(frame, OPUS_FRAME_SAMPLES);
      packets.push(Buffer.from(opusPacket));
    } catch {
      // skip frame on encode error
    }
  }

  return packets;
}

function handleAudio(pcmBase64: string, sampleRate: number) {
  if (!audioPlayer || !connection) return;

  let rawPcm: Buffer;
  try {
    rawPcm = Buffer.from(pcmBase64, "base64");
  } catch {
    return;
  }
  if (!rawPcm.length) return;

  // Convert from provider sample rate to Discord format (48kHz stereo)
  const discordPcm = convertXaiOutputToDiscordPcm(rawPcm, sampleRate);
  if (!discordPcm.length) return;

  // Encode to Opus packets
  const opusPackets = encodePcmToOpus(discordPcm);
  if (!opusPackets.length) return;

  // Ensure stream exists and write packets
  if (!ensurePlaybackStream()) return;

  for (const packet of opusPackets) {
    if (botAudioStream && !botAudioStream.destroyed) {
      botAudioStream.write(packet);
    }
  }
}

function handleStopPlayback() {
  resetPlayback();
  send({ type: "player_state", status: "idle" });
}

// --- Voice connection via adapter proxy ---

function createProxyAdapterCreator(guildId: string, channelId: string) {
  return (methods: any) => {
    adapterMethods = methods;
    return {
      sendPayload(payload: any) {
        // Forward OP4 (voice state update) to main process → Discord gateway
        send({ type: "adapter_send", payload });
        return true;
      },
      destroy() {
        adapterMethods = null;
      }
    };
  };
}

function handleJoin(msg: any) {
  const { guildId, channelId, selfDeaf, selfMute } = msg;

  try {
    connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator: createProxyAdapterCreator(guildId, channelId),
      selfDeaf: selfDeaf ?? false,
      selfMute: selfMute ?? false
    });

    audioPlayer = createAudioPlayer();
    connection.subscribe(audioPlayer);

    // Audio player state tracking
    audioPlayer.on("stateChange", (oldState, newState) => {
      if (AUDIO_DEBUG && oldState.status !== newState.status) {
        console.log(`[subprocess:audio-player] ${oldState.status} → ${newState.status}`);
      }
      send({ type: "player_state", status: newState.status });
    });

    audioPlayer.on("error", (error) => {
      sendError(`audio_player_error: ${String(error?.message || error)}`);
      resetPlayback();
    });

    // Connection state tracking
    connection.on("stateChange", (_oldState, newState) => {
      send({ type: "connection_state", status: newState.status });

      if (newState.status === VoiceConnectionStatus.Ready) {
        send({ type: "ready" });
      }
    });

    // Speaking events from voice receiver — auto-subscribe immediately so
    // there is no IPC round-trip delay before audio starts flowing.
    const speaking = connection.receiver?.speaking;
    if (speaking) {
      speaking.on("start", (userId: string) => {
        send({ type: "speaking_start", userId: String(userId) });
        // Auto-subscribe: eliminates the IPC round-trip that caused
        // subscribe_user to arrive too late (after the user's speech).
        handleSubscribeUser(String(userId), defaultSilenceDurationMs);
      });
      speaking.on("end", (userId: string) => {
        send({ type: "speaking_end", userId: String(userId) });
      });
    }

    // Wait for Ready state
    entersState(connection, VoiceConnectionStatus.Ready, 15_000).catch((err) => {
      sendError(`connection_ready_timeout: ${String(err?.message || err)}`);
    });
  } catch (error) {
    sendError(`join_failed: ${String(error?.message || error)}`);
  }
}

// --- Voice events from main process (gateway → adapter) ---

function handleVoiceServer(data: any) {
  if (adapterMethods) {
    adapterMethods.onVoiceServerUpdate(data);
  }
}

function handleVoiceState(data: any) {
  if (adapterMethods) {
    adapterMethods.onVoiceStateUpdate(data);
  }
}

// --- User audio capture (voice receiver) ---

function handleSubscribeUser(userId: string, silenceDurationMs: number) {
  if (!connection) return;
  if (userSubscriptions.has(userId)) return;

  const opusStream = connection.receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: silenceDurationMs || 700
    }
  });

  const decoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960
  });

  const pcmStream = opusStream.pipe(decoder);

  pcmStream.on("data", (chunk: Buffer) => {
    // Convert to mono 24kHz (standard ASR input rate) and send to main process
    const monoChunk = convertDiscordPcmToXaiInput(chunk, 24000);
    if (monoChunk.length) {
      send({
        type: "user_audio",
        userId,
        pcmBase64: monoChunk.toString("base64")
      });
    }
  });

  pcmStream.on("end", () => {
    cleanupUserSubscription(userId);
    send({ type: "user_audio_end", userId });
  });

  pcmStream.on("error", () => {
    cleanupUserSubscription(userId);
    send({ type: "user_audio_end", userId });
  });

  userSubscriptions.set(userId, { opusStream, decoder, pcmStream });
}

function handleUnsubscribeUser(userId: string) {
  cleanupUserSubscription(userId);
}

function cleanupUserSubscription(userId: string) {
  const sub = userSubscriptions.get(userId);
  if (!sub) return;
  userSubscriptions.delete(userId);
  try { sub.opusStream.destroy(); } catch { /* ignore */ }
  try { sub.decoder.destroy?.(); } catch { /* ignore */ }
  try { sub.pcmStream.destroy(); } catch { /* ignore */ }
}

// --- Music playback (yt-dlp/ffmpeg pipeline in subprocess) ---

function handleMusicPlay(msg: any) {
  const { url } = msg;
  if (!connection || !url) {
    send({ type: "music_error", message: "no connection or URL" });
    return;
  }

  resetPlayback();

  try {
    const { spawn: spawnChild } = require("node:child_process");
    const isYouTube = url.includes("youtube.com") || url.includes("youtu.be");

    if (isYouTube) {
      const ytdlp = spawnChild("yt-dlp", [
        "--no-warnings", "--quiet", "--no-playlist",
        "--extractor-args", "youtube:player_client=android",
        "-f", "bestaudio/best",
        "-o", "-", url
      ]);

      const ffmpeg = spawnChild("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-i", "pipe:0",
        "-f", "opus", "-ac", "2", "-ar", "48000", "-b:a", "128k",
        "pipe:1"
      ]);

      ytdlp.stdout.pipe(ffmpeg.stdin);

      const resource = createAudioResource(ffmpeg.stdout, {
        inputType: StreamType.OggOpus
      });

      if (!audioPlayer) {
        audioPlayer = createAudioPlayer();
        connection.subscribe(audioPlayer);
      }
      audioPlayer.play(resource);

      audioPlayer.once(AudioPlayerStatus.Idle, () => {
        send({ type: "music_idle" });
      });

      ytdlp.on("error", (err: any) => {
        send({ type: "music_error", message: `yt-dlp: ${err?.message || err}` });
      });
      ffmpeg.on("error", (err: any) => {
        send({ type: "music_error", message: `ffmpeg: ${err?.message || err}` });
      });
    } else {
      const ffmpeg = spawnChild("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-i", url,
        "-f", "opus", "-ac", "2", "-ar", "48000", "-b:a", "128k",
        "pipe:1"
      ]);

      const resource = createAudioResource(ffmpeg.stdout, {
        inputType: StreamType.OggOpus
      });

      if (!audioPlayer) {
        audioPlayer = createAudioPlayer();
        connection.subscribe(audioPlayer);
      }
      audioPlayer.play(resource);

      audioPlayer.once(AudioPlayerStatus.Idle, () => {
        send({ type: "music_idle" });
      });

      ffmpeg.on("error", (err: any) => {
        send({ type: "music_error", message: `ffmpeg: ${err?.message || err}` });
      });
    }
  } catch (error) {
    send({ type: "music_error", message: String(error?.message || error) });
  }
}

function handleMusicStop() {
  resetPlayback();
  send({ type: "music_idle" });
}

function handleMusicPause() {
  audioPlayer?.pause();
}

function handleMusicResume() {
  audioPlayer?.unpause();
}

// --- Destroy ---

function handleDestroy() {
  for (const userId of userSubscriptions.keys()) {
    cleanupUserSubscription(userId);
  }

  resetPlayback();
  destroyOpusEncoder();

  if (connection) {
    try { connection.destroy(); } catch { /* ignore */ }
    connection = null;
  }

  adapterMethods = null;
  setTimeout(() => process.exit(0), 100);
}

// --- IPC message router ---

process.on("message", (msg: any) => {
  if (!msg || typeof msg !== "object") return;

  switch (msg.type) {
    case "join":
      handleJoin(msg);
      break;
    case "voice_server":
      handleVoiceServer(msg.data);
      break;
    case "voice_state":
      handleVoiceState(msg.data);
      break;
    case "audio":
      handleAudio(msg.pcmBase64, Number(msg.sampleRate) || 24000);
      break;
    case "stop_playback":
      handleStopPlayback();
      break;
    case "subscribe_user":
      // Update default silence duration for future auto-subscriptions
      defaultSilenceDurationMs = Number(msg.silenceDurationMs) || 700;
      handleSubscribeUser(msg.userId, defaultSilenceDurationMs);
      break;
    case "unsubscribe_user":
      handleUnsubscribeUser(msg.userId);
      break;
    case "music_play":
      handleMusicPlay(msg);
      break;
    case "music_stop":
      handleMusicStop();
      break;
    case "music_pause":
      handleMusicPause();
      break;
    case "music_resume":
      handleMusicResume();
      break;
    case "destroy":
      handleDestroy();
      break;
    default:
      if (AUDIO_DEBUG) {
        console.log(`[subprocess] unknown message type: ${msg.type}`);
      }
      break;
  }
});

process.on("disconnect", () => {
  handleDestroy();
});

process.on("uncaughtException", (err) => {
  console.error("[subprocess] uncaught exception:", err);
  sendError(`uncaught_exception: ${String(err?.message || err)}`);
  handleDestroy();
});

process.on("unhandledRejection", (err) => {
  console.error("[subprocess] unhandled rejection:", err);
  sendError(`unhandled_rejection: ${String(err?.message || err)}`);
});

console.log("[subprocess] voice subprocess started, waiting for IPC messages");
