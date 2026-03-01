import {
  AudioPlayer,
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  StreamType,
  VoiceConnection,
  type AudioResource
} from "@discordjs/voice";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import type { MusicSearchResult } from "./musicSearch.ts";

type YtdlFunction = (url: string, options?: Record<string, unknown>) => Readable;

export type MusicPlayerStatus = {
  playing: boolean;
  paused: boolean;
  currentTrack: MusicSearchResult | null;
  position: number;
};

export type MusicPlayerResult = {
  ok: boolean;
  error: string | null;
  track: MusicSearchResult | null;
};

type MusicPlayerConfig = {
  ytdlOptions?: {
    filter?: "audioonly" | "videoandaudio";
    quality?: "highestaudio" | "lowestaudio";
  };
};

export class DiscordMusicPlayer {
  private player: AudioPlayer | null = null;
  private connection: VoiceConnection | null = null;
  private currentTrack: MusicSearchResult | null = null;
  private config: MusicPlayerConfig;

  constructor(config: MusicPlayerConfig = {}) {
    this.config = config;
  }

  setConnection(connection: VoiceConnection): void {
    this.connection = connection;
    if (this.player) {
      connection.subscribe(this.player);
    }
  }

  isPlaying(): boolean {
    return this.player?.state.status === AudioPlayerStatus.Playing;
  }

  isPaused(): boolean {
    return this.player?.state.status === AudioPlayerStatus.Paused;
  }

  getStatus(): MusicPlayerStatus {
    return {
      playing: this.isPlaying(),
      paused: this.isPaused(),
      currentTrack: this.currentTrack,
      position: 0
    };
  }

  async play(track: MusicSearchResult): Promise<MusicPlayerResult> {
    if (!this.connection) {
      return { ok: false, error: "no voice connection", track: null };
    }

    try {
      this.stop();

      const streamUrl = this.getStreamUrl(track);
      if (!streamUrl) {
        return { ok: false, error: "could not resolve stream URL", track };
      }

      const resource = await this.createAudioResource(streamUrl, track);
      if (!resource) {
        return { ok: false, error: "failed to create audio resource", track };
      }

      this.player = createAudioPlayer();
      this.currentTrack = track;

      this.player.on(AudioPlayerStatus.Idle, () => {
        this.currentTrack = null;
      });

      this.player.on("error", (error: Error) => {
        console.error("Music player error:", error);
        this.currentTrack = null;
      });

      this.player.play(resource as AudioResource);
      this.connection.subscribe(this.player);

      console.log(`[musicPlayer] Now playing: ${track.title} (${track.platform})`);
      return { ok: true, error: null, track };
    } catch (error) {
      return { ok: false, error: String(error?.message || error), track };
    }
  }

  stop(): void {
    if (this.player) {
      try {
        this.player.stop();
      } catch {
        // ignore
      }
      this.player = null;
    }
    this.currentTrack = null;
  }

  pause(): void {
    this.player?.pause();
  }

  resume(): void {
    this.player?.unpause();
  }

  private getStreamUrl(track: MusicSearchResult): string | null {
    if (track.streamUrl) {
      return track.streamUrl;
    }

    if (track.platform === "youtube" && track.id.startsWith("youtube:")) {
      const videoId = track.id.replace("youtube:", "");
      return `https://www.youtube.com/watch?v=${videoId}`;
    }

    if (track.platform === "soundcloud") {
      return track.externalUrl;
    }

    return track.externalUrl;
  }

  private async createAudioResource(
    url: string,
    track: MusicSearchResult
  ): Promise<AudioResource | null> {
    try {
      if (url.includes("youtube.com") || url.includes("youtu.be")) {
        return this.createYouTubeResource(url, track);
      }

      return this.createDirectStreamResource(url, track);
    } catch (error) {
      console.error("Failed to create audio resource:", error);
      return null;
    }
  }

  private async createYouTubeResource(
    url: string,
    track: MusicSearchResult
  ): Promise<AudioResource | null> {
    try {
      console.log(`[musicPlayer] Starting yt-dlp stream for: ${track.title || url}`);
      return await this.createYtDlpStreamResource(url, track);
    } catch (error) {
      console.warn("[musicPlayer] yt-dlp failed, trying ytdl-core fallback:", error);
      try {
        return await this.createYtdlCoreResource(url, track);
      } catch (ytdlError) {
        console.warn("[musicPlayer] ytdl-core fallback also failed, using direct URL:", ytdlError);
        return this.createDirectStreamResource(url, track);
      }
    }
  }

