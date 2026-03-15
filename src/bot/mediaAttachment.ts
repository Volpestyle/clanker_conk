import { MAX_GIF_QUERY_LEN, normalizeDirectiveText } from "./botHelpers.ts";
import { getDiscoverySettings } from "../settings/agentStack.ts";
import type { Settings } from "../settings/settingsSchema.ts";
import type { ImageInput } from "../llm/serviceShared.ts";
import {
  getGifBudgetState,
  getImageBudgetState,
  getVideoGenerationBudgetState,
  isImageGenerationReady,
  isVideoGenerationReady,
  type GifBudgetState,
  type ImageBudgetState,
  type VideoGenerationBudgetState
} from "./budgetTracking.ts";
import type { MediaAttachmentContext } from "./botContext.ts";

type MessagePayloadFile = {
  attachment: Buffer;
  name: string;
};

type MessagePayload = {
  content: string;
  files?: MessagePayloadFile[];
};

type MediaDirectiveType =
  | "gif"
  | "image_simple"
  | "image_complex"
  | "video"
  | "tool_images";

type MediaAttachmentTrace = {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string | null;
};

type GenerateImageResult = {
  imageBuffer?: Buffer | null;
  imageUrl?: string | null;
  variant?: string | null;
};

type GenerateVideoResult = {
  videoUrl?: string | null;
};

type MaybeAttachGeneratedImageOptions = {
  settings: Settings;
  text: string;
  prompt?: string | null;
  variant?: string;
  trace?: MediaAttachmentTrace;
};

type MaybeAttachGeneratedVideoOptions = {
  settings: Settings;
  text: string;
  prompt?: string | null;
  trace?: MediaAttachmentTrace;
};

type MaybeAttachReplyGifOptions = {
  settings: Settings;
  text: string;
  query?: string | null;
  trace?: MediaAttachmentTrace;
};

type MaybeAttachGeneratedImageResult = {
  payload: MessagePayload;
  imageUsed: boolean;
  variant: string | null;
  blockedByBudget: boolean;
  blockedByCapability: boolean;
  budget: ImageBudgetState;
};

type MaybeAttachGeneratedVideoResult = {
  payload: MessagePayload;
  videoUsed: boolean;
  blockedByBudget: boolean;
  blockedByCapability: boolean;
  budget: VideoGenerationBudgetState;
};

type MaybeAttachReplyGifResult = {
  payload: MessagePayload;
  gifUsed: boolean;
  blockedByBudget: boolean;
  blockedByConfiguration: boolean;
  budget: GifBudgetState;
};

type ResolveMediaAttachmentOptions = {
  settings: Settings;
  text: string;
  directive?: {
    type?: MediaDirectiveType | null;
    gifQuery?: string | null;
    imagePrompt?: string | null;
    complexImagePrompt?: string | null;
    videoPrompt?: string | null;
  } | null;
  toolImageInputs?: ImageInput[] | null;
  trace?: MediaAttachmentTrace;
};

type ResolveMediaAttachmentResult = {
  payload: MessagePayload;
  media: { type: MediaDirectiveType } | null;
  toolImagesUsed: boolean;
  imageUsed: boolean;
  imageBudgetBlocked: boolean;
  imageCapabilityBlocked: boolean;
  imageVariantUsed: string | null;
  videoUsed: boolean;
  videoBudgetBlocked: boolean;
  videoCapabilityBlocked: boolean;
  gifUsed: boolean;
  gifBudgetBlocked: boolean;
  gifConfigBlocked: boolean;
};

const MAX_TOOL_IMAGE_ATTACHMENTS = 10;
const MEDIA_FETCH_TIMEOUT_MS = 12_000;
const MAX_MEDIA_FETCH_BYTES = 25 * 1024 * 1024; // 25 MB Discord upload limit

/**
 * Fetches an image/gif URL and returns a Buffer for Discord file attachment.
 * Returns null if the fetch fails or the response is too large — caller
 * should fall back to appending the URL to message content.
 */
async function fetchUrlAsBuffer(
  url: string
): Promise<{ buffer: Buffer; extension: string } | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
      headers: { "user-agent": "clanky/0.1 (+media-fetch)" }
    });

    if (!response.ok || !response.body) return null;

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_MEDIA_FETCH_BYTES) return null;

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_MEDIA_FETCH_BYTES) return null;

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const extension = contentType.includes("gif")
      ? "gif"
      : contentType.includes("webp")
        ? "webp"
        : contentType.includes("jpeg") || contentType.includes("jpg")
          ? "jpg"
          : contentType.includes("mp4")
            ? "mp4"
            : contentType.includes("webm")
              ? "webm"
              : "png";

    return { buffer: Buffer.from(arrayBuffer), extension };
  } catch (error) {
    console.warn("[mediaAttachment] Failed to fetch media URL as buffer:", url, error);
    return null;
  }
}

