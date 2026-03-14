import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  applyNativeDiscordVideoState,
  clearNativeDiscordScreenShareState,
  clearPendingNativeDiscordH264DecodeSequence,
  ensureNativeDiscordScreenShareState,
  listActiveNativeDiscordScreenSharers,
  selectNativeDiscordH264BootstrapSequence,
  recordNativeDiscordVideoFrame
} from "./nativeDiscordScreenShare.ts";

test("applyNativeDiscordVideoState persists active sharers onto the session-native state", () => {
  const session = {
    nativeScreenShare: {
      sharers: new Map(),
      subscribedTargetUserId: null,
      decodeInFlight: false,
      lastDecodeAttemptAt: 0,
      lastDecodeSuccessAt: 0,
      lastDecodeFailureAt: 0,
      lastDecodeFailureReason: null,
      ffmpegAvailable: null
    }
  };

  const updated = applyNativeDiscordVideoState(session, {
    userId: "user-1",
    audioSsrc: 111,
    videoSsrc: 222,
    codec: "H264",
    streams: [
      {
        ssrc: 333,
        rtxSsrc: 444,
        rid: "f",
        quality: 100,
        streamType: "screen",
        active: true,
        maxBitrate: 4_000_000,
        maxFramerate: 30,
        maxResolution: {
          type: "fixed",
          width: 1280,
          height: 720
        }
      }
    ]
  });

  assert.equal(updated.userId, "user-1");
  assert.equal(updated.codec, "h264");
  assert.equal(session.nativeScreenShare.sharers.get("user-1")?.videoSsrc, 222);
  assert.equal(listActiveNativeDiscordScreenSharers(session).length, 1);

  const frameState = recordNativeDiscordVideoFrame(session, {
    userId: "user-1",
    codec: "H264",
    keyframe: true
  });

  assert.equal(frameState?.lastFrameCodec, "h264");
  assert.equal(Number(session.nativeScreenShare.sharers.get("user-1")?.lastFrameAt || 0) > 0, true);
  assert.equal(Number(session.nativeScreenShare.sharers.get("user-1")?.lastFrameKeyframeAt || 0) > 0, true);
});

test("ensureNativeDiscordScreenShareState normalizes partial session-like state in place", () => {
  const session = {
    nativeScreenShare: {
      sharers: new Map([
        [
          " user-2 ",
          {
            codec: "VP8",
            streams: [
              {
                ssrc: 555,
                width: 1920,
                height: 1080
              }
            ]
          }
        ]
      ]),
      subscribedTargetUserId: " user-2 ",
      decodeInFlight: false,
      lastDecodeAttemptAt: 12,
      lastDecodeSuccessAt: 34,
      lastDecodeFailureAt: 56,
      lastDecodeFailureReason: " old_reason ",
      ffmpegAvailable: true
    }
  };

  const state = ensureNativeDiscordScreenShareState(session);

  assert.equal(session.nativeScreenShare, state);
  assert.equal(state.subscribedTargetUserId, "user-2");
  assert.equal(state.sharers.get("user-2")?.userId, "user-2");
  assert.equal(state.sharers.get("user-2")?.codec, "vp8");
  assert.equal(state.sharers.get("user-2")?.streams[0]?.pixelCount, 1920 * 1080);
  assert.equal(state.lastDecodeFailureReason, "old_reason");
});

test("ensureNativeDiscordScreenShareState preserves the live state object across updates", () => {
  const session = {
    nativeScreenShare: {
      sharers: new Map(),
      subscribedTargetUserId: " user-1 ",
      decodeInFlight: true,
      lastDecodeAttemptAt: 12,
      lastDecodeSuccessAt: 0,
      lastDecodeFailureAt: 0,
      lastDecodeFailureReason: null,
      ffmpegAvailable: true
    }
  };

  const state = ensureNativeDiscordScreenShareState(session);
  applyNativeDiscordVideoState(session, {
    userId: "user-1",
    audioSsrc: null,
    videoSsrc: 222,
    codec: "H264",
    streams: []
  });

  assert.equal(session.nativeScreenShare, state);
  assert.equal(state.decodeInFlight, true);
  assert.equal(state.subscribedTargetUserId, "user-1");
  assert.equal(state.sharers.get("user-1")?.videoSsrc, 222);
});

