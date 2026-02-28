import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LLMService } from "./llm.ts";

function createService(appConfig = {}, { logs = null } = {}) {
  return new LLMService({
    appConfig: {
      openaiApiKey: "",
      xaiApiKey: "",
      xaiBaseUrl: "https://api.x.ai/v1",
      anthropicApiKey: "",
      defaultProvider: "openai",
      defaultOpenAiModel: "gpt-4.1-mini",
      defaultAnthropicModel: "claude-haiku-4-5",
      defaultXaiModel: "grok-3-mini-latest",
      defaultClaudeCodeModel: "sonnet",
      ...appConfig
    },
    store: {
      logAction(entry) {
        if (Array.isArray(logs)) logs.push(entry);
      }
    }
  });
}

test("resolveProviderAndModel throws when claude-code is selected but CLI is unavailable", () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  service.claudeCodeAvailable = false;

  assert.throws(
    () => service.resolveProviderAndModel({ provider: "claude-code", model: "opus" }),
    /claude-code.*not available on PATH/i
  );
});

test("resolveProviderAndModel keeps claude-code provider when CLI is available", () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  service.claudeCodeAvailable = true;

  const resolved = service.resolveProviderAndModel({ provider: "claude-code", model: "opus" });
  assert.deepEqual(resolved, { provider: "claude-code", model: "opus" });
});

test("resolveProviderAndModel rejects unsupported claude-code model IDs", () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  service.claudeCodeAvailable = true;

  assert.throws(
    () => service.resolveProviderAndModel({ provider: "claude-code", model: "claude-3-5-haiku-latest" }),
    /invalid claude-code model/i
  );
});

test("resolveDefaultModel uses claude-haiku-4-5 for anthropic fallback", () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key", defaultAnthropicModel: "" });
  const resolved = service.resolveProviderAndModel({ provider: "anthropic", model: "" });
  assert.deepEqual(resolved, { provider: "anthropic", model: "claude-haiku-4-5" });
});

test("resolveProviderAndModel falls back from unavailable openai to anthropic", () => {
  const service = createService({
    openaiApiKey: "",
    anthropicApiKey: "test-anthropic-key"
  });

  const resolved = service.resolveProviderAndModel({ provider: "openai", model: "" });
  assert.deepEqual(resolved, { provider: "anthropic", model: "claude-haiku-4-5" });
});

test("media generation capability helpers select configured provider/model targets", () => {
  const service = createService({
    openaiApiKey: "test-openai-key",
    xaiApiKey: "test-xai-key"
  });

  const settings = {
    initiative: {
      simpleImageModel: "gpt-image-1.5",
      complexImageModel: "grok-imagine-image",
      videoModel: "grok-imagine-video",
      allowedImageModels: ["gpt-image-1.5", "grok-imagine-image"],
      allowedVideoModels: ["grok-imagine-video", "gpt-video-1"]
    }
  };

  const caps = service.getMediaGenerationCapabilities(settings);
  assert.equal(caps.simpleImageReady, true);
  assert.equal(caps.simpleImageModel, "gpt-image-1.5");
  assert.equal(caps.complexImageReady, true);
  assert.equal(caps.complexImageModel, "grok-imagine-image");
  assert.equal(caps.videoReady, true);
  assert.equal(caps.videoModel, "grok-imagine-video");

  assert.equal(service.isImageGenerationReady(settings, "simple"), true);
  assert.equal(service.isImageGenerationReady(settings, "complex"), true);
  assert.equal(service.isVideoGenerationReady(settings), true);
});

test("resolveVideoGenerationTarget returns null when xai is unavailable", () => {
  const service = createService({
    openaiApiKey: "test-openai-key",
    xaiApiKey: ""
  });

  const settings = {
    initiative: {
      videoModel: "grok-imagine-video",
      allowedVideoModels: ["grok-imagine-video"]
    }
  };
  assert.equal(service.resolveVideoGenerationTarget(settings), null);
});

test("transcribeAudio and synthesizeSpeech enforce readiness and log successful calls", async () => {
  const logs = [];
  const service = createService(
    {
      openaiApiKey: "test-openai-key"
    },
    { logs }
  );
  service.openai = {
    audio: {
      transcriptions: {
        async create() {
          return { text: "hello world" };
        }
      },
      speech: {
        async create() {
          return {
            async arrayBuffer() {
              return new Uint8Array([1, 2, 3, 4]).buffer;
            }
          };
        }
      }
    }
  };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-llm-test-"));
  const wavPath = path.join(dir, "sample.wav");
  await fs.writeFile(wavPath, "fake audio bytes");

  try {
    const transcript = await service.transcribeAudio({
      filePath: wavPath,
      trace: { source: "unit_test" }
    });
    assert.equal(transcript, "hello world");

    const tts = await service.synthesizeSpeech({
      text: "say less",
      trace: { source: "unit_test" }
    });
    assert.equal(tts.audioBuffer.length > 0, true);
    assert.equal(tts.responseFormat, "pcm");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }

  assert.equal(logs.some((entry) => entry.kind === "asr_call"), true);
  assert.equal(logs.some((entry) => entry.kind === "tts_call"), true);
});

test("synthesizeSpeech rejects empty text input", async () => {
  const service = createService({
    openaiApiKey: "test-openai-key"
  });
  service.openai = {
    audio: {
      speech: {
        async create() {
          throw new Error("should not be called");
        }
      }
    }
  };

  await assert.rejects(
    () => service.synthesizeSpeech({ text: "   " }),
    /requires non-empty text/i
  );
});

test("fetchXaiJson requires XAI API key", async () => {
  const service = createService({
    xaiApiKey: ""
  });
  await assert.rejects(
    () => service.fetchXaiJson("https://api.x.ai/v1/videos"),
    /Missing XAI_API_KEY/i
  );
});
