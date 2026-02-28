import { test } from "bun:test";
import assert from "node:assert/strict";
import { VideoContextService } from "./video.ts";

function createService() {
  const logs = [];
  const service = new VideoContextService({
    store: {
      logAction(entry) {
        logs.push(entry);
      }
    },
    llm: {}
  });
  return { service, logs };
}

test("extractVideoTargets parses and deduplicates youtube/direct/tiktok targets", () => {
  const { service } = createService();
  const targets = service.extractVideoTargets(
    [
      "check https://youtu.be/AbC123xyz_1",
      "dup https://www.youtube.com/watch?v=AbC123xyz_1",
      "direct https://cdn.discordapp.com/attachments/1/2/clip.mp4",
      "tiktok https://www.tiktok.com/@creator/video/7234567890123456789"
    ].join(" "),
    3
  );

  assert.equal(targets.length, 3);
  assert.equal(targets[0]?.kind, "youtube");
  assert.equal(targets[0]?.videoId, "AbC123xyz_1");
  assert.equal(targets[1]?.kind, "direct");
  assert.equal(targets[1]?.forceDirect, true);
  assert.equal(targets[2]?.kind, "tiktok");
  assert.equal(targets[2]?.videoId, "7234567890123456789");
});

test("extractMessageTargets includes attachment and embed-derived targets", () => {
  const { service } = createService();
  const message = {
    content: "look https://v.redd.it/abcdef123456 and this",
    attachments: new Map([
      [
        "video",
        {
          url: "https://cdn.discordapp.com/attachments/10/11/clip.mov",
          name: "clip.mov",
          contentType: "video/quicktime"
        }
      ],
      [
        "image",
        {
          url: "https://cdn.discordapp.com/attachments/10/11/image.png",
          name: "image.png",
          contentType: "image/png"
        }
      ]
    ]),
    embeds: [
      {
        type: "video",
        video: {
          url: "https://media.example.com/another.webm"
        }
      },
      {
        type: "video",
        url: "https://example.com/posts/12345"
      }
    ]
  };

  const targets = service.extractMessageTargets(message, 6);
  assert.equal(targets.length, 4);
  assert.deepEqual(
    targets.map((target) => target.kind),
    ["generic", "direct", "direct", "generic"]
  );
  assert.equal(targets[0]?.source, "message_url");
  assert.equal(targets[1]?.source, "attachment");
  assert.equal(targets[2]?.source, "embed_video");
  assert.equal(targets[3]?.source, "embed_url");
});

test("fetchContexts aggregates successes and failures with normalized options", async () => {
  const { service, logs } = createService();
  const calls = [];
  service.fetchVideoContext = async (input) => {
    calls.push(input);
    if (input.target.key === "bad") {
      const error = new Error("boom");
      error.attempts = 3;
      throw error;
    }

    return {
      provider: "youtube",
      kind: "youtube",
      videoId: "v1",
      url: "https://www.youtube.com/watch?v=v1",
      title: "title",
      channel: "channel",
      transcript: "hello world",
      transcriptSource: "captions",
      transcriptError: null,
      keyframeCount: 0,
      keyframeError: null,
      cacheHit: false
    };
  };

  const result = await service.fetchContexts({
    targets: [
      { key: "good", kind: "youtube", url: "https://www.youtube.com/watch?v=v1" },
      { key: "bad", kind: "generic", url: "https://example.com/watch/2" }
    ],
    maxTranscriptChars: 50,
    keyframeIntervalSeconds: 999,
    maxKeyframesPerVideo: 25,
    allowAsrFallback: true,
    maxAsrSeconds: 3,
    trace: { guildId: "guild-1", channelId: "chan-1", userId: "user-1", source: "test" }
  });

  assert.equal(result.videos.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.key, "bad");
  assert.equal(calls[0]?.maxTranscriptChars, 200);
  assert.equal(calls[0]?.keyframeIntervalSeconds, 120);
  assert.equal(calls[0]?.maxKeyframesPerVideo, 8);
  assert.equal(calls[0]?.maxAsrSeconds, 15);
  assert.equal(calls[0]?.allowAsrFallback, true);

  assert.equal(logs.length, 2);
  assert.equal(logs[0]?.kind, "video_context_call");
  assert.equal(logs[1]?.kind, "video_context_error");
  assert.equal(logs[1]?.metadata?.attempts, 3);
});

