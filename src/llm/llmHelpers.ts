export const CLAUDE_CODE_MODELS = new Set(["sonnet", "opus", "haiku"]);
export const MEMORY_FACT_TYPES = ["preference", "profile", "relationship", "project", "other"];
export const MEMORY_FACT_SUBJECTS = ["author", "bot", "lore"];
const XAI_DEFAULT_BASE_URL = "https://api.x.ai/v1";
export const XAI_VIDEO_DONE_STATUSES = new Set(["done", "completed", "succeeded", "success", "ready"]);

export function extractOpenAiResponseText(response) {
  const direct = String(response?.output_text || "").trim();
  if (direct) return direct;

  const output = Array.isArray(response?.output) ? response.output : [];
  const textParts = [];

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    if (item.type !== "message") continue;
    const contentParts = Array.isArray(item.content) ? item.content : [];
    for (const part of contentParts) {
      if (!part || typeof part !== "object") continue;
      if (part.type !== "output_text") continue;
      const text = String(part.text || "").trim();
      if (text) textParts.push(text);
    }
  }

  return textParts.join("\n").trim();
}

export function extractOpenAiResponseUsage(response) {
  const usage = response?.usage && typeof response.usage === "object" ? response.usage : null;
  return {
    inputTokens: Number(usage?.input_tokens || 0),
    outputTokens: Number(usage?.output_tokens || 0),
    cacheWriteTokens: 0,
    cacheReadTokens: Number(usage?.input_tokens_details?.cached_tokens || 0)
  };
}

export function extractOpenAiImageBase64(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    if (item.type !== "image_generation_call") continue;
    const result = String(item.result || "").trim();
    if (result) return result;
  }
  return "";
}

export function normalizeOpenAiImageGenerationSize(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "1024x1024") return "1024x1024";
  if (normalized === "1024x1536") return "1024x1536";
  if (normalized === "1536x1024") return "1536x1024";
  return "auto";
}

export function normalizeInlineText(value, maxLen) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

export function clamp01(value, fallback = 0.5) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

export function clampInt(value, min, max) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return min;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

export function clampNumber(value, min, max, fallback = min) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

export function normalizeFactType(type) {
  const normalized = String(type || "")
    .trim()
    .toLowerCase();
  return MEMORY_FACT_TYPES.includes(normalized) ? normalized : "other";
}

export function parseMemoryExtractionJson(rawText) {
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

export function normalizeExtractedFacts(parsed, maxFacts) {
  const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];
  const normalized = [];

  for (const item of facts) {
    if (!item || typeof item !== "object") continue;

    const subject = String(item.subject || "")
      .trim()
      .toLowerCase();
    const fact = normalizeInlineText(item.fact, 190);
    const evidence = normalizeInlineText(item.evidence, 220);
    if (!MEMORY_FACT_SUBJECTS.includes(subject) || !fact || !evidence) continue;

    normalized.push({
      subject,
      fact,
      type: normalizeFactType(item.type),
      confidence: clamp01(item.confidence, 0.5),
      evidence
    });
    if (normalized.length >= maxFacts) break;
  }

  return normalized;
}

export function normalizeXaiBaseUrl(value) {
  const raw = String(value || XAI_DEFAULT_BASE_URL).trim();
  const normalized = raw || XAI_DEFAULT_BASE_URL;
  return normalized.replace(/\/+$/, "");
}

export function normalizeModelAllowlist(input, maxItems = 20) {
  if (!Array.isArray(input)) return [];

  return [...new Set(input.map((item) => String(item || "").trim()).filter(Boolean))]
    .slice(0, Math.max(1, maxItems))
    .map((item) => item.slice(0, 120));
}

export function prioritizePreferredModel(allowedModels, preferredModel) {
  const preferred = String(preferredModel || "").trim();
  if (!preferred || !allowedModels.includes(preferred)) return allowedModels;
  return [preferred, ...allowedModels.filter((entry) => entry !== preferred)];
}

export function normalizeLlmProvider(value, fallback = "openai") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "anthropic") return "anthropic";
  if (normalized === "xai") return "xai";
  if (normalized === "claude-code") return "claude-code";

  const fallbackProvider = String(fallback || "")
    .trim()
    .toLowerCase();
  if (fallbackProvider === "anthropic") return "anthropic";
  if (fallbackProvider === "xai") return "xai";
  if (fallbackProvider === "claude-code") return "claude-code";
  return "openai";
}

export function defaultModelForLlmProvider(provider) {
  if (provider === "anthropic") return "claude-haiku-4-5";
  if (provider === "xai") return "grok-3-mini-latest";
  if (provider === "claude-code") return "sonnet";
  return "gpt-4.1-mini";
}

export function resolveProviderFallbackOrder(provider) {
  if (provider === "claude-code") return ["claude-code", "anthropic", "openai", "xai"];
  if (provider === "anthropic") return ["anthropic", "openai", "xai", "claude-code"];
  if (provider === "xai") return ["xai", "openai", "anthropic", "claude-code"];
  return ["openai", "anthropic", "xai", "claude-code"];
}

export function normalizeDefaultModel(value, fallback) {
  const normalized = String(value || "").trim();
  if (normalized) return normalized.slice(0, 120);
  return String(fallback || "").trim().slice(0, 120);
}

export function normalizeClaudeCodeModel(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return "";
  return CLAUDE_CODE_MODELS.has(normalized) ? normalized : "";
}

export function inferProviderFromModel(model) {
  const normalized = String(model || "").trim().toLowerCase();
  if (!normalized) return "openai";
  if (normalized.startsWith("xai/")) return "xai";
  if (normalized.includes("grok")) return "xai";
  return "openai";
}

export function isXaiVideoDone(status, payload) {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (XAI_VIDEO_DONE_STATUSES.has(normalizedStatus)) return true;
  return Boolean(extractXaiVideoUrl(payload));
}

export function extractXaiVideoUrl(payload) {
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
