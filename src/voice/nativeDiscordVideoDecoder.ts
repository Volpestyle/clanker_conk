import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NATIVE_DISCORD_FRAME_DECODE_TIMEOUT_MS = 2_000;

let cachedFfmpegPath: string | null | undefined;

async function waitForNonEmptyFile(path: string, timeoutMs: number): Promise<Buffer | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const file = Bun.file(path);
    if (await file.exists()) {
      const output = Buffer.from(await file.arrayBuffer());
      if (output.length > 0) {
        return output;
      }
    }
    await Bun.sleep(25);
  }
  return null;
}

function resolveFfmpegPath(): string | null {
  if (cachedFfmpegPath !== undefined) {
    return cachedFfmpegPath;
  }
  cachedFfmpegPath =
    typeof Bun !== "undefined" && typeof Bun.which === "function"
      ? Bun.which("ffmpeg") || null
      : null;
  return cachedFfmpegPath;
}

function parseVp8KeyframeResolution(frame: Buffer): { width: number; height: number } | null {
  if (frame.length < 10) return null;
  const frameTag = frame[0] | (frame[1] << 8) | (frame[2] << 16);
  const isKeyframe = (frameTag & 0x01) === 0;
  if (!isKeyframe) return null;
  if (frame[3] !== 0x9d || frame[4] !== 0x01 || frame[5] !== 0x2a) {
    return null;
  }
  const width = frame.readUInt16LE(6) & 0x3fff;
  const height = frame.readUInt16LE(8) & 0x3fff;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function buildSingleFrameVp8IvfBuffer(frame: Buffer, rtpTimestamp: number): Buffer {
  const resolution = parseVp8KeyframeResolution(frame);
  if (!resolution) {
    throw new Error("vp8_keyframe_resolution_unavailable");
  }

  const header = Buffer.alloc(32);
  header.write("DKIF", 0, "ascii");
  header.writeUInt16LE(0, 4);
  header.writeUInt16LE(32, 6);
  header.write("VP80", 8, "ascii");
  header.writeUInt16LE(resolution.width, 12);
  header.writeUInt16LE(resolution.height, 14);
  header.writeUInt32LE(1, 16);
  header.writeUInt32LE(1, 20);
  header.writeUInt32LE(1, 24);
  header.writeUInt32LE(0, 28);

  const frameHeader = Buffer.alloc(12);
  frameHeader.writeUInt32LE(frame.length, 0);
  frameHeader.writeBigUInt64LE(BigInt(Math.max(0, Math.floor(Number(rtpTimestamp) || 0))), 4);

  return Buffer.concat([header, frameHeader, frame]);
}

function resolveVideoFrameInput({
  codec,
  frames,
  rtpTimestamp
}: {
  codec: string;
  frames: Buffer[];
  rtpTimestamp: number;
}) {
  const normalizedCodec = String(codec || "").trim().toLowerCase();
  switch (normalizedCodec) {
    case "vp8":
      if (frames.length <= 0) {
        throw new Error("native_video_frame_empty");
      }
      return {
        inputFormat: "ivf",
        payload: buildSingleFrameVp8IvfBuffer(frames[0]!, rtpTimestamp)
      };
    default:
      throw new Error(`unsupported_native_video_codec:${normalizedCodec || "unknown"}`);
  }
}

export function hasNativeDiscordVideoDecoderSupport(): boolean {
  return Boolean(resolveFfmpegPath());
}

export async function decodeNativeDiscordVideoFrameToStillImage({
  codec,
  frameBase64,
  rtpTimestamp
}: {
  codec: string;
  frameBase64: string;
  rtpTimestamp: number;
}): Promise<{ mimeType: "image/jpeg"; dataBase64: string }> {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) {
    throw new Error("ffmpeg_not_installed");
  }

  const frames = [frameBase64]
    .map((entry) => Buffer.from(String(entry || "").trim(), "base64"))
    .filter((frame) => frame.length > 0);
  if (frames.length <= 0) {
    throw new Error("native_video_frame_empty");
  }

  const { inputFormat, payload } = resolveVideoFrameInput({
    codec,
    frames,
    rtpTimestamp
  });

  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const inputPath = join(tmpdir(), `clanky_vframe_${tag}.ivf`);
  const outputPath = join(tmpdir(), `clanky_vframe_${tag}.jpg`);

  await Bun.write(inputPath, payload);

  const process = Bun.spawn(
    [
      "sh", "-c",
      `cat "${inputPath}" | "${ffmpegPath}" -loglevel error -analyzeduration 0 -probesize 32768 -flags low_delay -fflags +genpts -f ${inputFormat} -i pipe:0 -frames:v 1 -pix_fmt yuvj420p -q:v 5 -y "${outputPath}"`
    ],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe"
    }
  );

  let killedForTimeout = false;
  const timeout = setTimeout(() => {
    try {
      killedForTimeout = true;
      process.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, NATIVE_DISCORD_FRAME_DECODE_TIMEOUT_MS);

  try {
    const output = await waitForNonEmptyFile(outputPath, NATIVE_DISCORD_FRAME_DECODE_TIMEOUT_MS);
    if (output) {
      try {
        process.kill("SIGKILL");
      } catch {
        // ignore
      }
      return {
        mimeType: "image/jpeg",
        dataBase64: output.toString("base64")
      };
    }

    const [stderrText, exitCode] = await Promise.all([
      new Response(process.stderr).text(),
      process.exited
    ]);

    if (killedForTimeout) {
      throw new Error(`ffmpeg_decode_timeout:${stderrText.trim().slice(0, 500) || "no_stderr"}`);
    }
    if (exitCode !== 0) {
      throw new Error(String(stderrText || `ffmpeg_exit_${exitCode}`).trim() || `ffmpeg_exit_${exitCode}`);
    }
    throw new Error("ffmpeg_empty_frame_output");
  } finally {
    clearTimeout(timeout);
    unlink(inputPath).catch(() => {});
    unlink(outputPath).catch(() => {});
  }
}