  private async createYtDlpStreamResource(
    url: string,
    track: MusicSearchResult
  ): Promise<AudioResource | null> {
    return new Promise((resolve, reject) => {
      const ytdlp = spawn("yt-dlp", [
        "--no-warnings",
        "--quiet",
        "--no-playlist",
        "--extractor-args",
        "youtube:player_client=android",
        "-f",
        "bestaudio/best",
        "-o",
        "-",
        url
      ]);

      const ffmpeg = spawn("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-f",
        "opus",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-b:a",
        "128k",
        "pipe:1"
      ]);

      let ffmpegOutput: Buffer | null = Buffer.alloc(0);
      let ffmpegError = "";

      ffmpeg.stdout.on("data", (chunk: Buffer) => {
        ffmpegOutput = Buffer.concat([ffmpegOutput!, chunk]);
      });

      ffmpeg.stderr.on("data", (data: Buffer) => {
        ffmpegError += data.toString();
      });

      ytdlp.on("error", (err: Error) => {
        console.error("yt-dlp spawn error:", err.message);
        reject(err);
      });

      ffmpeg.on("error", (err: Error) => {
        console.error("ffmpeg spawn error:", err.message);
        reject(err);
      });

      ytdlp.on("close", (code: number | null) => {
        if (code !== 0 && code !== null) {
          console.error(`yt-dlp exited with code ${code}: ${ffmpegError}`);
          reject(new Error(`yt-dlp exited with code ${code}`));
        }
      });

      ffmpeg.on("close", (code: number | null) => {
        if (code === 0 && ffmpegOutput && ffmpegOutput.length > 0) {
          console.log(`[musicPlayer] yt-dlp stream ready: ${ffmpegOutput.length} bytes`);
          const stream = this.bufferToStream(ffmpegOutput);
          resolve(createAudioResource(stream, {
            metadata: track,
            inputType: "opus" as StreamType,
            inlineVolume: true
          }) as AudioResource);
        } else if (code !== 0) {
          reject(new Error(`ffmpeg exited with code ${code}: ${ffmpegError}`));
        }
      });

      ytdlp.stdout.pipe(ffmpeg.stdin);
    });
  }

  private async createYtdlCoreResource(
    url: string,
    track: MusicSearchResult
  ): Promise<AudioResource | null> {
    const ytdl = await this.getYtdl();
    if (!ytdl) {
      throw new Error("ytdl-core not available");
    }

    const options = this.config.ytdlOptions || {
      filter: "audioonly",
      quality: "highestaudio"
    };

    const stream = ytdl(url, options);
    const probed = await demuxProbe(stream);

    return createAudioResource(probed.stream, {
      metadata: track,
      inputType: probed.type,
      inlineVolume: true
    }) as AudioResource;
  }

  private bufferToStream(buffer: Buffer): Readable {
    return Readable.from([buffer]);
  }

  private async createDirectStreamResource(
    url: string,
    track: MusicSearchResult
  ): Promise<AudioResource | null> {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
      });

      if (!response.ok || !response.body) {
        return null;
      }

      const contentType = response.headers.get("content-type") || "";
      let inputType: StreamType = StreamType.Raw;

      if (contentType.includes("mpeg") || contentType.includes("mp3")) {
        inputType = "mp3" as StreamType;
      } else if (contentType.includes("ogg")) {
        inputType = "ogg/opus" as StreamType;
      } else if (contentType.includes("webm")) {
        inputType = "webm/opus" as StreamType;
      }

      const nodeStream = this.webToNodeStream(response.body);
      return createAudioResource(nodeStream as Readable, {
        metadata: track,
        inputType
      }) as AudioResource;
    } catch (error) {
      console.error("Direct stream resource creation failed:", error);
      return null;
    }
  }

  private webToNodeStream(webStream: ReadableStream<Uint8Array>): Readable {
    const reader = webStream.getReader();
    const nodeStream = new Readable({
      read() {
        reader.read().then(({ done, value }: { done: boolean; value?: Uint8Array }) => {
          if (done) {
            this.push(null);
          } else {
            this.push(Buffer.from(value));
          }
        }).catch((err: Error) => this.destroy(err));
      }
    });
    return nodeStream;
  }

  private ytdlModule: YtdlFunction | null = null;

  private async getYtdl(): Promise<YtdlFunction | null> {
    if (this.ytdlModule) {
      return this.ytdlModule;
    }

    try {
      const module = await import("ytdl-core");
      const resolved = typeof module.default === "function" ? module.default : null;
      this.ytdlModule = resolved;
      return this.ytdlModule;
    } catch {
      console.warn("ytdl-core not installed, YouTube playback will use URL direct streaming");
      return null;
    }
  }
}

export function createDiscordMusicPlayer(config?: MusicPlayerConfig): DiscordMusicPlayer {
  return new DiscordMusicPlayer(config);
}