test("fetchVideoContext sets transcript/keyframe errors when media resolution fails", async () => {
  const { service } = createService();
  service.fetchBaseSummary = async () => ({
    provider: "generic",
    kind: "generic",
    videoId: null,
    url: "https://example.com/watch/5",
    title: "video",
    channel: "example.com",
    publishedAt: null,
    durationSeconds: null,
    viewCount: null,
    description: "",
    transcript: "",
    transcriptSource: "",
    transcriptError: null
  });
  service.resolveMediaInput = async () => {
    throw new Error("media unavailable");
  };

  const result = await service.fetchVideoContext({
    target: { key: "generic:example", kind: "generic", url: "https://example.com/watch/5", forceDirect: false },
    maxTranscriptChars: 1200,
    keyframeIntervalSeconds: 5,
    maxKeyframesPerVideo: 2,
    allowAsrFallback: true,
    maxAsrSeconds: 120,
    trace: {}
  });

  assert.equal(result.keyframeError, "media unavailable");
  assert.equal(result.transcriptError, "media unavailable");
  assert.equal(result.keyframeCount, 0);
  assert.deepEqual(result.frameImages, []);
});

test("fetchVideoContext can populate keyframes and ASR transcript", async () => {
  const { service } = createService();
  let cleanupCount = 0;
  service.fetchBaseSummary = async () => ({
    provider: "generic",
    kind: "generic",
    videoId: null,
    url: "https://example.com/watch/6",
    title: "video",
    channel: "example.com",
    publishedAt: null,
    durationSeconds: null,
    viewCount: null,
    description: "",
    transcript: "",
    transcriptSource: "",
    transcriptError: null
  });
  service.resolveMediaInput = async () => ({
    input: "/tmp/source.mp4",
    cleanup: async () => {
      cleanupCount += 1;
    }
  });
  service.extractKeyframesFromInput = async () => [
    {
      filename: "frame-001.jpg",
      contentType: "image/jpeg",
      mediaType: "image/jpeg",
      dataBase64: "abc123",
      source: "video_keyframe"
    }
  ];
  service.transcribeFromInput = async () => "spoken transcript";

  const result = await service.fetchVideoContext({
    target: { key: "generic:example-6", kind: "generic", url: "https://example.com/watch/6", forceDirect: false },
    maxTranscriptChars: 1200,
    keyframeIntervalSeconds: 3,
    maxKeyframesPerVideo: 2,
    allowAsrFallback: true,
    maxAsrSeconds: 120,
    trace: {}
  });

  assert.equal(result.keyframeCount, 1);
  assert.equal(result.frameImages.length, 1);
  assert.equal(result.transcript, "spoken transcript");
  assert.equal(result.transcriptSource, "asr");
  assert.equal(result.transcriptError, null);
  assert.equal(cleanupCount, 1);
});

test("fetchVideoContext returns fresh cached result without refetching base summary", async () => {
  const { service } = createService();
  service.cache.set("youtube:cached", {
    cachedAt: Date.now(),
    value: {
      provider: "youtube",
      kind: "youtube",
      videoId: "cached",
      url: "https://www.youtube.com/watch?v=cached",
      title: "cached title",
      channel: "cached channel",
      publishedAt: null,
      durationSeconds: 5,
      viewCount: 10,
      description: "",
      transcript: "cached text",
      transcriptSource: "captions",
      transcriptError: null,
      cacheHit: false
    }
  });
  service.fetchBaseSummary = async () => {
    throw new Error("should not fetch base summary when cache is warm");
  };

  const result = await service.fetchVideoContext({
    target: {
      key: "youtube:cached",
      kind: "youtube",
      url: "https://www.youtube.com/watch?v=cached",
      videoId: "cached",
      forceDirect: false
    },
    maxTranscriptChars: 1200,
    keyframeIntervalSeconds: 0,
    maxKeyframesPerVideo: 0,
    allowAsrFallback: false,
    maxAsrSeconds: 120,
    trace: {}
  });

  assert.equal(result.cacheHit, true);
  assert.equal(result.transcript, "cached text");
});
