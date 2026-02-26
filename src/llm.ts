import { createReadStream } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { estimateImageUsdCost, estimateUsdCost } from "./pricing.ts";

const MEMORY_FACT_TYPES = ["preference", "profile", "relationship", "project", "other"];
const DEFAULT_MEMORY_EMBEDDING_MODEL = "text-embedding-3-small";
const XAI_DEFAULT_BASE_URL = "https://api.x.ai/v1";
const XAI_VIDEO_POLL_INTERVAL_MS = 2500;
const XAI_VIDEO_TIMEOUT_MS = 4 * 60_000;
const XAI_REQUEST_TIMEOUT_MS = 20_000;
const XAI_VIDEO_DONE_STATUSES = new Set(["done", "completed", "succeeded", "success", "ready"]);
const XAI_VIDEO_FAILED_STATUSES = new Set(["failed", "error", "cancelled", "canceled"]);
const MEMORY_EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          fact: { type: "string", minLength: 1, maxLength: 190 },
          type: { type: "string", enum: MEMORY_FACT_TYPES },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "string", minLength: 1, maxLength: 220 }
        },
        required: ["fact", "type", "confidence", "evidence"]
      }
    }
  },
  required: ["facts"]
};

export class LLMService {
  constructor({ appConfig, store }) {
    this.appConfig = appConfig;
    this.store = store;

    this.openai = appConfig.openaiApiKey ? new OpenAI({ apiKey: appConfig.openaiApiKey }) : null;
    this.xai = appConfig.xaiApiKey
      ? new OpenAI({
          apiKey: appConfig.xaiApiKey,
          baseURL: normalizeXaiBaseUrl(appConfig.xaiBaseUrl)
        })
      : null;
    this.anthropic = appConfig.anthropicApiKey
      ? new Anthropic({ apiKey: appConfig.anthropicApiKey })
      : null;
  }

  async generate({
    settings,
    systemPrompt,
    userPrompt,
    imageInputs = [],
    contextMessages = [],
    trace = {}
  }) {
    const { provider, model } = this.resolveProviderAndModel(settings?.llm ?? {});
    const temperature = Number(settings?.llm?.temperature) || 0.9;
    const maxOutputTokens = Number(settings?.llm?.maxOutputTokens) || 220;

    try {
      const response =
        provider === "anthropic"
          ? await this.callAnthropic({
              model,
              systemPrompt,
              userPrompt,
              imageInputs,
              contextMessages,
              temperature,
              maxOutputTokens
            })
          : await this.callOpenAI({
              model,
              systemPrompt,
              userPrompt,
              imageInputs,
              contextMessages,
              temperature,
              maxOutputTokens
            });

      const costUsd = estimateUsdCost({
        provider,
        model,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cacheWriteTokens: response.usage.cacheWriteTokens,
        cacheReadTokens: response.usage.cacheReadTokens,
        customPricing: settings?.llm?.pricing
      });

      this.store.logAction({
        kind: "llm_call",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: `${provider}:${model}`,
        metadata: {
          provider,
          model,
          usage: response.usage,
          inputImages: imageInputs.length
        },
        usdCost: costUsd
      });

      return {
        text: response.text,
        provider,
        model,
        usage: response.usage,
        costUsd
      };
    } catch (error) {
      this.store.logAction({
        kind: "llm_error",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: String(error?.message || error),
        metadata: {
          provider,
          model
        }
      });
      throw error;
    }
  }