function buildBasePayload(text: string): MessagePayload {
  return {
    content: String(text || "")
  };
}

function normalizeTrace(trace: MediaAttachmentTrace | undefined) {
  return {
    guildId: trace?.guildId ?? null,
    channelId: trace?.channelId ?? null,
    userId: trace?.userId ?? null,
    source: trace?.source ?? null
  };
}

export async function buildMessagePayloadWithImage(
  text: string,
  image: GenerateImageResult
) {
  if (image.imageBuffer) {
    return {
      payload: {
        content: String(text || ""),
        files: [{ attachment: image.imageBuffer, name: `clanker-${Date.now()}.png` }]
      },
      imageUsed: true
    };
  }

  if (image.imageUrl) {
    const normalizedUrl = String(image.imageUrl || "").trim();
    const fetched = await fetchUrlAsBuffer(normalizedUrl);
    if (fetched) {
      return {
        payload: {
          content: String(text || "").trim(),
          files: [{ attachment: fetched.buffer, name: `clanker-${Date.now()}.${fetched.extension}` }]
        },
        imageUsed: true
      };
    }

    // Fallback: if fetch failed, append URL to content
    const trimmedText = String(text || "").trim();
    const content = trimmedText ? `${trimmedText}\n${normalizedUrl}` : normalizedUrl;
    return {
      payload: { content },
      imageUsed: true
    };
  }

  return {
    payload: buildBasePayload(text),
    imageUsed: false
  };
}

function buildMessagePayloadWithVideo(
  text: string,
  video: GenerateVideoResult
) {
  const videoUrl = String(video?.videoUrl || "").trim();
  if (!videoUrl) {
    return {
      payload: buildBasePayload(text),
      videoUsed: false
    };
  }

  const trimmedText = String(text || "").trim();
  const content = trimmedText ? `${trimmedText}\n${videoUrl}` : videoUrl;
  return {
    payload: { content },
    videoUsed: true
  };
}

async function buildMessagePayloadWithGif(text: string, gifUrl: string) {
  const normalizedUrl = String(gifUrl || "").trim();
  if (!normalizedUrl) {
    return {
      payload: buildBasePayload(text),
      gifUsed: false
    };
  }

  const fetched = await fetchUrlAsBuffer(normalizedUrl);
  if (fetched) {
    return {
      payload: {
        content: String(text || "").trim(),
        files: [{ attachment: fetched.buffer, name: `clanky-gif-${Date.now()}.${fetched.extension}` }]
      },
      gifUsed: true
    };
  }

  // Fallback: if fetch failed, append URL to content (Discord may auto-embed)
  const trimmedText = String(text || "").trim();
  const content = trimmedText ? `${trimmedText}\n${normalizedUrl}` : normalizedUrl;
  return {
    payload: { content },
    gifUsed: true
  };
}

function mediaTypeToExtension(mediaType: string | null | undefined) {
  const normalized = String(mediaType || "").trim().toLowerCase();
  switch (normalized) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/avif":
      return "avif";
    default:
      return "png";
  }
}

export async function buildMessagePayloadWithToolImages(
  text: string,
  imageInputs: ImageInput[] | null | undefined
) {
  const files: MessagePayloadFile[] = [];
  const unfetchedUrls: string[] = [];

  for (const imageInput of Array.isArray(imageInputs) ? imageInputs.slice(0, MAX_TOOL_IMAGE_ATTACHMENTS) : []) {
    const dataBase64 = String(imageInput?.dataBase64 || "").trim();
    if (dataBase64) {
      const extension = mediaTypeToExtension(imageInput?.mediaType || imageInput?.contentType);
      files.push({
        attachment: Buffer.from(dataBase64, "base64"),
        name: `clanky-tool-${files.length + 1}.${extension}`
      });
      continue;
    }

    const url = String(imageInput?.url || "").trim();
    if (url) {
      const fetched = await fetchUrlAsBuffer(url);
      if (fetched) {
        files.push({
          attachment: fetched.buffer,
          name: `clanky-tool-${files.length + 1}.${fetched.extension}`
        });
      } else {
        unfetchedUrls.push(url);
      }
    }
  }

  if (files.length > 0) {
    const trimmedText = String(text || "").trim();
    // Append any URLs that failed to fetch as fallback
    const content = unfetchedUrls.length > 0
      ? (trimmedText ? `${trimmedText}\n${unfetchedUrls.join("\n")}` : unfetchedUrls.join("\n"))
      : trimmedText;
    return {
      payload: {
        content,
        files
      },
      toolImagesUsed: true
    };
  }

  if (unfetchedUrls.length > 0) {
    const trimmedText = String(text || "").trim();
    const content = trimmedText ? `${trimmedText}\n${unfetchedUrls.join("\n")}` : unfetchedUrls.join("\n");
    return {
      payload: { content },
      toolImagesUsed: true
    };
  }

  return {
    payload: buildBasePayload(text),
    toolImagesUsed: false
  };
}

