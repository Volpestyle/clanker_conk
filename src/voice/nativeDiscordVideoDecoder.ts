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

function startsWithAnnexBStartCode(frame: Buffer): boolean {
  return frame.subarray(0, 4).equals(Buffer.from([0, 0, 0, 1])) ||
    frame.subarray(0, 3).equals(Buffer.from([0, 0, 1]));
}

function convertLengthPrefixedH264ToAnnexB(frame: Buffer): Buffer | null {
  if (frame.length < 5) {
    return null;
  }

  let cursor = 0;
  const nalUnits: Buffer[] = [];
  while (cursor + 4 <= frame.length) {
    const nalLength = frame.readUInt32BE(cursor);
    cursor += 4;
    if (nalLength <= 0 || cursor + nalLength > frame.length) {
      return null;
    }
    nalUnits.push(Buffer.concat([Buffer.from([0, 0, 0, 1]), frame.subarray(cursor, cursor + nalLength)]));
    cursor += nalLength;
  }

  if (cursor !== frame.length || nalUnits.length === 0) {
    return null;
  }

  return Buffer.concat(nalUnits);
}

export function normalizeH264FrameForDecoding(frame: Buffer): Buffer {
  if (startsWithAnnexBStartCode(frame)) {
    return frame;
  }

  return convertLengthPrefixedH264ToAnnexB(frame) || frame;
}

export function buildH264DecodeSequencePayload(frames: Buffer[]): Buffer {
  const normalizedFrames = frames
    .filter((frame) => Buffer.isBuffer(frame) && frame.length > 0)
    .map((frame) => normalizeH264FrameForDecoding(frame));
  if (normalizedFrames.length <= 0) {
    return Buffer.alloc(0);
  }
  return Buffer.concat(normalizedFrames);
}

/**
 * Check whether an Annex-B H264 bitstream contains SPS (NAL type 7) and
 * PPS (NAL type 8) NAL units. Without these, ffmpeg cannot initialize the
 * decoder and will stall waiting for more data on stdin.
 */
function annexBContainsSpsAndPps(frame: Buffer): { hasSps: boolean; hasPps: boolean } {
  let hasSps = false;
  let hasPps = false;
  let cursor = 0;
  while (cursor < frame.length - 3) {
    // Look for 3-byte (00 00 01) or 4-byte (00 00 00 01) start codes
    if (frame[cursor] === 0 && frame[cursor + 1] === 0) {
      let nalStart: number;
      if (frame[cursor + 2] === 1) {
        nalStart = cursor + 3;
      } else if (frame[cursor + 2] === 0 && cursor + 3 < frame.length && frame[cursor + 3] === 1) {
        nalStart = cursor + 4;
      } else {
        cursor += 1;
        continue;
      }
      if (nalStart < frame.length) {
        const nalType = frame[nalStart] & 0x1f;
        if (nalType === 7) hasSps = true;
        if (nalType === 8) hasPps = true;
        if (hasSps && hasPps) break;
      }
      cursor = nalStart;
    } else {
      cursor += 1;
    }
  }
  return { hasSps, hasPps };
}

/**
 * Known H264 profile_idc values. If the SPS contains a profile byte not in
 * this set, the NAL payload is almost certainly corrupt or still encrypted
 * (e.g. DAVE passthrough returned encrypted data as-is).
 */
const VALID_H264_PROFILE_IDCS = new Set([
  66, 77, 88, 100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134
]);

/**
 * Extract the profile_idc byte from the first SPS NAL unit in an Annex-B
 * bitstream. Returns null if no SPS is found or the data is too short.
 */