  async extractMemoryFacts({
    settings,
    authorName,
    messageContent,
    maxFacts = 3,
    trace = {}
  }) {
    const inputText = normalizeInlineText(messageContent, 900);
    if (!inputText || inputText.length < 4) return [];

    const { provider, model } = this.resolveProviderAndModel(settings?.llm ?? {});
    const boundedMaxFacts = clampInt(maxFacts, 1, 6);
    const systemPrompt = [
      "You extract durable memory facts from one Discord user message.",
      "Only keep long-lived facts worth remembering later (preferences, identity, recurring relationships, ongoing projects).",
      "Ignore requests, one-off chatter, jokes, threats, instructions, and ephemeral context.",
      "Every fact must be grounded directly in the message text.",
      `Return strict JSON only with shape: {"facts":[{"fact":"...","type":"preference|profile|relationship|project|other","confidence":0..1,"evidence":"exact short quote"}]}.`,
      "If there are no durable facts, return {\"facts\":[]}."
    ].join("\n");
    const userPrompt = [
      `Author: ${normalizeInlineText(authorName || "unknown", 80)}`,
      `Max facts: ${boundedMaxFacts}`,
      `Message: ${inputText}`
    ].join("\n");

    try {
      const response =
        provider === "anthropic"
          ? await this.callAnthropicMemoryExtraction({
              model,
              systemPrompt,
              userPrompt
            })
          : await this.callOpenAiMemoryExtraction({
              model,
              systemPrompt,
              userPrompt
            });

      const costUsd = estimateUsdCost({
        provider,
        model,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cacheWriteTokens: response.usage.cacheWriteTokens,
        cacheReadTokens: response.usage.cacheReadTokens,
        customPricing: settings?.llm?.pricing
      });
      const parsed = parseMemoryExtractionJson(response.text);
      const facts = normalizeExtractedFacts(parsed, boundedMaxFacts);

      this.store.logAction({
        kind: "memory_extract_call",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: `${provider}:${model}`,
        metadata: {
          provider,
          model,
          usage: response.usage,
          maxFacts: boundedMaxFacts,
          extractedFacts: facts.length
        },
        usdCost: costUsd
      });

      return facts;
    } catch (error) {
      this.store.logAction({
        kind: "memory_extract_error",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: String(error?.message || error),
        metadata: {
          provider,
          model
        }
      });
      throw error;
    }
  }

