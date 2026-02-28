import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { estimateImageUsdCost, estimateUsdCost } from "./pricing.ts";
import {
  buildAnthropicImageParts,
  buildClaudeCodeCliArgs,
  buildClaudeCodeFallbackPrompt,
  buildClaudeCodeJsonCliArgs,
  buildClaudeCodeStreamInput,
  buildClaudeCodeSystemPrompt,
  buildClaudeCodeTextCliArgs,
  normalizeClaudeCodeCliError,
  parseClaudeCodeJsonOutput,
  parseClaudeCodeStreamOutput,
  runClaudeCli,
  safeJsonParse,
  sleepMs
} from "./llmClaudeCode.ts";
import {
  MEMORY_FACT_SUBJECTS,
  MEMORY_FACT_TYPES,
  clampInt,
  clampNumber,
  extractOpenAiImageBase64,
  extractOpenAiResponseText,
  extractOpenAiResponseUsage,
  extractXaiVideoUrl,
  inferProviderFromModel,
  isXaiVideoDone,
  normalizeClaudeCodeModel,
  normalizeDefaultModel,
  normalizeExtractedFacts,
  normalizeInlineText,
  normalizeLlmProvider,
  normalizeModelAllowlist,
  normalizeOpenAiImageGenerationSize,
  normalizeXaiBaseUrl,
  parseMemoryExtractionJson,
  prioritizePreferredModel,
  resolveProviderFallbackOrder
} from "./llm/llmHelpers.ts";

const CLAUDE_CODE_TIMEOUT_MS = 30_000;
const CLAUDE_CODE_MAX_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_MEMORY_EMBEDDING_MODEL = "text-embedding-3-small";
const XAI_VIDEO_POLL_INTERVAL_MS = 2500;
const XAI_VIDEO_TIMEOUT_MS = 4 * 60_000;
const XAI_REQUEST_TIMEOUT_MS = 20_000;
const XAI_VIDEO_FAILED_STATUSES = new Set(["failed", "error", "cancelled", "canceled"]);
type XaiJsonPrimitive = string | number | boolean | null;
type XaiJsonValue = XaiJsonPrimitive | XaiJsonRecord | XaiJsonValue[];
type XaiJsonRecord = {
  [key: string]: XaiJsonValue;
};

type XaiJsonRequestOptions = {
  method?: string;
  body?: XaiJsonRecord | null;
};
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
          subject: { type: "string", enum: MEMORY_FACT_SUBJECTS },
          fact: { type: "string", minLength: 1, maxLength: 190 },
          type: { type: "string", enum: MEMORY_FACT_TYPES },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "string", minLength: 1, maxLength: 220 }
        },
        required: ["subject", "fact", "type", "confidence", "evidence"]
      }
    }
  },
  required: ["facts"]
};

function buildOpenAiTemperatureParam(model: string, temperature: number) {
  const normalizedModel = String(model || "")
    .trim()
    .toLowerCase();
  if (/^gpt-5(?:$|[-_])/u.test(normalizedModel)) {
    return {};
  }
  return {
    temperature
  };
}

function normalizeOpenAiReasoningEffort(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "minimal") return "minimal";
  if (normalized === "low") return "low";
  if (normalized === "medium") return "medium";
  if (normalized === "high") return "high";
  return "";
}

function buildOpenAiReasoningParam(model: string, reasoningEffort: unknown = "") {
  const normalizedModel = String(model || "")
    .trim()
    .toLowerCase();
  if (!/^gpt-5(?:$|[-_])/u.test(normalizedModel)) {
    return {};
  }
  const resolvedEffort = normalizeOpenAiReasoningEffort(reasoningEffort) || "low";
  return {
    reasoning: {
      effort: resolvedEffort
    }
  };
}

export class LLMService {
  appConfig;
  store;
  openai;
  xai;
  anthropic;
  claudeCodeAvailable;

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

