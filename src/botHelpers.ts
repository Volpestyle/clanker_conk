import { clamp } from "./utils.ts";

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>()]+/gi;
const IMAGE_PROMPT_DIRECTIVE_RE = /\[\[IMAGE_PROMPT:\s*([\s\S]*?)\s*\]\]\s*$/i;
const COMPLEX_IMAGE_PROMPT_DIRECTIVE_RE = /\[\[COMPLEX_IMAGE_PROMPT:\s*([\s\S]*?)\s*\]\]\s*$/i;
const VIDEO_PROMPT_DIRECTIVE_RE = /\[\[VIDEO_PROMPT:\s*([\s\S]*?)\s*\]\]\s*$/i;
const GIF_QUERY_DIRECTIVE_RE = /\[\[GIF_QUERY:\s*([\s\S]*?)\s*\]\]\s*$/i;
const REACTION_DIRECTIVE_RE = /\[\[REACTION:\s*([\s\S]*?)\s*\]\]\s*$/i;
const WEB_SEARCH_DIRECTIVE_RE = /\[\[WEB_SEARCH:\s*([\s\S]*?)\s*\]\]\s*$/i;
const MEMORY_LINE_DIRECTIVE_RE = /\[\[MEMORY_LINE:\s*([\s\S]*?)\s*\]\]\s*$/i;
const WEB_SEARCH_OPTOUT_RE = /\b(?:do\s*not|don't|dont|no)\b[\w\s,]{0,24}\b(?:google|search|look\s*up)\b/i;
const MAX_MEDIA_PROMPT_LEN = 240;
export const MAX_WEB_QUERY_LEN = 220;
export const MAX_GIF_QUERY_LEN = 120;
const MAX_MEMORY_LINE_LEN = 180;
const MAX_MEMORY_LOOKUP_QUERY_LEN = 220;
const MAX_REPLY_TEXT_LEN = 1200;
const REPLY_MEDIA_TYPES = new Set(["image_simple", "image_complex", "video", "gif"]);
const REPLY_VOICE_INTENT_TYPES = new Set(["join", "leave", "status", "none"]);
const MAX_VOICE_INTENT_REASON_LEN = 180;
export const MAX_VIDEO_TARGET_SCAN = 8;
export const MAX_VIDEO_FALLBACK_MESSAGES = 18;
const MENTION_CANDIDATE_RE = /(?<![\w<])@([a-z0-9][a-z0-9 ._'-]{0,63})/gi;
export const MAX_MENTION_CANDIDATES = 8;
const MAX_MENTION_LOOKUP_VARIANTS = 8;

export function formatReactionSummary(message) {
  const cache = message?.reactions?.cache;
  if (!cache?.size) return "";

  const rows = [];
  for (const reaction of cache.values()) {
    const count = Number(reaction?.count || 0);
    if (!Number.isFinite(count) || count <= 0) continue;
    const label = normalizeReactionLabel(reaction?.emoji);
    if (!label) continue;
    rows.push({ label, count });
  }

  if (!rows.length) return "";

  rows.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.label.localeCompare(b.label);
  });

  return rows
    .slice(0, 6)
    .map((row) => `${row.label}x${row.count}`)
    .join(", ");
}

function normalizeReactionLabel(emoji) {
  const id = String(emoji?.id || "").trim();
  const rawName = String(emoji?.name || "").trim();
  if (id) {
    const safe = sanitizeReactionLabel(rawName);
    return safe ? `custom:${safe}` : `custom:${id}`;
  }
  if (!rawName) return "";

  const safe = sanitizeReactionLabel(rawName);
  if (safe) return safe;

  const codepoints = [...rawName]
    .map((char) => char.codePointAt(0))
    .filter((value) => Number.isFinite(value))
    .map((value) => value.toString(16));
  if (!codepoints.length) return "";
  return `u${codepoints.join("_")}`;
}

function sanitizeReactionLabel(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_+-]+/g, "")
    .slice(0, 32);
}

function extractUrlsFromText(text) {
  URL_IN_TEXT_RE.lastIndex = 0;
  return [...String(text || "").matchAll(URL_IN_TEXT_RE)].map((match) => String(match[0] || ""));
}

export function emptyMentionResolution() {
  return {
    attemptedCount: 0,
    resolvedCount: 0,
    ambiguousCount: 0,
    unresolvedCount: 0
  };
}