  async callOpenAiMemoryExtraction({ model, systemPrompt, userPrompt }) {
    const response = await this.openai.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 320,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "memory_fact_extraction",
          strict: true,
          schema: MEMORY_EXTRACTION_SCHEMA
        }
      },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    });

    const text = response.choices?.[0]?.message?.content?.trim() || '{"facts":[]}';

    return {
      text,
      usage: {
        inputTokens: Number(response.usage?.prompt_tokens || 0),
        outputTokens: Number(response.usage?.completion_tokens || 0)
      }
    };
  }

  async callAnthropicMemoryExtraction({ model, systemPrompt, userPrompt }) {
    const response = await this.anthropic.messages.create({
      model,
      system: systemPrompt,
      temperature: 0,
      max_tokens: 320,
      messages: [{ role: "user", content: userPrompt }]
    });

    const text = response.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n")
      .trim();

    return {
      text,
      usage: {
        inputTokens: Number(response.usage?.input_tokens || 0),
        outputTokens: Number(response.usage?.output_tokens || 0),
        cacheWriteTokens: Number(response.usage?.cache_creation_input_tokens || 0),
        cacheReadTokens: Number(response.usage?.cache_read_input_tokens || 0)
      }
    };
  }

  isEmbeddingReady() {
    return Boolean(this.openai);
  }

  async embedText({ settings, text, trace = {} }) {
    if (!this.openai) {
      throw new Error("Embeddings require OPENAI_API_KEY.");
    }

    const input = normalizeInlineText(text, 8000);
    if (!input) {
      return {
        embedding: [],
        model: this.resolveEmbeddingModel(settings),
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0
      };
    }

    const model = this.resolveEmbeddingModel(settings);
    try {
      const response = await this.openai.embeddings.create({
        model,
        input
      });

      const embedding = Array.isArray(response?.data?.[0]?.embedding)
        ? response.data[0].embedding.map((value) => Number(value))
        : [];
      if (!embedding.length) {
        throw new Error("Embedding API returned no vector.");
      }

      const inputTokens = Number(response?.usage?.prompt_tokens || response?.usage?.total_tokens || 0);
      const costUsd = estimateUsdCost({
        provider: "openai",
        model,
        inputTokens,
        outputTokens: 0,
        customPricing: settings?.llm?.pricing
      });

      this.store.logAction({
        kind: "memory_embedding_call",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: model,
        metadata: {
          model,
          inputChars: input.length,
          vectorDims: embedding.length,
          usage: { inputTokens, outputTokens: 0 }
        },
        usdCost: costUsd
      });

      return {
        embedding,
        model,
        usage: { inputTokens, outputTokens: 0 },
        costUsd
      };
    } catch (error) {
      this.store.logAction({
        kind: "memory_embedding_error",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: String(error?.message || error),
        metadata: {
          model
        }
      });
      throw error;
    }
  }

  resolveEmbeddingModel(settings) {
    const fromSettings = String(settings?.memory?.embeddingModel || "").trim();
    if (fromSettings) return fromSettings.slice(0, 120);
    const fromEnv = String(this.appConfig?.defaultMemoryEmbeddingModel || "").trim();
    if (fromEnv) return fromEnv.slice(0, 120);
    return DEFAULT_MEMORY_EMBEDDING_MODEL;
  }

  async generateImage({ settings, prompt, variant = "simple", trace = {} }) {
    const target = this.resolveImageGenerationTarget(settings, variant);
    if (!target) {
      throw new Error("Image generation is unavailable (missing API key or no allowed image model).");
    }

    const { provider, model } = target;
    const client = provider === "xai" ? this.xai : this.openai;
    if (!client) {
      throw new Error(
        provider === "xai"
          ? "xAI image generation requires XAI_API_KEY."
          : "OpenAI image generation requires OPENAI_API_KEY."
      );
    }

    const size = "1024x1024";

    try {
      const response = await client.images.generate({
        model,
        prompt: String(prompt || "").slice(0, 3200),
        size
      });

      const first = response?.data?.[0];
      if (!first) {
        throw new Error("Image API returned no image data.");
      }

      let imageBuffer = null;
      if (first.b64_json) {
        imageBuffer = Buffer.from(first.b64_json, "base64");
      }

      const imageUrl = first.url ? String(first.url) : null;
      if (!imageBuffer && !imageUrl) {
        throw new Error("Image API response had neither b64 nor URL.");
      }

      const costUsd = estimateImageUsdCost({
        provider,
        model,
        size,
        imageCount: 1,
        customPricing: settings?.llm?.pricing
      });

      this.store.logAction({
        kind: "image_call",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: `${provider}:${model}`,
        metadata: {
          provider,
          model,
          size,
          variant,
          source: trace.source || "unknown"
        },
        usdCost: costUsd
      });

      return {
        provider,
        model,
        size,
        variant,
        costUsd,
        imageBuffer,
        imageUrl
      };
    } catch (error) {
      this.store.logAction({
        kind: "image_error",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: String(error?.message || error),
        metadata: {
          provider,
          model,
          variant,
          source: trace.source || "unknown"
        }
      });
      throw error;
    }
  }

  async generateVideo({ settings, prompt, trace = {} }) {
    const target = this.resolveVideoGenerationTarget(settings);
    if (!target) {
      throw new Error("Video generation is unavailable (missing XAI_API_KEY or no allowed xAI video model).");
    }

    const model = target.model;
    const baseUrl = normalizeXaiBaseUrl(this.appConfig?.xaiBaseUrl);
    const payload = {
      model,
      prompt: String(prompt || "").slice(0, 3200)
    };

    try {
      const createResponse = await this.fetchXaiJson(
        `${baseUrl}/videos/generations`,
        {
          method: "POST",
          body: payload
        },
        XAI_REQUEST_TIMEOUT_MS
      );

      const requestId = String(createResponse?.id || createResponse?.request_id || "").trim();
      if (!requestId) {
        throw new Error("xAI video API returned no request id.");
      }

      const startedAt = Date.now();
      let pollAttempts = 0;
      let statusResponse = null;

      while (Date.now() - startedAt < XAI_VIDEO_TIMEOUT_MS) {
        await sleepMs(XAI_VIDEO_POLL_INTERVAL_MS);
        pollAttempts += 1;

        const poll = await this.fetchXaiJson(
          `${baseUrl}/videos/${encodeURIComponent(requestId)}`,
          { method: "GET" },
          XAI_REQUEST_TIMEOUT_MS
        );
        const status = String(poll?.status || "").trim().toLowerCase();

        if (isXaiVideoDone(status, poll)) {
          statusResponse = poll;
          break;
        }
        if (XAI_VIDEO_FAILED_STATUSES.has(status)) {
          throw new Error(`xAI video generation failed with status "${status}".`);
        }
      }

      if (!statusResponse) {
        throw new Error(`xAI video generation timed out after ${Math.floor(XAI_VIDEO_TIMEOUT_MS / 1000)}s.`);
      }

      const status = String(statusResponse?.status || "").trim().toLowerCase() || "done";
      const videoUrl = extractXaiVideoUrl(statusResponse);
      if (!videoUrl) {
        throw new Error("xAI video generation completed but returned no video URL.");
      }

      const durationSeconds = Number(
        statusResponse?.video?.duration_seconds ??
          statusResponse?.video?.duration ??
          statusResponse?.duration_seconds ??
          statusResponse?.duration ??
          0
      );
      const normalizedDuration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null;
      const costUsd = 0;

      this.store.logAction({
        kind: "video_call",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: `xai:${model}`,
        metadata: {
          provider: "xai",
          model,
          requestId,
          status,
          pollAttempts,
          durationSeconds: normalizedDuration,
          source: trace.source || "unknown"
        },
        usdCost: costUsd
      });

      return {
        provider: "xai",
        model,
        requestId,
        status,
        pollAttempts,
        durationSeconds: normalizedDuration,
        videoUrl,
        costUsd
      };
    } catch (error) {
      this.store.logAction({
        kind: "video_error",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: String(error?.message || error),
        metadata: {
          provider: "xai",
          model,
          source: trace.source || "unknown"
        }
      });
      throw error;
    }
  }

  async fetchXaiJson(url, { method = "GET", body } = {}, timeoutMs = XAI_REQUEST_TIMEOUT_MS) {
    if (!this.appConfig?.xaiApiKey) {
      throw new Error("Missing XAI_API_KEY.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.appConfig.xaiApiKey}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });

      const raw = await response.text();
      const parsed = raw ? safeJsonParse(raw, null) : {};
      if (!response.ok) {
        const message = normalizeInlineText(
          parsed?.error?.message || parsed?.message || raw || response.statusText,
          240
        );
        throw new Error(`xAI request failed (${response.status})${message ? `: ${message}` : ""}`);
      }

      if (parsed && typeof parsed === "object") return parsed;
      throw new Error("xAI returned an invalid JSON payload.");
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`xAI request timed out after ${Math.floor(timeoutMs / 1000)}s.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  getMediaGenerationCapabilities(settings) {
    const simpleImageTarget = this.resolveImageGenerationTarget(settings, "simple");
    const complexImageTarget = this.resolveImageGenerationTarget(settings, "complex");
    const videoTarget = this.resolveVideoGenerationTarget(settings);
    return {
      simpleImageReady: Boolean(simpleImageTarget),
      complexImageReady: Boolean(complexImageTarget),
      videoReady: Boolean(videoTarget),
      simpleImageModel: simpleImageTarget?.model || null,
      complexImageModel: complexImageTarget?.model || null,
      videoModel: videoTarget?.model || null
    };
  }

  isImageGenerationReady(settings, variant = "any") {
    if (variant === "simple") {
      return Boolean(this.resolveImageGenerationTarget(settings, "simple"));
    }
    if (variant === "complex") {
      return Boolean(this.resolveImageGenerationTarget(settings, "complex"));
    }
    return Boolean(
      this.resolveImageGenerationTarget(settings, "simple") ||
        this.resolveImageGenerationTarget(settings, "complex")
    );
  }

  isVideoGenerationReady(settings) {
    return Boolean(this.resolveVideoGenerationTarget(settings));
  }

  resolveImageGenerationTarget(settings, variant = "simple") {
    const allowedModels = normalizeModelAllowlist(settings?.initiative?.allowedImageModels);
    if (!allowedModels.length) return null;

    const preferredModel = String(
      variant === "complex" ? settings?.initiative?.complexImageModel : settings?.initiative?.simpleImageModel
    ).trim();
    const candidates = prioritizePreferredModel(allowedModels, preferredModel);

    for (const model of candidates) {
      const provider = inferProviderFromModel(model);
      if (provider === "openai" && this.openai) return { provider, model };
      if (provider === "xai" && this.xai) return { provider, model };
    }

    return null;
  }

  resolveVideoGenerationTarget(settings) {
    if (!this.xai) return null;

    const allowedModels = normalizeModelAllowlist(settings?.initiative?.allowedVideoModels);
    if (!allowedModels.length) return null;

    const preferredModel = String(settings?.initiative?.videoModel || "").trim();
    const candidates = prioritizePreferredModel(allowedModels, preferredModel);
    for (const model of candidates) {
      if (inferProviderFromModel(model) === "xai") {
        return { provider: "xai", model };
      }
    }

    return null;
  }

  isAsrReady() {
    return Boolean(this.openai);
  }

  async transcribeAudio({ filePath, model = "gpt-4o-mini-transcribe", trace = {} }) {
    if (!this.openai) {
      throw new Error("ASR fallback requires OPENAI_API_KEY.");
    }

    const resolvedModel = String(model || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
    try {
      const response = await this.openai.audio.transcriptions.create({
        model: resolvedModel,
        file: createReadStream(String(filePath)),
        response_format: "text"
      });

      const text =
        typeof response === "string"
          ? response.trim()
          : String(response?.text || response?.transcript || "").trim();
      if (!text) {
        throw new Error("ASR returned empty transcript.");
      }

      this.store.logAction({
        kind: "asr_call",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: resolvedModel,
        metadata: {
          model: resolvedModel,
          source: trace.source || "unknown"
        }
      });

      return text;
    } catch (error) {
      this.store.logAction({
        kind: "asr_error",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: String(error?.message || error),
        metadata: {
          model: resolvedModel,
          source: trace.source || "unknown"
        }
      });
      throw error;
    }
  }

  resolveProviderAndModel(llmSettings) {
    const desiredProvider = llmSettings.provider === "anthropic" ? "anthropic" : "openai";

    if (desiredProvider === "anthropic") {
      if (!this.anthropic) {
        if (!this.openai) {
          throw new Error("No LLM provider available. Add OPENAI_API_KEY or ANTHROPIC_API_KEY.");
        }

        return {
          provider: "openai",
          model: this.appConfig.defaultOpenAiModel
        };
      }

      return {
        provider: "anthropic",
        model: llmSettings.model || this.appConfig.defaultAnthropicModel
      };
    }

    if (!this.openai) {
      if (!this.anthropic) {
        throw new Error("No LLM provider available. Add OPENAI_API_KEY or ANTHROPIC_API_KEY.");
      }

      return {
        provider: "anthropic",
        model: this.appConfig.defaultAnthropicModel
      };
    }

    return {
      provider: "openai",
      model: llmSettings.model || this.appConfig.defaultOpenAiModel
    };
  }

  async callOpenAI({
    model,
    systemPrompt,
    userPrompt,
    imageInputs,
    contextMessages,
    temperature,
    maxOutputTokens
  }) {
    const imageParts = imageInputs
      .map((image) => {
        const mediaType = String(image?.mediaType || image?.contentType || "").trim().toLowerCase();
        const base64 = String(image?.dataBase64 || "").trim();
        const url = String(image?.url || "").trim();
        const imageUrl = base64 && /^image\/[a-z0-9.+-]+$/i.test(mediaType) ? `data:${mediaType};base64,${base64}` : url;
        if (!imageUrl) return null;
        return {
          type: "image_url",
          image_url: {
            url: imageUrl,
            detail: "auto"
          }
        };
      })
      .filter(Boolean);
    const userContent = imageParts.length
      ? [
          { type: "text", text: userPrompt },
          ...imageParts
        ]
      : userPrompt;

    const messages = [
      { role: "system", content: systemPrompt },
      ...contextMessages.map((msg) => ({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content
      })),
      { role: "user", content: userContent }
    ];

    const response = await this.openai.chat.completions.create({
      model,
      temperature,
      max_tokens: maxOutputTokens,
      messages
    });

    const text = response.choices?.[0]?.message?.content?.trim() || "";

    return {
      text,
      usage: {
        inputTokens: Number(response.usage?.prompt_tokens || 0),
        outputTokens: Number(response.usage?.completion_tokens || 0)
      }
    };
  }

  async callAnthropic({
    model,
    systemPrompt,
    userPrompt,
    imageInputs,
    contextMessages,
    temperature,
    maxOutputTokens
  }) {
    const imageParts = imageInputs
      .map((image) => {
        const mediaType = String(image?.mediaType || image?.contentType || "").trim().toLowerCase();
        const base64 = String(image?.dataBase64 || "").trim();
        const url = String(image?.url || "").trim();
        if (base64 && /^image\/[a-z0-9.+-]+$/i.test(mediaType)) {
          return {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: base64
            }
          };
        }
        if (!url) return null;
        return {
          type: "image",
          source: {
            type: "url",
            url
          }
        };
      })
      .filter(Boolean);
    const userContent = imageParts.length
      ? [
          { type: "text", text: userPrompt },
          ...imageParts
        ]
      : userPrompt;

    const messages = [
      ...contextMessages.map((msg) => ({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content
      })),
      { role: "user", content: userContent }
    ];

    const response = await this.anthropic.messages.create({
      model,
      system: systemPrompt,
      temperature,
      max_tokens: maxOutputTokens,
      messages
    });

    const text = response.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n")
      .trim();

    return {
      text,
      usage: {
        inputTokens: Number(response.usage?.input_tokens || 0),
        outputTokens: Number(response.usage?.output_tokens || 0),
        cacheWriteTokens: Number(response.usage?.cache_creation_input_tokens || 0),
        cacheReadTokens: Number(response.usage?.cache_read_input_tokens || 0)
      }
    };
  }
}

function normalizeInlineText(value, maxLen) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function clamp01(value, fallback = 0.5) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

function clampInt(value, min, max) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return min;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function normalizeFactType(type) {
  const normalized = String(type || "")
    .trim()
    .toLowerCase();
  return MEMORY_FACT_TYPES.includes(normalized) ? normalized : "other";
}

function parseMemoryExtractionJson(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) return { facts: [] };

  const attempts = [
    raw,
    raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1],
    (() => {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      return start >= 0 && end > start ? raw.slice(start, end + 1) : "";
    })()
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean);

  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // try next candidate
    }
  }

  return { facts: [] };
}

function normalizeExtractedFacts(parsed, maxFacts) {
  const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];
  const normalized = [];

  for (const item of facts) {
    if (!item || typeof item !== "object") continue;

    const fact = normalizeInlineText(item.fact, 190);
    const evidence = normalizeInlineText(item.evidence, 220);
    if (!fact || !evidence) continue;

    normalized.push({
      fact,
      type: normalizeFactType(item.type),
      confidence: clamp01(item.confidence, 0.5),
      evidence
    });
    if (normalized.length >= maxFacts) break;
  }

  return normalized;
}

function normalizeXaiBaseUrl(value) {
  const raw = String(value || XAI_DEFAULT_BASE_URL).trim();
  const normalized = raw || XAI_DEFAULT_BASE_URL;
  return normalized.replace(/\/+$/, "");
}

function normalizeModelAllowlist(input, maxItems = 20) {
  if (!Array.isArray(input)) return [];

  return [...new Set(input.map((item) => String(item || "").trim()).filter(Boolean))]
    .slice(0, Math.max(1, maxItems))
    .map((item) => item.slice(0, 120));
}

function prioritizePreferredModel(allowedModels, preferredModel) {
  const preferred = String(preferredModel || "").trim();
  if (!preferred || !allowedModels.includes(preferred)) return allowedModels;
  return [preferred, ...allowedModels.filter((entry) => entry !== preferred)];
}

function inferProviderFromModel(model) {
  const normalized = String(model || "").trim().toLowerCase();
  if (!normalized) return "openai";
  if (normalized.startsWith("xai/")) return "xai";
  if (normalized.includes("grok")) return "xai";
  return "openai";
}

function isXaiVideoDone(status, payload) {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (XAI_VIDEO_DONE_STATUSES.has(normalizedStatus)) return true;
  return Boolean(extractXaiVideoUrl(payload));
}

function extractXaiVideoUrl(payload) {
  const directUrl = String(payload?.video?.url || payload?.url || "").trim();
  if (directUrl) return directUrl;

  if (Array.isArray(payload?.videos)) {
    for (const item of payload.videos) {
      const url = String(item?.url || item?.video?.url || "").trim();
      if (url) return url;
    }
  }

  return "";
}

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}