    this.claudeCodeAvailable = false;
    try {
      const result = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 5000 });
      const versionOutput = String(result?.stdout || result?.stderr || "").trim();
      this.claudeCodeAvailable = result?.status === 0 && Boolean(versionOutput);
    } catch {
      this.claudeCodeAvailable = false;
    }
  }

  async generate({
    settings,
    systemPrompt,
    userPrompt,
    imageInputs = [],
    contextMessages = [],
    trace = {
      guildId: null,
      channelId: null,
      userId: null,
      source: null,
      event: null,
      reason: null,
      messageId: null
    },
    jsonSchema = ""
  }) {
    const { provider, model } = this.resolveProviderAndModel(settings?.llm ?? {});
    const temperature = Number(settings?.llm?.temperature) || 0.9;
    const maxOutputTokens = Number(settings?.llm?.maxOutputTokens) || 220;

    try {
      const response =
        provider === "claude-code"
          ? await this.callClaudeCode({
              model,
              systemPrompt,
              userPrompt,
              imageInputs,
              contextMessages,
              maxOutputTokens,
              jsonSchema
            })
          : provider === "anthropic"
            ? await this.callAnthropic({
                model,
                systemPrompt,
                userPrompt,
                imageInputs,
                contextMessages,
                temperature,
                maxOutputTokens
              })
            : provider === "xai"
              ? await this.callXai({
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
                  maxOutputTokens,
                  reasoningEffort: settings?.llm?.reasoningEffort
                });

      const costUsd = estimateUsdCost({
        provider,
        model,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cacheWriteTokens: Number(response.usage.cacheWriteTokens || 0),
        cacheReadTokens: Number(response.usage.cacheReadTokens || 0),
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
          inputImages: imageInputs.length,
          source: trace.source ? String(trace.source) : null,
          event: trace.event ? String(trace.event) : null,
          reason: trace.reason ? String(trace.reason) : null,
          messageId: trace.messageId ? String(trace.messageId) : null
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
    trace = {
      guildId: null,
      channelId: null,
      userId: null,
      source: null,
      event: null,
      reason: null,
      messageId: null
    }
  }) {
    const inputText = normalizeInlineText(messageContent, 900);
    if (!inputText || inputText.length < 4) return [];

    const llmOverride = settings?.memoryLlm ?? settings?.llm ?? {};
    const { provider, model } = this.resolveProviderAndModel(llmOverride);
    const boundedMaxFacts = clampInt(maxFacts, 1, 6);
    const normalizedBotName = normalizeInlineText(settings?.botName || "the bot", 80) || "the bot";
    const systemPrompt = [
      "You extract durable memory facts from one Discord user message.",
      "Only keep long-lived facts worth remembering later (preferences, identity, recurring relationships, ongoing projects).",
      "Ignore requests, one-off chatter, jokes, threats, instructions, and ephemeral context.",
      "Every fact must be grounded directly in the message text.",
      "Classify each fact subject as one of: author, bot, lore.",
      "Use subject=author for facts about the message author.",
      `Use subject=bot only for explicit durable facts about ${normalizedBotName} (identity, alias, stable preference, standing commitment).`,
      `Do not store insults, commands, or one-off taunts about ${normalizedBotName} as bot facts.`,
      "Use subject=lore for stable shared context not tied to a single person.",
      "If subject is unclear, omit that fact.",
      `Return strict JSON only with shape: {"facts":[{"subject":"author|bot|lore","fact":"...","type":"preference|profile|relationship|project|other","confidence":0..1,"evidence":"exact short quote"}]}.`,
      "If there are no durable facts, return {\"facts\":[]}."
    ].join("\n");
    const userPrompt = [
      `Author: ${normalizeInlineText(authorName || "unknown", 80)}`,
      `Max facts: ${boundedMaxFacts}`,
      `Message: ${inputText}`
    ].join("\n");

    try {
      const response =
        provider === "claude-code"
          ? await this.callClaudeCodeMemoryExtraction({
              model,
              systemPrompt,
              userPrompt
            })
          : provider === "anthropic"
            ? await this.callAnthropicMemoryExtraction({
                model,
                systemPrompt,
                userPrompt
              })
            : provider === "xai"
              ? await this.callXaiMemoryExtraction({
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
    if (!this.openai) {
      throw new Error("Memory fact extraction requires OPENAI_API_KEY when provider is openai.");
    }

    const response = await this.openai.responses.create({
      model,
      instructions: systemPrompt,
      ...buildOpenAiTemperatureParam(model, 0),
      ...buildOpenAiReasoningParam(model, "minimal"),
      max_output_tokens: 320,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: userPrompt
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "memory_fact_extraction",
          strict: true,
          schema: MEMORY_EXTRACTION_SCHEMA
        }
      },
    });

    const text = extractOpenAiResponseText(response) || '{"facts":[]}';

    return {
      text,
      usage: extractOpenAiResponseUsage(response)
    };
  }

  async callXaiMemoryExtraction({ model, systemPrompt, userPrompt }) {
    if (!this.xai) {
      throw new Error("Memory fact extraction requires XAI_API_KEY when provider is xai.");
    }

    const response = await this.xai.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 320,
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
        outputTokens: Number(response.usage?.completion_tokens || 0),
        cacheWriteTokens: 0,
        cacheReadTokens: 0
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

  async callClaudeCode({
    model,
    systemPrompt,
    userPrompt,
    imageInputs = [],
    contextMessages = [],
    maxOutputTokens,
    jsonSchema = ""
  }) {
    if (!this.claudeCodeAvailable) {
      throw new Error("claude-code provider requires the 'claude' CLI to be installed.");
    }

    const streamInput = buildClaudeCodeStreamInput({
      contextMessages,
      userPrompt,
      imageInputs
    });
    const claudeSystemPrompt = buildClaudeCodeSystemPrompt({
      systemPrompt,
      maxOutputTokens
    });
    const streamArgs = buildClaudeCodeCliArgs({
      model,
      systemPrompt: claudeSystemPrompt,
      jsonSchema
    });
    let streamFailure = "";

    try {
      const { stdout } = await runClaudeCli({
        args: streamArgs,
        input: streamInput,
        timeoutMs: CLAUDE_CODE_TIMEOUT_MS,
        maxBufferBytes: CLAUDE_CODE_MAX_BUFFER_BYTES
      });

      const parsed = parseClaudeCodeStreamOutput(stdout);
      if (parsed?.isError) {
        throw new Error(parsed.errorMessage || "claude-code returned an error result.");
      }
      if (parsed && String(parsed.text || "").trim()) {
        return {
          text: parsed.text,
          usage: parsed.usage,
          costUsd: parsed.costUsd
        };
      }

      streamFailure = "claude-code returned an empty or invalid stream response.";
    } catch (error) {
      const normalizedError = normalizeClaudeCodeCliError(error, {
        timeoutPrefix: "claude-code timed out"
      });
      if (normalizedError.isTimeout) {
        throw new Error(normalizedError.message);
      }
      streamFailure = normalizedError.message;
    }

    const fallbackPrompt = buildClaudeCodeFallbackPrompt({
      contextMessages,
      userPrompt,
      imageInputs
    });
    const fallbackArgs = buildClaudeCodeJsonCliArgs({
      model,
      systemPrompt: claudeSystemPrompt,
      jsonSchema,
      prompt: fallbackPrompt
    });
    let jsonFallbackFailure = "";

    try {
      const { stdout } = await runClaudeCli({
        args: fallbackArgs,
        input: "",
        timeoutMs: CLAUDE_CODE_TIMEOUT_MS,
        maxBufferBytes: CLAUDE_CODE_MAX_BUFFER_BYTES
      });
      const parsed = parseClaudeCodeJsonOutput(stdout);
      if (parsed?.isError) {
        throw new Error(parsed.errorMessage || "claude-code returned an error result.");
      }
      if (!parsed || !String(parsed.text || "").trim()) {
        throw new Error("claude-code returned an empty or invalid fallback response.");
      }

      return {
        text: parsed.text,
        usage: parsed.usage,
        costUsd: parsed.costUsd
      };
    } catch (error) {
      const normalizedError = normalizeClaudeCodeCliError(error, {
        timeoutPrefix: "claude-code fallback timed out"
      });
      if (normalizedError.isTimeout) {
        throw new Error(
          streamFailure
            ? `${streamFailure} | fallback: ${normalizedError.message}`
            : normalizedError.message
        );
      }
      jsonFallbackFailure = normalizedError.message;
    }

    const textFallbackArgs = buildClaudeCodeTextCliArgs({
      model,
      systemPrompt: claudeSystemPrompt,
      jsonSchema,
      prompt: fallbackPrompt
    });
    try {
      const { stdout } = await runClaudeCli({
        args: textFallbackArgs,
        input: "",
        timeoutMs: CLAUDE_CODE_TIMEOUT_MS,
        maxBufferBytes: CLAUDE_CODE_MAX_BUFFER_BYTES
      });
      const text = String(stdout || "").trim();
      if (!text) {
        throw new Error("claude-code returned an empty or invalid text fallback response.");
      }

      return {
        text,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0
        },
        costUsd: 0
      };
    } catch (error) {
      const normalizedError = normalizeClaudeCodeCliError(error, {
        timeoutPrefix: "claude-code text fallback timed out"
      });
      const messageParts = [streamFailure, jsonFallbackFailure, normalizedError.message].filter(Boolean);
      throw new Error(messageParts.join(" | "));
    }
  }

  async callClaudeCodeMemoryExtraction({ model, systemPrompt, userPrompt }) {
    if (!this.claudeCodeAvailable) {
      throw new Error("claude-code provider requires the 'claude' CLI to be installed.");
    }

    const schemaJson = JSON.stringify(MEMORY_EXTRACTION_SCHEMA);
    const streamInput = buildClaudeCodeStreamInput({
      contextMessages: [],
      userPrompt,
      imageInputs: []
    });

    try {
      const { stdout } = await runClaudeCli({
        args: buildClaudeCodeCliArgs({
          model,
          systemPrompt,
          jsonSchema: schemaJson
        }),
        input: streamInput,
        timeoutMs: CLAUDE_CODE_TIMEOUT_MS,
        maxBufferBytes: CLAUDE_CODE_MAX_BUFFER_BYTES
      });

      const parsed = parseClaudeCodeStreamOutput(stdout);
      if (!parsed || !String(parsed.text || "").trim()) {
        throw new Error("claude-code returned an empty or invalid stream response.");
      }
      if (parsed.isError) {
        throw new Error(parsed.errorMessage || "claude-code returned an error result.");
      }

      return {
        text: parsed.text,
        usage: parsed.usage
      };
    } catch (error) {
      const normalizedError = normalizeClaudeCodeCliError(error, {
        timeoutPrefix: "claude-code memory extraction timed out"
      });
      throw new Error(normalizedError.message);
    }
  }

  isEmbeddingReady() {
    return Boolean(this.openai);
  }

  async embedText({
    settings,
    text,
    trace = { guildId: null, channelId: null, userId: null, source: null }
  }) {
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
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
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

  async generateImage({
    settings,
    prompt,
    variant = "simple",
    trace = { guildId: null, channelId: null, userId: null, source: null }
  }) {
    const target = this.resolveImageGenerationTarget(settings, variant);
    if (!target) {
      throw new Error("Image generation is unavailable (missing API key or no allowed image model).");
    }

    const { provider, model } = target;
    const normalizedPrompt = String(prompt || "").slice(0, 3200);
    const size = provider === "openai" ? "1024x1024" : null;

    try {
      let imageBuffer = null;
      let imageUrl = null;

      if (provider === "openai") {
        if (!this.openai) {
          throw new Error("OpenAI image generation requires OPENAI_API_KEY.");
        }
        const response = await this.openai.responses.create({
          model,
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: normalizedPrompt
                }
              ]
            }
          ],
          tool_choice: "required",
          tools: [
            {
              type: "image_generation",
              output_format: "png",
              size: normalizeOpenAiImageGenerationSize(size)
            }
          ]
        });
        const imageBase64 = extractOpenAiImageBase64(response);
        if (!imageBase64) {
          throw new Error("Image API returned no image data.");
        }
        imageBuffer = Buffer.from(imageBase64, "base64");
      } else {
        if (!this.xai) {
          throw new Error("xAI image generation requires XAI_API_KEY.");
        }
        const response = await this.xai.images.generate({
          model,
          prompt: normalizedPrompt
        });
        const first = response?.data?.[0];
        if (!first) {
          throw new Error("Image API returned no image data.");
        }

        if (first.b64_json) {
          imageBuffer = Buffer.from(first.b64_json, "base64");
        }
        imageUrl = first.url ? String(first.url) : null;
        if (!imageBuffer && !imageUrl) {
          throw new Error("Image API response had neither b64 nor URL.");
        }
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

  async generateVideo({
    settings,
    prompt,
    trace = { guildId: null, channelId: null, userId: null, source: null }
  }) {
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

  async fetchXaiJson(url, options: XaiJsonRequestOptions = {}, timeoutMs = XAI_REQUEST_TIMEOUT_MS) {
    const { method = "GET", body } = options;
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

  isSpeechSynthesisReady() {
    return Boolean(this.openai);
  }

  async transcribeAudio({
    filePath,
    model = "gpt-4o-mini-transcribe",
    trace = { guildId: null, channelId: null, userId: null, source: null }
  }) {
    if (!this.openai) {
      throw new Error("ASR fallback requires OPENAI_API_KEY.");
    }

    const resolvedModel = String(model || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
    try {
      const filePathText = String(filePath);
      const audioBytes = await readFile(filePathText);
      const response = await this.openai.audio.transcriptions.create({
        model: resolvedModel,
        file: new File([audioBytes], basename(filePathText) || "audio.wav"),
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

  async synthesizeSpeech({
    text,
    model = "gpt-4o-mini-tts",
    voice = "alloy",
    speed = 1,
    responseFormat = "pcm",
    trace = { guildId: null, channelId: null, userId: null, source: null }
  }) {
    if (!this.openai) {
      throw new Error("Speech synthesis requires OPENAI_API_KEY.");
    }

    const resolvedText = normalizeInlineText(text, 4000);
    if (!resolvedText) {
      throw new Error("Speech synthesis requires non-empty text.");
    }

    const resolvedModel = String(model || "gpt-4o-mini-tts").trim() || "gpt-4o-mini-tts";
    const resolvedVoice = String(voice || "alloy").trim() || "alloy";
    const resolvedFormat = String(responseFormat || "pcm").trim().toLowerCase() || "pcm";
    const resolvedSpeed = clampNumber(speed, 0.25, 2, 1);

    try {
      const response = await this.openai.audio.speech.create({
        model: resolvedModel,
        voice: resolvedVoice,
        input: resolvedText,
        speed: resolvedSpeed,
        response_format: resolvedFormat
      });
      const audioBuffer = Buffer.from(await response.arrayBuffer());
      if (!audioBuffer.length) {
        throw new Error("Speech synthesis returned empty audio.");
      }

      this.store.logAction({
        kind: "tts_call",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: resolvedModel,
        metadata: {
          model: resolvedModel,
          voice: resolvedVoice,
          speed: resolvedSpeed,
          responseFormat: resolvedFormat,
          textChars: resolvedText.length,
          source: trace.source || "unknown"
        }
      });

      return {
        audioBuffer,
        model: resolvedModel,
        voice: resolvedVoice,
        speed: resolvedSpeed,
        responseFormat: resolvedFormat
      };
    } catch (error) {
      this.store.logAction({
        kind: "tts_error",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: String(error?.message || error),
        metadata: {
          model: resolvedModel,
          voice: resolvedVoice,
          speed: resolvedSpeed,
          responseFormat: resolvedFormat,
          source: trace.source || "unknown"
        }
      });
      throw error;
    }
  }

  resolveProviderAndModel(llmSettings) {
    const desiredProvider = normalizeLlmProvider(llmSettings?.provider, this.appConfig?.defaultProvider);
    const desiredModel = String(llmSettings?.model || "")
      .trim()
      .slice(0, 120);

    if (desiredProvider === "claude-code" && !this.isProviderConfigured("claude-code")) {
      throw new Error(
        "LLM provider is set to claude-code, but the `claude` CLI is not available on PATH for this process. Ensure `which claude` works in the same shell/service environment that starts the bot, then restart."
      );
    }

    const fallbackProviders = resolveProviderFallbackOrder(desiredProvider);

    for (const provider of fallbackProviders) {
      if (!this.isProviderConfigured(provider)) continue;
      let model = provider === desiredProvider && desiredModel ? desiredModel : this.resolveDefaultModel(provider);
      if (provider === "claude-code") {
        const normalizedClaudeCodeModel = normalizeClaudeCodeModel(model);
        if (!normalizedClaudeCodeModel) {
          throw new Error(
            `Invalid claude-code model '${model}'. Use one of: sonnet, opus, haiku.`
          );
        }
        model = normalizedClaudeCodeModel;
      }
      return {
        provider,
        model
      };
    }

    throw new Error("No LLM provider available. Add OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY, or install the claude CLI.");
  }

  isProviderConfigured(provider) {
    if (provider === "claude-code") return Boolean(this.claudeCodeAvailable);
    if (provider === "anthropic") return Boolean(this.anthropic);
    if (provider === "xai") return Boolean(this.xai);
    return Boolean(this.openai);
  }

  resolveDefaultModel(provider) {
    if (provider === "claude-code") {
      return normalizeDefaultModel(this.appConfig?.defaultClaudeCodeModel, "sonnet");
    }
    if (provider === "anthropic") {
      return normalizeDefaultModel(this.appConfig?.defaultAnthropicModel, "claude-haiku-4-5");
    }
    if (provider === "xai") {
      return normalizeDefaultModel(this.appConfig?.defaultXaiModel, "grok-3-mini-latest");
    }
    return normalizeDefaultModel(this.appConfig?.defaultOpenAiModel, "claude-haiku-4-5");
  }

  async callOpenAI({
    model,
    systemPrompt,
    userPrompt,
    imageInputs,
    contextMessages,
    temperature,
    maxOutputTokens,
    reasoningEffort
  }) {
    if (!this.openai) {
      throw new Error("OpenAI LLM calls require OPENAI_API_KEY.");
    }

    return this.callOpenAiResponses({
      model,
      systemPrompt,
      userPrompt,
      imageInputs,
      contextMessages,
      temperature,
      maxOutputTokens,
      reasoningEffort
    });
  }

  async callXai({
    model,
    systemPrompt,
    userPrompt,
    imageInputs,
    contextMessages,
    temperature,
    maxOutputTokens
  }) {
    if (!this.xai) {
      throw new Error("xAI LLM calls require XAI_API_KEY.");
    }

    return this.callXaiChatCompletions({
      model,
      systemPrompt,
      userPrompt,
      imageInputs,
      contextMessages,
      temperature,
      maxOutputTokens
    });
  }

  async callOpenAiResponses({
    model,
    systemPrompt,
    userPrompt,
    imageInputs,
    contextMessages,
    temperature,
    maxOutputTokens,
    reasoningEffort
  }) {
    const imageParts = imageInputs
      .map((image) => {
        const mediaType = String(image?.mediaType || image?.contentType || "").trim().toLowerCase();
        const base64 = String(image?.dataBase64 || "").trim();
        const url = String(image?.url || "").trim();
        const imageUrl = base64 && /^image\/[a-z0-9.+-]+$/i.test(mediaType) ? `data:${mediaType};base64,${base64}` : url;
        if (!imageUrl) return null;
        return {
          type: "input_image",
          image_url: imageUrl,
          detail: "auto"
        };
      })
      .filter(Boolean);
    const userContent = [
      {
        type: "input_text",
        text: userPrompt
      },
      ...imageParts
    ];

    const response = await this.openai.responses.create({
      model,
      instructions: systemPrompt,
      ...buildOpenAiTemperatureParam(model, temperature),
      ...buildOpenAiReasoningParam(model, reasoningEffort),
      max_output_tokens: maxOutputTokens,
      input: [
        ...contextMessages.map((msg) => ({
          role: msg.role === "assistant" ? "assistant" : "user",
          content: String(msg.content || "")
        })),
        {
          role: "user",
          content: userContent
        }
      ]
    });

    return {
      text: extractOpenAiResponseText(response),
      usage: extractOpenAiResponseUsage(response)
    };
  }

  async callXaiChatCompletions({
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

    const response = await this.xai.chat.completions.create({
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
        outputTokens: Number(response.usage?.completion_tokens || 0),
        cacheWriteTokens: 0,
        cacheReadTokens: 0
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
    const imageParts = buildAnthropicImageParts(imageInputs);
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

export {
  buildClaudeCodeCliArgs,
  buildClaudeCodeFallbackPrompt,
  buildClaudeCodeJsonCliArgs,
  buildClaudeCodeStreamInput,
  buildClaudeCodeSystemPrompt,
  buildClaudeCodeTextCliArgs,
  parseClaudeCodeJsonOutput,
  parseClaudeCodeStreamOutput
} from "./llmClaudeCode.ts";
