import { clamp } from "../utils.ts";
import { normalizeMentionLookupKey } from "./mentionLookup.ts";
import { normalizeWhitespaceText } from "../normalization/text.ts";
import { getDiscoverySettings } from "../settings/agentStack.ts";

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>()]+/gi;
const IMAGE_PROMPT_DIRECTIVE_RE = /\[\[IMAGE_PROMPT:\s*([^\]]*?)\s*\]\]\s*$/i;
const COMPLEX_IMAGE_PROMPT_DIRECTIVE_RE = /\[\[COMPLEX_IMAGE_PROMPT:\s*([^\]]*?)\s*\]\]\s*$/i;
const VIDEO_PROMPT_DIRECTIVE_RE = /\[\[VIDEO_PROMPT:\s*([^\]]*?)\s*\]\]\s*$/i;
// English-only fallback for explicit user opt-outs; normal prompt/tool policy remains the source of truth.
const EN_WEB_SEARCH_OPTOUT_RE = /\b(?:do\s*not|don't|dont|no)\b[\w\s,]{0,24}\b(?:google|search|look\s*up)\b/i;
const DEFAULT_MAX_MEDIA_PROMPT_LEN = 900;
const MAX_MEDIA_PROMPT_FLOOR = 120;
const MAX_MEDIA_PROMPT_CEILING = 2000;
export const MAX_WEB_QUERY_LEN = 220;
export const MAX_GIF_QUERY_LEN = 120;
export const MAX_MEMORY_LOOKUP_QUERY_LEN = 220;
export const MAX_IMAGE_LOOKUP_QUERY_LEN = 220;
export const MAX_BROWSER_BROWSE_QUERY_LEN = 500;

export function resolveMaxMediaPromptLen(settings) {
  const raw = Number(getDiscoverySettings(settings).maxMediaPromptChars);
  if (!Number.isFinite(raw)) return DEFAULT_MAX_MEDIA_PROMPT_LEN;
  return clamp(Math.floor(raw), MAX_MEDIA_PROMPT_FLOOR, MAX_MEDIA_PROMPT_CEILING);
}
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

export function extractUrlsFromText(text) {
  URL_IN_TEXT_RE.lastIndex = 0;
  return [...String(text || "").matchAll(URL_IN_TEXT_RE)].map((match) => String(match[0] || ""));
}

export function emptyMentionResolution() {
  return {
    text: "",
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

export function composeDiscoveryImagePrompt(
  imagePrompt,
  postText,
  maxLen = DEFAULT_MAX_MEDIA_PROMPT_LEN,
  memoryFacts = []
) {
  URL_IN_TEXT_RE.lastIndex = 0;
  const topic = String(postText || "")
    .replace(URL_IN_TEXT_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
  const requested = normalizeDirectiveText(imagePrompt, maxLen);
  const memoryHints = formatMediaMemoryHints(memoryFacts, 5);

  return [
    "Create a vivid, shareable image for a Discord post.",
    `Scene: ${requested || topic || "general chat mood"}.`,
    `Mood/topic context (do not render as text): ${topic || "general chat mood"}.`,
    memoryHints || null,
    "Style guidance:",
    "- Describe a concrete scene with a clear subject, action, and environment.",
    "- Use cinematic or editorial framing: strong focal point, depth of field, deliberate camera angle.",
    "- Include expressive lighting (golden hour, neon glow, dramatic chiaroscuro, soft diffused, etc.).",
    "- Choose a cohesive color palette that reinforces the mood.",
    "- Favor a specific visual medium when it fits (photo-realistic, illustration, 3D render, pixel art, watercolor, cel-shaded, collage).",
    "Hard constraints:",
    "- Absolutely no visible text, letters, numbers, logos, subtitles, captions, UI elements, or watermarks anywhere in the image.",
    "- Do not render any words from the scene description or topic context as text inside the image.",
    "- Keep the composition clean with a single strong focal point."
  ]
    .filter(Boolean)
    .join("\n");
}

export function composeDiscoveryVideoPrompt(
  videoPrompt,
  postText,
  maxLen = DEFAULT_MAX_MEDIA_PROMPT_LEN,
  memoryFacts = []
) {
  URL_IN_TEXT_RE.lastIndex = 0;
  const topic = String(postText || "")
    .replace(URL_IN_TEXT_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
  const requested = normalizeDirectiveText(videoPrompt, maxLen);
  const memoryHints = formatMediaMemoryHints(memoryFacts, 5);

  return [
    "Create a short, dynamic, shareable video clip for a Discord post.",
    `Scene: ${requested || topic || "general chat mood"}.`,
    `Mood/topic context (do not render as text): ${topic || "general chat mood"}.`,
    memoryHints || null,
    "Style guidance:",
    "- Describe a concrete motion arc: what the viewer sees at the start, what changes, and how it resolves.",
    "- Specify camera behavior (slow pan, tracking shot, static wide, zoom-in, dolly, handheld shake).",
    "- Include lighting mood and color palette.",
    "- Keep the action legible in a short social-clip format (3-6 seconds of clear motion).",
    "Hard constraints:",
    "- No visible text, captions, subtitles, logos, watermarks, or UI overlays.",
    "- Smooth, continuous motion without abrupt jumps or flicker."
  ]
    .filter(Boolean)
    .join("\n");
}

function formatMediaMemoryHints(memoryFacts = [], maxItems = 5) {
  const out = collectMemoryFactHints(memoryFacts, maxItems);
  if (!out.length) return "";
  return `Relevant memory facts (use only when they match the scene): ${out.join(" | ")}`;
}

export function collectMemoryFactHints(memoryFacts = [], maxItems = 5) {
  const rows = Array.isArray(memoryFacts) ? memoryFacts : [];
  const out = [];
  const seen = new Set();
  const cap = Math.max(1, Math.floor(Number(maxItems) || 5));

  for (const row of rows) {
    const value = typeof row === "string" ? row : row?.fact;
    const normalized = String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= cap) break;
  }

  return out;
}

export function composeReplyImagePrompt(
  imagePrompt,
  replyText,
  maxLen = DEFAULT_MAX_MEDIA_PROMPT_LEN,
  memoryFacts = []
) {
  URL_IN_TEXT_RE.lastIndex = 0;
  const context = String(replyText || "")
    .replace(URL_IN_TEXT_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
  const requested = normalizeDirectiveText(imagePrompt, maxLen);
  const memoryHints = formatMediaMemoryHints(memoryFacts, 5);

  return [
    "Create a vivid image to accompany a Discord chat reply.",
    `Scene: ${requested || context || "chat reaction"}.`,
    `Conversational context (do not render as text): ${context || "chat context"}.`,
    memoryHints || null,
    "Style guidance:",
    "- Describe a concrete scene with a clear subject, action, and setting.",
    "- Use expressive framing and lighting to sell the mood.",
    "- Pick a visual medium that fits the tone (photo, illustration, 3D render, pixel art, etc.).",
    "Hard constraints:",
    "- No visible text, letters, numbers, logos, subtitles, captions, UI, or watermarks.",
    "- Keep the composition clean with one clear focal point."
  ]
    .filter(Boolean)
    .join("\n");
}

export function composeReplyVideoPrompt(
  videoPrompt,
  replyText,
  maxLen = DEFAULT_MAX_MEDIA_PROMPT_LEN,
  memoryFacts = []
) {
  URL_IN_TEXT_RE.lastIndex = 0;
  const context = String(replyText || "")
    .replace(URL_IN_TEXT_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
  const requested = normalizeDirectiveText(videoPrompt, maxLen);
  const memoryHints = formatMediaMemoryHints(memoryFacts, 5);

  return [
    "Create a short, dynamic video clip to accompany a Discord chat reply.",
    `Scene: ${requested || context || "chat reaction"}.`,
    `Conversational context (do not render as text): ${context || "chat context"}.`,
    memoryHints || null,
    "Style guidance:",
    "- Describe a concrete motion arc: what starts, what changes, how it ends.",
    "- Specify camera behavior (pan, tracking, zoom, static, handheld).",
    "- Include lighting and color palette.",
    "- Keep the action clear in a short social-clip format.",
    "Hard constraints:",
    "- No visible text, captions, subtitles, logos, watermarks, or UI overlays.",
    "- Smooth, continuous motion."
  ]
    .filter(Boolean)
    .join("\n");
}

export function parseDiscoveryMediaDirective(rawText, maxLen = DEFAULT_MAX_MEDIA_PROMPT_LEN) {
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
      const prompt = normalizeDirectiveText(complexImageMatch[1], maxLen) || null;
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
      const prompt = normalizeDirectiveText(imageMatch[1], maxLen) || null;
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
      const prompt = normalizeDirectiveText(videoMatch[1], maxLen) || null;
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

export function pickDiscoveryMediaDirective(parsed) {
  return parsed?.mediaDirective || null;
}

export function normalizeDirectiveText(text, maxLen) {
  return normalizeWhitespaceText(text, { maxLen });
}

export function serializeForPrompt(value, maxLen = 1200) {
  try {
    return String(JSON.stringify(value ?? {}, null, 2)).slice(0, Math.max(40, Number(maxLen) || 1200));
  } catch {
    return "{}";
  }
}

export function isWebSearchOptOutText(rawText) {
  return EN_WEB_SEARCH_OPTOUT_RE.test(String(rawText || ""));
}

const DISCORD_MSG_SPLIT_LIMIT = 1900;

export function splitDiscordMessage(text, maxLen = DISCORD_MSG_SPLIT_LIMIT) {
  if (!text || text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let idx = remaining.lastIndexOf("\n\n", maxLen);
    if (idx <= 0) idx = remaining.lastIndexOf(". ", maxLen);
    if (idx > 0 && remaining[idx] === ".") idx += 1;
    if (idx <= 0) idx = remaining.lastIndexOf("\n", maxLen);
    if (idx <= 0) idx = remaining.lastIndexOf(" ", maxLen);
    if (idx <= 0) idx = maxLen;
    chunks.push(remaining.slice(0, idx).trimEnd());
    remaining = remaining.slice(idx).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
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