export async function maybeAttachGeneratedImage(
  ctx: MediaAttachmentContext,
  {
    settings,
    text,
    prompt,
    variant = "simple",
    trace
  }: MaybeAttachGeneratedImageOptions
): Promise<MaybeAttachGeneratedImageResult> {
  const payload = buildBasePayload(text);
  const normalizedVariant = variant === "complex" ? "complex" : "simple";
  const ready = isImageGenerationReady(ctx, settings, normalizedVariant);
  if (!ready) {
    return {
      payload,
      imageUsed: false,
      variant: null,
      blockedByBudget: false,
      blockedByCapability: true,
      budget: getImageBudgetState(ctx, settings)
    };
  }

  const budget = getImageBudgetState(ctx, settings);
  if (!budget.canGenerate) {
    return {
      payload,
      imageUsed: false,
      variant: null,
      blockedByBudget: true,
      blockedByCapability: false,
      budget
    };
  }

  try {
    const image = await ctx.llm.generateImage({
      settings,
      prompt,
      variant: normalizedVariant,
      trace: normalizeTrace(trace)
    });
    const withImage = await buildMessagePayloadWithImage(text, image);
    return {
      payload: withImage.payload,
      imageUsed: withImage.imageUsed,
      variant: image.variant || normalizedVariant,
      blockedByBudget: false,
      blockedByCapability: false,
      budget
    };
  } catch {
    return {
      payload,
      imageUsed: false,
      variant: null,
      blockedByBudget: false,
      blockedByCapability: false,
      budget
    };
  }
}

export async function maybeAttachGeneratedVideo(
  ctx: MediaAttachmentContext,
  {
    settings,
    text,
    prompt,
    trace
  }: MaybeAttachGeneratedVideoOptions
): Promise<MaybeAttachGeneratedVideoResult> {
  const payload = buildBasePayload(text);
  const ready = isVideoGenerationReady(ctx, settings);
  if (!ready) {
    return {
      payload,
      videoUsed: false,
      blockedByBudget: false,
      blockedByCapability: true,
      budget: getVideoGenerationBudgetState(ctx, settings)
    };
  }

  const budget = getVideoGenerationBudgetState(ctx, settings);
  if (!budget.canGenerate) {
    return {
      payload,
      videoUsed: false,
      blockedByBudget: true,
      blockedByCapability: false,
      budget
    };
  }

  try {
    const video = await ctx.llm.generateVideo({
      settings,
      prompt,
      trace: normalizeTrace(trace)
    });
    const withVideo = buildMessagePayloadWithVideo(text, video);
    return {
      payload: withVideo.payload,
      videoUsed: withVideo.videoUsed,
      blockedByBudget: false,
      blockedByCapability: false,
      budget
    };
  } catch {
    return {
      payload,
      videoUsed: false,
      blockedByBudget: false,
      blockedByCapability: false,
      budget
    };
  }
}

