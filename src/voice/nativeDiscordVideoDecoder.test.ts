import { test } from "bun:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";

import {
  buildH264DecodeSequencePayload,
  decodeNativeDiscordVideoFrameToJpeg,
  decodeNativeDiscordVideoFrameToStillImage,
  extractH264ProfileIdc,
  normalizeH264FrameForDecoding
} from "./nativeDiscordVideoDecoder.ts";

async function createSingleFrameH264ElementaryStream(): Promise<Buffer | null> {
  const ffmpegPath = Bun.which("ffmpeg");
  if (!ffmpegPath) {
    return null;
  }

  const outputPath = join(tmpdir(), `clanky_decoder_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.h264`);
  try {
    const process = Bun.spawn(
      [
        ffmpegPath,
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=320x240:rate=1",
        "-frames:v",
        "1",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-tune",
        "zerolatency",
        "-x264-params",
        "keyint=1:min-keyint=1:scenecut=0",
        "-f",
        "h264",
        "-y",
        outputPath
      ],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe"
      }
    );

    const [stderrText, exitCode] = await Promise.all([
      new Response(process.stderr).text(),
      process.exited
    ]);
    if (exitCode !== 0) {
      throw new Error(String(stderrText || `ffmpeg_exit_${exitCode}`).trim() || `ffmpeg_exit_${exitCode}`);
    }

    const outputFile = Bun.file(outputPath);
    if (!(await outputFile.exists())) {
      throw new Error("ffmpeg_h264_fixture_missing");
    }
    return Buffer.from(await outputFile.arrayBuffer());
  } finally {
    await unlink(outputPath).catch(() => {});
  }
}

test("native Discord still-image decoder preserves the legacy JPEG export alias", () => {
  assert.equal(
    decodeNativeDiscordVideoFrameToJpeg,
    decodeNativeDiscordVideoFrameToStillImage
  );
});

test("decodeNativeDiscordVideoFrameToStillImage decodes a single-frame H264 elementary stream", async () => {
  const h264Frame = await createSingleFrameH264ElementaryStream();
  if (!h264Frame) {
    return;
  }

  const decoded = await decodeNativeDiscordVideoFrameToStillImage({
    codec: "h264",
    frameBase64: h264Frame.toString("base64"),
    rtpTimestamp: 1
  });

  assert.equal(decoded.mimeType, "image/jpeg");
  const jpeg = Buffer.from(decoded.dataBase64, "base64");
  assert.ok(jpeg.length > 0);
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
}, 15_000);

test("normalizeH264FrameForDecoding keeps Annex-B frames unchanged", () => {
  const annexB = Buffer.from([
    0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x1f,
    0x00, 0x00, 0x00, 0x01, 0x68, 0xee, 0x3c, 0x80
  ]);

  const normalized = normalizeH264FrameForDecoding(annexB);

  assert.deepEqual(normalized, annexB);
});

test("extractH264ProfileIdc returns profile from valid SPS", () => {
  // SPS with High profile (100)
  const frame = Buffer.from([
    0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x1f
  ]);
  assert.equal(extractH264ProfileIdc(frame), 0x64); // 100 = High
});

test("extractH264ProfileIdc returns profile from Baseline SPS", () => {
  const frame = Buffer.from([
    0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e
  ]);
  assert.equal(extractH264ProfileIdc(frame), 0x42); // 66 = Baseline
});

test("extractH264ProfileIdc returns null when no SPS present", () => {
  // PPS only (NAL type 8)
  const frame = Buffer.from([
    0x00, 0x00, 0x00, 0x01, 0x68, 0xee, 0x3c, 0x80
  ]);
  assert.equal(extractH264ProfileIdc(frame), null);
});

test("extractH264ProfileIdc detects encrypted/corrupt SPS profile", () => {
  // SPS NAL type byte is correct (0x67) but profile is garbage (0xAB)
  const frame = Buffer.from([
    0x00, 0x00, 0x00, 0x01, 0x67, 0xab, 0xcd, 0xef
  ]);
  const profile = extractH264ProfileIdc(frame);
  assert.equal(profile, 0xab); // 171 — not a valid H264 profile
});

test("normalizeH264FrameForDecoding converts length-prefixed AVC access units to Annex-B", () => {
  const avcc = Buffer.from([
    0x00, 0x00, 0x00, 0x04, 0x67, 0x64, 0x00, 0x1f,
    0x00, 0x00, 0x00, 0x03, 0x68, 0xee, 0x3c,
    0x00, 0x00, 0x00, 0x05, 0x65, 0x88, 0x84, 0x21, 0xa0
  ]);

  const normalized = normalizeH264FrameForDecoding(avcc);

  assert.deepEqual(
    normalized,
    Buffer.from([
      0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x1f,
      0x00, 0x00, 0x00, 0x01, 0x68, 0xee, 0x3c,
      0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x21, 0xa0
    ])
  );
});

test("buildH264DecodeSequencePayload concatenates a keyframe and following delta frame", () => {
  const keyframe = Buffer.from([
    0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x1f,
    0x00, 0x00, 0x00, 0x01, 0x68, 0xee, 0x3c,
    0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x21, 0xa0
  ]);
  const delta = Buffer.from([
    0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x22, 0x11
  ]);

  const payload = buildH264DecodeSequencePayload([keyframe, delta]);

  assert.deepEqual(payload, Buffer.concat([keyframe, delta]));
});

test("buildH264DecodeSequencePayload normalizes each H264 access unit before concatenating", () => {
  const avccKeyframe = Buffer.from([
    0x00, 0x00, 0x00, 0x04, 0x67, 0x64, 0x00, 0x1f,
    0x00, 0x00, 0x00, 0x03, 0x68, 0xee, 0x3c,
    0x00, 0x00, 0x00, 0x05, 0x65, 0x88, 0x84, 0x21, 0xa0
  ]);
  const avccDelta = Buffer.from([
    0x00, 0x00, 0x00, 0x04, 0x41, 0x9a, 0x22, 0x11
  ]);

  const payload = buildH264DecodeSequencePayload([avccKeyframe, avccDelta]);

  assert.deepEqual(
    payload,
    Buffer.from([
      0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x1f,
      0x00, 0x00, 0x00, 0x01, 0x68, 0xee, 0x3c,
      0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x21, 0xa0,
      0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x22, 0x11
    ])
  );
});