test("clearNativeDiscordScreenShareState resets the existing state object in place", () => {
  const session = {
    nativeScreenShare: {
      sharers: new Map([
        [
          "user-1",
          {
            userId: "user-1",
            codec: "h264",
            streams: [],
            updatedAt: 1,
            lastFrameAt: 2,
            lastFrameCodec: "h264",
            lastFrameKeyframeAt: 3
          }
        ]
      ]),
      subscribedTargetUserId: "user-1",
      decodeInFlight: true,
      lastDecodeAttemptAt: 12,
      lastDecodeSuccessAt: 34,
      lastDecodeFailureAt: 56,
      lastDecodeFailureReason: "bad",
      ffmpegAvailable: true
    }
  };

  const state = ensureNativeDiscordScreenShareState(session);
  clearNativeDiscordScreenShareState(session);

  assert.equal(session.nativeScreenShare, state);
  assert.equal(state.sharers.size, 0);
  assert.equal(state.subscribedTargetUserId, null);
  assert.equal(state.decodeInFlight, false);
  assert.equal(state.lastDecodeFailureReason, null);
  assert.equal(state.ffmpegAvailable, null);
});

test("selectNativeDiscordH264BootstrapSequence seeds bootstrap from a keyframe and keeps that candidate across delta frames", () => {
  const session = {
    nativeScreenShare: {
      sharers: new Map(),
      subscribedTargetUserId: "user-1",
      decodeInFlight: false,
      lastDecodeAttemptAt: 0,
      lastDecodeSuccessAt: 0,
      lastDecodeFailureAt: 0,
      lastDecodeFailureReason: null,
      ffmpegAvailable: true,
      pendingH264Decode: null
    }
  };

  const keyframeSequence = selectNativeDiscordH264BootstrapSequence(session, {
    userId: "user-1",
    frameBase64: Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67]).toString("base64"),
    keyframe: true,
    rtpTimestamp: 111
  });
  const carriedSequence = selectNativeDiscordH264BootstrapSequence(session, {
    userId: "user-1",
    frameBase64: Buffer.from([0x00, 0x00, 0x00, 0x01, 0x41]).toString("base64"),
    keyframe: false,
    rtpTimestamp: 222
  });

  assert.equal(keyframeSequence?.frameBase64s.length, 1);
  assert.equal(carriedSequence?.frameBase64s.length, 1);
  assert.equal(carriedSequence?.firstRtpTimestamp, 111);
  assert.equal(carriedSequence?.lastRtpTimestamp, 222);
  assert.equal(carriedSequence?.approximateBytes, 5);
});

test("selectNativeDiscordH264BootstrapSequence ignores non-keyframes until a keyframe starts the sequence", () => {
  const session = {
    nativeScreenShare: {
      sharers: new Map(),
      subscribedTargetUserId: "user-1",
      decodeInFlight: false,
      lastDecodeAttemptAt: 0,
      lastDecodeSuccessAt: 0,
      lastDecodeFailureAt: 0,
      lastDecodeFailureReason: null,
      ffmpegAvailable: true,
      pendingH264Decode: null
    }
  };

  const deltaOnly = selectNativeDiscordH264BootstrapSequence(session, {
    userId: "user-1",
    frameBase64: Buffer.from([0x00, 0x00, 0x00, 0x01, 0x41]).toString("base64"),
    keyframe: false,
    rtpTimestamp: 111
  });

  assert.equal(deltaOnly, null);
  assert.equal(ensureNativeDiscordScreenShareState(session).pendingH264Decode, null);
});

