import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { estimateImageUsdCost, estimateUsdCost } from "./pricing.js";

export class LLMService {
  constructor({ appConfig, store }) {
    this.appConfig = appConfig;
    this.store = store;

    this.openai = appConfig.openaiApiKey ? new OpenAI({ apiKey: appConfig.openaiApiKey }) : null;
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

  async generateImage({ settings, prompt, trace = {} }) {
    if (!this.openai) {
      throw new Error("Image generation requires OPENAI_API_KEY.");
    }

    const model = String(settings?.initiative?.imageModel || "gpt-image-1.5").trim() || "gpt-image-1.5";
    const size = "1024x1024";

    try {
      const response = await this.openai.images.generate({
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
        provider: "openai",
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
        content: `${model}`,
        metadata: {
          model,
          size,
          source: trace.source || "unknown"
        },
        usdCost: costUsd
      });

      return {
        provider: "openai",
        model,
        size,
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
          model,
          source: trace.source || "unknown"
        }
      });
      throw error;
    }
  }

  isImageGenerationReady(settings) {
    if (!this.openai) return false;
    const model = String(settings?.initiative?.imageModel || "").trim();
    return Boolean(model);
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
    const userContent = imageInputs.length
      ? [
          { type: "text", text: userPrompt },
          ...imageInputs.map((image) => ({
            type: "image_url",
            image_url: {
              url: image.url,
              detail: "auto"
            }
          }))
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
    const userContent = imageInputs.length
      ? [
          { type: "text", text: userPrompt },
          ...imageInputs.map((image) => ({
            type: "image",
            source: {
              type: "url",
              url: image.url
            }
          }))
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