export async function maybeAttachReplyGif(
  ctx: MediaAttachmentContext,
  {
    settings,
    text,
    query,
    trace
  }: MaybeAttachReplyGifOptions
): Promise<MaybeAttachReplyGifResult> {
  const payload = buildBasePayload(text);
  const budget = getGifBudgetState(ctx, settings);
  const normalizedQuery = normalizeDirectiveText(query, MAX_GIF_QUERY_LEN);
  const discovery = getDiscoverySettings(settings);

  if (!discovery.allowReplyGifs) {
    return {
      payload,
      gifUsed: false,
      blockedByBudget: false,
      blockedByConfiguration: true,
      budget
    };
  }

  if (!normalizedQuery) {
    return {
      payload,
      gifUsed: false,
      blockedByBudget: false,
      blockedByConfiguration: false,
      budget
    };
  }

  if (!ctx.gifs?.isConfigured?.()) {
    return {
      payload,
      gifUsed: false,
      blockedByBudget: false,
      blockedByConfiguration: true,
      budget
    };
  }

  if (!budget.canFetch) {
    return {
      payload,
      gifUsed: false,
      blockedByBudget: true,
      blockedByConfiguration: false,
      budget
    };
  }

  try {
    const gif = await ctx.gifs.pickGif({
      query: normalizedQuery,
      trace
    });
    if (!gif?.url) {
      return {
        payload,
        gifUsed: false,
        blockedByBudget: false,
        blockedByConfiguration: false,
        budget
      };
    }

    const withGif = await buildMessagePayloadWithGif(text, gif.url);
    return {
      payload: withGif.payload,
      gifUsed: withGif.gifUsed,
      blockedByBudget: false,
      blockedByConfiguration: false,
      budget
    };
  } catch {
    return {
      payload,
      gifUsed: false,
      blockedByBudget: false,
      blockedByConfiguration: false,
      budget
    };
  }
}

export async function resolveMediaAttachment(
  ctx: MediaAttachmentContext,
  {
    settings,
    text,
    directive = null,
    toolImageInputs = null,
    trace
  }: ResolveMediaAttachmentOptions
): Promise<ResolveMediaAttachmentResult> {
  const base: ResolveMediaAttachmentResult = {
    payload: buildBasePayload(text),
    media: null,
    toolImagesUsed: false,
    imageUsed: false,
    imageBudgetBlocked: false,
    imageCapabilityBlocked: false,
    imageVariantUsed: null,
    videoUsed: false,
    videoBudgetBlocked: false,
    videoCapabilityBlocked: false,
    gifUsed: false,
    gifBudgetBlocked: false,
    gifConfigBlocked: false
  };

  if (directive?.type === "tool_images") {
    const toolImageResult = await buildMessagePayloadWithToolImages(text, toolImageInputs);
    return {
      ...base,
      payload: toolImageResult.payload,
      media: toolImageResult.toolImagesUsed ? { type: "tool_images" } : null,
      toolImagesUsed: toolImageResult.toolImagesUsed
    };
  }

  if (directive?.type === "gif" && directive.gifQuery) {
    const gifResult = await maybeAttachReplyGif(ctx, {
      settings,
      text,
      query: directive.gifQuery,
      trace
    });
    return {
      ...base,
      payload: gifResult.payload,
      media: gifResult.gifUsed ? { type: "gif" } : null,
      gifUsed: gifResult.gifUsed,
      gifBudgetBlocked: gifResult.blockedByBudget,
      gifConfigBlocked: gifResult.blockedByConfiguration
    };
  }

  if (directive?.type === "image_simple" && directive.imagePrompt) {
    const imageResult = await maybeAttachGeneratedImage(ctx, {
      settings,
      text,
      prompt: directive.imagePrompt,
      variant: "simple",
      trace
    });
    return {
      ...base,
      payload: imageResult.payload,
      media: imageResult.imageUsed ? { type: "image_simple" } : null,
      imageUsed: imageResult.imageUsed,
      imageBudgetBlocked: imageResult.blockedByBudget,
      imageCapabilityBlocked: imageResult.blockedByCapability,
      imageVariantUsed: imageResult.variant || "simple"
    };
  }

  if (directive?.type === "image_complex" && directive.complexImagePrompt) {
    const imageResult = await maybeAttachGeneratedImage(ctx, {
      settings,
      text,
      prompt: directive.complexImagePrompt,
      variant: "complex",
      trace
    });
    return {
      ...base,
      payload: imageResult.payload,
      media: imageResult.imageUsed ? { type: "image_complex" } : null,
      imageUsed: imageResult.imageUsed,
      imageBudgetBlocked: imageResult.blockedByBudget,
      imageCapabilityBlocked: imageResult.blockedByCapability,
      imageVariantUsed: imageResult.variant || "complex"
    };
  }

  if (directive?.type === "video" && directive.videoPrompt) {
    const videoResult = await maybeAttachGeneratedVideo(ctx, {
      settings,
      text,
      prompt: directive.videoPrompt,
      trace
    });
    return {
      ...base,
      payload: videoResult.payload,
      media: videoResult.videoUsed ? { type: "video" } : null,
      videoUsed: videoResult.videoUsed,
      videoBudgetBlocked: videoResult.blockedByBudget,
      videoCapabilityBlocked: videoResult.blockedByCapability
    };
  }

  return base;
}