test("selectNativeDiscordH264BootstrapSequence replaces the bootstrap candidate when a new keyframe arrives", () => {
  const session = {
    nativeScreenShare: {
      sharers: new Map(),
      subscribedTargetUserId: "user-1",
      decodeInFlight: false,
      lastDecodeAttemptAt: 0,
      lastDecodeSuccessAt: 0,
      lastDecodeFailureAt: 0,
      lastDecodeFailureReason: null,
      ffmpegAvailable: true,
      pendingH264Decode: null
    }
  };

  selectNativeDiscordH264BootstrapSequence(session, {
    userId: "user-1",
    frameBase64: Buffer.from([0x01, 0x02, 0x03]).toString("base64"),
    keyframe: true,
    rtpTimestamp: 111
  });
  selectNativeDiscordH264BootstrapSequence(session, {
    userId: "user-1",
    frameBase64: Buffer.from([0x04, 0x05]).toString("base64"),
    keyframe: false,
    rtpTimestamp: 222
  });

  const replacement = selectNativeDiscordH264BootstrapSequence(session, {
    userId: "user-1",
    frameBase64: Buffer.from([0x06, 0x07, 0x08, 0x09]).toString("base64"),
    keyframe: true,
    rtpTimestamp: 333
  });

  assert.deepEqual(replacement?.frameBase64s, [Buffer.from([0x06, 0x07, 0x08, 0x09]).toString("base64")]);
  assert.equal(replacement?.firstRtpTimestamp, 333);
  assert.equal(replacement?.lastRtpTimestamp, 333);
  assert.equal(replacement?.approximateBytes, 4);
});

test("clearPendingNativeDiscordH264DecodeSequence removes the buffered bootstrap candidate for the active target", () => {
  const session = {
    nativeScreenShare: {
      sharers: new Map(),
      subscribedTargetUserId: "user-1",
      decodeInFlight: false,
      lastDecodeAttemptAt: 0,
      lastDecodeSuccessAt: 0,
      lastDecodeFailureAt: 0,
      lastDecodeFailureReason: null,
      ffmpegAvailable: true,
      pendingH264Decode: null
    }
  };

  selectNativeDiscordH264BootstrapSequence(session, {
    userId: "user-1",
    frameBase64: Buffer.from([0x01, 0x02, 0x03]).toString("base64"),
    keyframe: true,
    rtpTimestamp: 111
  });
  clearPendingNativeDiscordH264DecodeSequence(session, "user-1");

  assert.equal(ensureNativeDiscordScreenShareState(session).pendingH264Decode, null);
});

test("listActiveNativeDiscordScreenSharers ignores explicit inactive states but keeps frame-backed watchers", () => {
  const session = {
    nativeScreenShare: {
      sharers: new Map([
        [
          "user-active",
          {
            userId: "user-active",
            videoSsrc: 111,
            updatedAt: 10,
            lastFrameAt: 0,
            streams: [
              {
                ssrc: 111,
                streamType: "screen",
                active: true
              }
            ]
          }
        ],
        [
          "user-ended",
          {
            userId: "user-ended",
            videoSsrc: null,
            updatedAt: 20,
            lastFrameAt: 0,
            streams: []
          }
        ],
        [
          "user-inactive",
          {
            userId: "user-inactive",
            videoSsrc: 222,
            updatedAt: 30,
            lastFrameAt: 0,
            streams: [
              {
                ssrc: 222,
                streamType: "screen",
                active: false
              }
            ]
          }
        ],
        [
          "user-frame-backed",
          {
            userId: "user-frame-backed",
            videoSsrc: 333,
            updatedAt: 5,
            lastFrameAt: 40,
            streams: []
          }
        ]
      ]),
      subscribedTargetUserId: null,
      decodeInFlight: false,
      lastDecodeAttemptAt: 0,
      lastDecodeSuccessAt: 0,
      lastDecodeFailureAt: 0,
      lastDecodeFailureReason: null,
      ffmpegAvailable: true
    }
  };

  assert.deepEqual(
    listActiveNativeDiscordScreenSharers(session).map((entry) => entry.userId),
    ["user-frame-backed", "user-active"]
  );
});