export function extractH264ProfileIdc(frame: Buffer): number | null {
  let cursor = 0;
  while (cursor < frame.length - 4) {
    if (frame[cursor] === 0 && frame[cursor + 1] === 0) {
      let nalStart: number;
      if (frame[cursor + 2] === 1) {
        nalStart = cursor + 3;
      } else if (frame[cursor + 2] === 0 && cursor + 3 < frame.length && frame[cursor + 3] === 1) {
        nalStart = cursor + 4;
      } else {
        cursor += 1;
        continue;
      }
      if (nalStart < frame.length && (frame[nalStart] & 0x1f) === 7) {
        // SPS NAL: profile_idc is the byte immediately after the NAL header
        return nalStart + 1 < frame.length ? frame[nalStart + 1] : null;
      }
      cursor = nalStart;
    } else {
      cursor += 1;
    }
  }
  return null;
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
    case "h264":
      return {
        inputFormat: "h264",
        payload: buildH264DecodeSequencePayload(frames)
      };
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
  sequenceFrameBase64s,
  rtpTimestamp
}: {
  codec: string;
  frameBase64: string;
  sequenceFrameBase64s?: string[] | null;
  rtpTimestamp: number;
}): Promise<{ mimeType: "image/jpeg"; dataBase64: string }> {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) {
    throw new Error("ffmpeg_not_installed");
  }

  const normalizedCodec = String(codec || "").trim().toLowerCase();
  const frameBase64s =
    normalizedCodec === "h264" && Array.isArray(sequenceFrameBase64s) && sequenceFrameBase64s.length > 0
      ? sequenceFrameBase64s
      : [frameBase64];
  const frames = frameBase64s
    .map((entry) => Buffer.from(String(entry || "").trim(), "base64"))
    .filter((frame) => frame.length > 0);
  if (frames.length <= 0) {
    throw new Error("native_video_frame_empty");
  }

  const { inputFormat, payload: rawPayload } = resolveVideoFrameInput({
    codec,
    frames,
    rtpTimestamp
  });

  let payload = rawPayload;

  // H264 IDR frames without inline SPS/PPS cause ffmpeg to stall waiting for
  // parameter sets that will never arrive. Detect this and fail fast.
  if (inputFormat === "h264") {
    const { hasSps, hasPps } = annexBContainsSpsAndPps(payload);
    if (!hasSps || !hasPps) {
      throw new Error(
        `h264_missing_parameter_sets:sps=${hasSps}:pps=${hasPps}`
      );
    }
    // Validate the SPS profile byte. If DAVE passthrough returned an
    // encrypted frame as-is, the NAL type bytes are correct (DAVE leaves
    // them unencrypted) but the SPS payload is garbage. Decoding such a
    // frame can hang ffmpeg for the full timeout duration.
    const profileIdc = extractH264ProfileIdc(payload);
    if (profileIdc !== null && !VALID_H264_PROFILE_IDCS.has(profileIdc)) {
      throw new Error(
        `h264_invalid_sps_profile:${profileIdc}:likely_encrypted_passthrough`
      );
    }

    // Detect repeated-byte padding that indicates encrypted or corrupt data.
    // DAVE passthrough frames sometimes have tails of all-same bytes (e.g.
    // 0x4c or 0x7b repeated) that waste an ffmpeg spawn on garbage.
    if (payload.length >= 32) {
      const tailByte = payload[payload.length - 1];
      if (tailByte !== 0) {
        let allSame = true;
        for (let i = payload.length - 16; i < payload.length; i++) {
          if (payload[i] !== tailByte) {
            allSame = false;
            break;
          }
        }
        if (allSame) {
          throw new Error(
            `h264_repeated_tail_bytes:0x${tailByte.toString(16)}:likely_encrypted_passthrough`
          );
        }
      }
    }
  }

  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const inputPath = join(tmpdir(), `clanky_vframe_${tag}.${inputFormat === "h264" ? "h264" : "ivf"}`);
  const outputPath = join(tmpdir(), `clanky_vframe_${tag}.jpg`);

  // Write input to a temp file and pipe via `cat` so ffmpeg sees a clean
  // EOF.  Bun's stdin.end() is unreliable under event loop contention in
  // the live bot — the H264 demuxer hangs waiting for data that never
  // arrives.  `cat` is a separate process that handles pipe closure
  // natively and consistently delivers EOF.
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

export const decodeNativeDiscordVideoFrameToJpeg = decodeNativeDiscordVideoFrameToStillImage;