export function extractMentionCandidates(text, maxItems = MAX_MENTION_CANDIDATES) {
  const source = String(text || "");
  if (!source.includes("@")) return [];

  const out = [];
  MENTION_CANDIDATE_RE.lastIndex = 0;
  let match;
  while ((match = MENTION_CANDIDATE_RE.exec(source)) && out.length < Math.max(1, Number(maxItems) || 1)) {
    const rawCandidate = String(match[1] || "");
    const withoutTrailingSpace = rawCandidate.replace(/\s+$/g, "");
    const withoutTrailingPunctuation = withoutTrailingSpace
      .replace(/[.,:;!?)\]}]+$/g, "")
      .replace(/\s+$/g, "");
    const start = match.index;
    const variants = buildMentionLookupVariants({
      mentionText: withoutTrailingPunctuation,
      mentionStart: start
    });
    if (!variants.length) continue;
    const end = variants[0].end;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start + 1) continue;

    out.push({
      start,
      end,
      variants
    });
  }

  return out;
}

function buildMentionLookupVariants({ mentionText, mentionStart }) {
  const source = String(mentionText || "").trim();
  if (!source) return [];

  const wordRe = /[a-z0-9][a-z0-9._'-]*/gi;
  const tokens = [];
  let token;
  while ((token = wordRe.exec(source))) {
    tokens.push({
      end: token.index + String(token[0] || "").length
    });
  }
  if (!tokens.length) return [];

  const variants = [];
  const seen = new Set();
  const maxTokens = Math.min(tokens.length, MAX_MENTION_LOOKUP_VARIANTS);
  for (let count = maxTokens; count >= 1; count -= 1) {
    const tokenEnd = tokens[count - 1]?.end;
    if (!Number.isFinite(tokenEnd) || tokenEnd <= 0) continue;
    const prefix = source.slice(0, tokenEnd).replace(/\s+$/g, "");
    if (!prefix) continue;
    if (/^\d{2,}$/.test(prefix)) continue;
    const lookupKey = normalizeMentionLookupKey(prefix);
    if (!lookupKey || lookupKey === "everyone" || lookupKey === "here") continue;
    if (seen.has(lookupKey)) continue;
    seen.add(lookupKey);
    variants.push({
      lookupKey,
      end: mentionStart + 1 + prefix.length
    });
  }

  return variants;
}

function normalizeMentionLookupKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export function collectMemberLookupKeys(member) {
  const keys = new Set();
  const values = [
    member?.displayName,
    member?.nickname,
    member?.user?.globalName,
    member?.user?.username
  ];

  for (const value of values) {
    const normalized = normalizeMentionLookupKey(value);
    if (!normalized) continue;
    keys.add(normalized);
  }

  return keys;
}

export function looksLikeVideoFollowupMessage(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return false;
  if (extractUrlsFromText(text).length) return false;

  const hasVideoTopic = /\b(?:video|clip|youtube|yt|tiktok|tt|reel|short)\b/i.test(text);
  if (!hasVideoTopic) return false;

  return /\b(?:watch|watched|watching|see|seen|view|check|open|play)\b/i.test(text);
}

export function extractRecentVideoTargets({
  videoService,
  recentMessages,
  maxMessages = MAX_VIDEO_FALLBACK_MESSAGES,
  maxTargets = MAX_VIDEO_TARGET_SCAN
}) {
  if (!videoService || !Array.isArray(recentMessages) || !recentMessages.length) return [];

  const normalizedMaxMessages = clamp(Number(maxMessages) || MAX_VIDEO_FALLBACK_MESSAGES, 1, 120);
  const normalizedMaxTargets = clamp(Number(maxTargets) || MAX_VIDEO_TARGET_SCAN, 1, 8);
  const targets = [];
  const seenKeys = new Set();

  for (const row of recentMessages.slice(0, normalizedMaxMessages)) {
    if (targets.length >= normalizedMaxTargets) break;
    if (Number(row?.is_bot || 0) === 1) continue;

    const content = String(row?.content || "");
    if (!content) continue;

    const rowTargets = videoService.extractVideoTargets(content, normalizedMaxTargets);
    for (const target of rowTargets) {
      if (targets.length >= normalizedMaxTargets) break;
      const key = String(target?.key || "").trim();
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      targets.push(target);
    }
  }

  return targets;
}

export function composeInitiativeImagePrompt(imagePrompt, postText) {
  URL_IN_TEXT_RE.lastIndex = 0;
  const topic = String(postText || "")
    .replace(URL_IN_TEXT_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
  const requested = normalizeDirectiveText(imagePrompt, MAX_MEDIA_PROMPT_LEN);

  return [
    "Create a visually striking, meme-friendly image for a Discord post. Strong subject, punchy composition, expressive mood.",
    `Creative direction: ${requested || "a timely playful internet moment"}.`,
    `Topic context for visual inspiration only: ${topic || "general chat mood"}.`,
    "Hard constraints:",
    "- Do not include any visible text, letters, numbers, logos, subtitles, captions, UI, or watermarks.",
    "- Do not render any words from the creative direction or topic context as text inside the image.",
    "- Make it purely visual with strong composition, expressive lighting, and high clarity."
  ].join("\n");
}

export function composeInitiativeVideoPrompt(videoPrompt, postText) {
  URL_IN_TEXT_RE.lastIndex = 0;
  const topic = String(postText || "")
    .replace(URL_IN_TEXT_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
  const requested = normalizeDirectiveText(videoPrompt, MAX_MEDIA_PROMPT_LEN);

  return [
    "Create a short, dynamic video clip optimized for social sharing. Clear motion, expressive energy, tight framing.",
    `Creative direction: ${requested || "a timely playful internet moment"}.`,
    `Topic context for visual inspiration only: ${topic || "general chat mood"}.`,
    "Hard constraints:",
    "- Do not include visible text, captions, subtitles, logos, watermarks, or UI overlays.",
    "- Keep motion purposeful, smooth, and visually readable in a short social clip format."
  ].join("\n");
}

export function composeReplyImagePrompt(imagePrompt, replyText, variant = "simple") {
  URL_IN_TEXT_RE.lastIndex = 0;
  const context = String(replyText || "")
    .replace(URL_IN_TEXT_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
  const requested = normalizeDirectiveText(imagePrompt, MAX_MEDIA_PROMPT_LEN);
  const styleHint = variant === "complex"
    ? "Create a detailed, high-quality image with rich scene composition, dramatic lighting, and cinematic depth."
    : "Create a punchy, visually clear image with a strong subject, expressive mood, and bold composition.";

  return [
    styleHint,
    `Creative direction: ${requested || "a fun, expressive visual moment"}.`,
    context ? `Conversation context (visual inspiration only): ${context}.` : null,
    "Hard constraints:",
    "- Do not include any visible text, letters, numbers, logos, subtitles, captions, UI, or watermarks.",
    "- Do not render any words from the creative direction as text inside the image.",
    "- Focus on a clear, expressive visual with strong composition and high clarity."
  ].filter(Boolean).join("\n");
}

export function composeReplyVideoPrompt(videoPrompt, replyText) {
  URL_IN_TEXT_RE.lastIndex = 0;
  const context = String(replyText || "")
    .replace(URL_IN_TEXT_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
  const requested = normalizeDirectiveText(videoPrompt, MAX_MEDIA_PROMPT_LEN);

  return [
    "Create a short, dynamic video clip with clear motion, expressive energy, and tight framing.",
    `Creative direction: ${requested || "a lively, visually engaging moment"}.`,
    context ? `Conversation context (visual inspiration only): ${context}.` : null,
    "Hard constraints:",
    "- Do not include visible text, captions, subtitles, logos, watermarks, or UI overlays.",
    "- Keep motion purposeful and visually readable in a short social clip format."
  ].filter(Boolean).join("\n");
}

export function parseInitiativeMediaDirective(rawText) {
  const parsed = {
    text: String(rawText || "").trim(),
    imagePrompt: null,
    complexImagePrompt: null,
    videoPrompt: null,
    mediaDirective: null
  };

  while (parsed.text) {
    const complexImageMatch = parsed.text.match(COMPLEX_IMAGE_PROMPT_DIRECTIVE_RE);
    if (complexImageMatch) {
      const prompt = normalizeDirectiveText(complexImageMatch[1], MAX_MEDIA_PROMPT_LEN) || null;
      if (!parsed.complexImagePrompt) {
        parsed.complexImagePrompt = prompt;
      }
      if (!parsed.mediaDirective && prompt) {
        parsed.mediaDirective = { type: "image_complex", prompt };
      }
      parsed.text = parsed.text.slice(0, complexImageMatch.index).trim();
      continue;
    }

    const imageMatch = parsed.text.match(IMAGE_PROMPT_DIRECTIVE_RE);
    if (imageMatch) {
      const prompt = normalizeDirectiveText(imageMatch[1], MAX_MEDIA_PROMPT_LEN) || null;
      if (!parsed.imagePrompt) {
        parsed.imagePrompt = prompt;
      }
      if (!parsed.mediaDirective && prompt) {
        parsed.mediaDirective = { type: "image_simple", prompt };
      }
      parsed.text = parsed.text.slice(0, imageMatch.index).trim();
      continue;
    }

    const videoMatch = parsed.text.match(VIDEO_PROMPT_DIRECTIVE_RE);
    if (videoMatch) {
      const prompt = normalizeDirectiveText(videoMatch[1], MAX_MEDIA_PROMPT_LEN) || null;
      if (!parsed.videoPrompt) {
        parsed.videoPrompt = prompt;
      }
      if (!parsed.mediaDirective && prompt) {
        parsed.mediaDirective = { type: "video", prompt };
      }
      parsed.text = parsed.text.slice(0, videoMatch.index).trim();
      continue;
    }

    break;
  }

  return parsed;
}

export function parseReplyDirectives(rawText) {
  const parsed = {
    text: String(rawText || "").trim(),
    imagePrompt: null,
    complexImagePrompt: null,
    videoPrompt: null,
    gifQuery: null,
    mediaDirective: null,
    reactionEmoji: null,
    webSearchQuery: null,
    memoryLine: null
  };

  while (parsed.text) {
    const complexImageMatch = parsed.text.match(COMPLEX_IMAGE_PROMPT_DIRECTIVE_RE);
    if (complexImageMatch) {
      const prompt = normalizeDirectiveText(complexImageMatch[1], MAX_MEDIA_PROMPT_LEN) || null;
      if (!parsed.complexImagePrompt) {
        parsed.complexImagePrompt = prompt;
      }
      if (!parsed.mediaDirective && prompt) {
        parsed.mediaDirective = { type: "image_complex", prompt };
      }
      parsed.text = parsed.text.slice(0, complexImageMatch.index).trim();
      continue;
    }

    const imageMatch = parsed.text.match(IMAGE_PROMPT_DIRECTIVE_RE);
    if (imageMatch) {
      const prompt = normalizeDirectiveText(imageMatch[1], MAX_MEDIA_PROMPT_LEN) || null;
      if (!parsed.imagePrompt) {
        parsed.imagePrompt = prompt;
      }
      if (!parsed.mediaDirective && prompt) {
        parsed.mediaDirective = { type: "image_simple", prompt };
      }
      parsed.text = parsed.text.slice(0, imageMatch.index).trim();
      continue;
    }

    const videoMatch = parsed.text.match(VIDEO_PROMPT_DIRECTIVE_RE);
    if (videoMatch) {
      const prompt = normalizeDirectiveText(videoMatch[1], MAX_MEDIA_PROMPT_LEN) || null;
      if (!parsed.videoPrompt) {
        parsed.videoPrompt = prompt;
      }
      if (!parsed.mediaDirective && prompt) {
        parsed.mediaDirective = { type: "video", prompt };
      }
      parsed.text = parsed.text.slice(0, videoMatch.index).trim();
      continue;
    }

    const gifMatch = parsed.text.match(GIF_QUERY_DIRECTIVE_RE);
    if (gifMatch) {
      const query = normalizeDirectiveText(gifMatch[1], MAX_GIF_QUERY_LEN) || null;
      if (!parsed.gifQuery) {
        parsed.gifQuery = query;
      }
      if (!parsed.mediaDirective && query) {
        parsed.mediaDirective = { type: "gif", prompt: query };
      }
      parsed.text = parsed.text.slice(0, gifMatch.index).trim();
      continue;
    }

    const reactionMatch = parsed.text.match(REACTION_DIRECTIVE_RE);
    if (reactionMatch) {
      if (!parsed.reactionEmoji) {
        parsed.reactionEmoji = normalizeDirectiveText(reactionMatch[1], 64) || null;
      }
      parsed.text = parsed.text.slice(0, reactionMatch.index).trim();
      continue;
    }

    const webSearchMatch = parsed.text.match(WEB_SEARCH_DIRECTIVE_RE);
    if (webSearchMatch) {
      if (!parsed.webSearchQuery) {
        parsed.webSearchQuery = normalizeDirectiveText(webSearchMatch[1], MAX_WEB_QUERY_LEN) || null;
      }
      parsed.text = parsed.text.slice(0, webSearchMatch.index).trim();
      continue;
    }

    const memoryMatch = parsed.text.match(MEMORY_LINE_DIRECTIVE_RE);
    if (memoryMatch) {
      if (!parsed.memoryLine) {
        parsed.memoryLine = normalizeDirectiveText(memoryMatch[1], MAX_MEMORY_LINE_LEN) || null;
      }
      parsed.text = parsed.text.slice(0, memoryMatch.index).trim();
      continue;
    }

    break;
  }

  return parsed;
}

export function parseStructuredReplyOutput(rawText) {
  const fallbackText = String(rawText || "").trim();
  const parsed = parseJsonObjectFromText(fallbackText);
  if (!parsed) {
    return {
      text: fallbackText,
      imagePrompt: null,
      complexImagePrompt: null,
      videoPrompt: null,
      gifQuery: null,
      mediaDirective: null,
      reactionEmoji: null,
      webSearchQuery: null,
      memoryLookupQuery: null,
      memoryLine: null,
      voiceIntent: {
        intent: null,
        confidence: 0,
        reason: null
      }
    };
  }

  const baseText = normalizeDirectiveText(parsed?.text, MAX_REPLY_TEXT_LEN);
  const skip = parsed?.skip === true;
  const text = skip ? "[SKIP]" : baseText;
  const reactionEmoji = normalizeDirectiveText(parsed?.reactionEmoji, 64) || null;
  const webSearchQuery = normalizeDirectiveText(parsed?.webSearchQuery, MAX_WEB_QUERY_LEN) || null;
  const memoryLookupQuery =
    normalizeDirectiveText(parsed?.memoryLookupQuery, MAX_MEMORY_LOOKUP_QUERY_LEN) || null;
  const memoryLine = normalizeDirectiveText(parsed?.memoryLine, MAX_MEMORY_LINE_LEN) || null;
  const mediaDirective = normalizeStructuredMediaDirective(parsed?.media);
  const voiceIntent = normalizeStructuredVoiceIntent(parsed?.voiceIntent);

  return {
    text: text || "",
    imagePrompt: mediaDirective?.type === "image_simple" ? mediaDirective.prompt : null,
    complexImagePrompt: mediaDirective?.type === "image_complex" ? mediaDirective.prompt : null,
    videoPrompt: mediaDirective?.type === "video" ? mediaDirective.prompt : null,
    gifQuery: mediaDirective?.type === "gif" ? mediaDirective.prompt : null,
    mediaDirective,
    reactionEmoji,
    webSearchQuery,
    memoryLookupQuery,
    memoryLine,
    voiceIntent
  };
}

function normalizeStructuredMediaDirective(rawMedia) {
  if (!rawMedia || typeof rawMedia !== "object") return null;
  const rawType = String(rawMedia.type || "")
    .trim()
    .toLowerCase();
  if (!rawType || rawType === "none") return null;
  if (!REPLY_MEDIA_TYPES.has(rawType)) return null;
  const prompt = normalizeDirectiveText(rawMedia.prompt, rawType === "gif" ? MAX_GIF_QUERY_LEN : MAX_MEDIA_PROMPT_LEN);
  if (!prompt) return null;
  return {
    type: rawType,
    prompt
  };
}

function normalizeStructuredVoiceIntent(rawIntent) {
  if (!rawIntent || typeof rawIntent !== "object") {
    return {
      intent: null,
      confidence: 0,
      reason: null
    };
  }

  const intentLabel = String(rawIntent.intent || "")
    .trim()
    .toLowerCase();
  if (!REPLY_VOICE_INTENT_TYPES.has(intentLabel)) {
    return {
      intent: null,
      confidence: 0,
      reason: null
    };
  }

  const confidenceRaw = Number(rawIntent.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? clamp(confidenceRaw, 0, 1) : 0;
  const reason = normalizeDirectiveText(rawIntent.reason, MAX_VOICE_INTENT_REASON_LEN) || null;

  return {
    intent: intentLabel === "none" ? null : intentLabel,
    confidence,
    reason
  };
}

function parseJsonObjectFromText(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) return null;

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
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // try next candidate
    }
  }

  return null;
}

export function pickReplyMediaDirective(parsed) {
  return parsed?.mediaDirective || null;
}

export function pickInitiativeMediaDirective(parsed) {
  return parsed?.mediaDirective || null;
}

export function normalizeDirectiveText(text, maxLen) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

export function serializeForPrompt(value, maxLen = 1200) {
  try {
    return String(JSON.stringify(value ?? {}, null, 2)).slice(0, Math.max(40, Number(maxLen) || 1200));
  } catch {
    return "{}";
  }
}

export function isWebSearchOptOutText(rawText) {
  return WEB_SEARCH_OPTOUT_RE.test(String(rawText || ""));
}

export function normalizeReactionEmojiToken(emojiToken) {
  const token = String(emojiToken || "").trim();
  const custom = token.match(/^<a?:([^:>]+):(\d+)>$/);
  if (custom) {
    return `${custom[1]}:${custom[2]}`;
  }
  return token;
}

export function embedWebSearchSources(text, webSearch) {
  const base = String(text || "").trim();
  if (!base) return "";
  if (!webSearch?.used) return base;

  const results = Array.isArray(webSearch?.results) ? webSearch.results : [];
  if (!results.length) return base;

  const textWithPlainCitations = base.replace(/\[(\d{1,2})\]\(\s*<?https?:\/\/[^)\s>]+[^)]*\)/g, "[$1]");
  const citedIndices = [...new Set(
    [...textWithPlainCitations.matchAll(/\[(\d{1,2})\]/g)]
      .map((match) => Number(match[1]) - 1)
      .filter((index) => Number.isInteger(index) && index >= 0 && index < results.length)
  )].sort((a, b) => a - b);

  if (!citedIndices.length) return textWithPlainCitations;

  const urlLines = [];
  const domainLines = [];
  for (const index of citedIndices) {
    const row = results[index];
    const url = String(row?.url || "").trim();
    if (!url) continue;
    const domain = String(row?.domain || extractDomainForSourceLabel(url) || "source");
    urlLines.push(`[${index + 1}] ${domain} - <${url}>`);
    domainLines.push(`[${index + 1}] ${domain}`);
  }
  if (!urlLines.length) return textWithPlainCitations;

  const inlineLinked = textWithPlainCitations.replace(/\[(\d{1,2})\]/g, (full, rawIndex) => {
    const index = Number(rawIndex) - 1;
    const row = results[index];
    const url = String(row?.url || "").trim();
    if (!url) return full;
    return `[${index + 1}](<${url}>)`;
  });

  const MAX_CONTENT_LEN = 1900;
  const withUrls = `${inlineLinked}\n\nSources:\n${urlLines.join("\n")}`;
  if (withUrls.length <= MAX_CONTENT_LEN) return withUrls;

  const withDomains = `${inlineLinked}\n\nSources:\n${domainLines.join("\n")}`;
  if (withDomains.length <= MAX_CONTENT_LEN) return withDomains;

  const plainWithUrls = `${textWithPlainCitations}\n\nSources:\n${urlLines.join("\n")}`;
  if (plainWithUrls.length <= MAX_CONTENT_LEN) return plainWithUrls;

  const plainWithDomains = `${textWithPlainCitations}\n\nSources:\n${domainLines.join("\n")}`;
  if (plainWithDomains.length <= MAX_CONTENT_LEN) return plainWithDomains;

  return textWithPlainCitations;
}

export function normalizeSkipSentinel(text) {
  const value = String(text || "").trim();
  if (!value) return "";
  if (/^\[SKIP\]$/i.test(value)) return "[SKIP]";

  const withoutTrailingSkip = value.replace(/\s*\[SKIP\]\s*$/i, "").trim();
  return withoutTrailingSkip || "[SKIP]";
}

function extractDomainForSourceLabel(rawUrl) {
  try {
    return new URL(String(rawUrl || "")).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}
