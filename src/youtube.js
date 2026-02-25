import { normalizeDiscoveryUrl } from "./discovery.js";
import { clamp } from "./utils.js";

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>()]+/gi;
const YOUTUBE_USER_AGENT =
  "clanker-conk/0.1 (+youtube-context; https://github.com/Volpestyle/clanker_conk)";
const REQUEST_TIMEOUT_MS = 5_500;
const MAX_FETCH_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 180;
const CACHE_TTL_MS = 30 * 60 * 1000;
const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_FETCH_ERROR_CODES = new Set([
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT"
]);

export class YouTubeContextService {
  constructor({ store }) {
    this.store = store;
    this.cache = new Map();
  }

  extractVideoTargets(text, limit = 2) {
    const urls = extractUrls(String(text || ""));
    const uniqueByVideoId = new Map();
    const maxTargets = clamp(Number(limit) || 2, 0, 8);

    for (const rawUrl of urls) {
      if (uniqueByVideoId.size >= maxTargets) break;
      const target = parseYoutubeTarget(rawUrl);
      if (!target) continue;
      if (uniqueByVideoId.has(target.videoId)) continue;
      uniqueByVideoId.set(target.videoId, target);
    }

    return [...uniqueByVideoId.values()];
  }

  async fetchContexts({ targets, maxTranscriptChars = 1200, trace = {} }) {
    const list = Array.isArray(targets) ? targets : [];
    const transcriptLimit = clamp(Number(maxTranscriptChars) || 1200, 200, 4000);
    const videos = [];
    const errors = [];

    for (const target of list) {
      try {
        const context = await this.fetchVideoContext({
          videoId: target.videoId,
          sourceUrl: target.url,
          maxTranscriptChars: transcriptLimit
        });
        videos.push({
          videoId: context.videoId,
          url: context.url,
          title: context.title,
          channel: context.channel,
          publishedAt: context.publishedAt,
          durationSeconds: context.durationSeconds,
          viewCount: context.viewCount,
          description: context.description,
          transcript: context.transcript,
          transcriptError: context.transcriptError || null
        });
        this.store.logAction({
          kind: "youtube_context_call",
          guildId: trace.guildId,
          channelId: trace.channelId,
          userId: trace.userId,
          content: context.videoId,
          metadata: {
            source: trace.source || "unknown",
            videoId: context.videoId,
            url: context.url,
            title: context.title,
            channel: context.channel,
            hasTranscript: Boolean(context.transcript),
            transcriptChars: context.transcript ? context.transcript.length : 0,
            transcriptError: context.transcriptError || null,
            cacheHit: Boolean(context.cacheHit)
          }
        });
      } catch (error) {
        const message = String(error?.message || error);
        errors.push({
          videoId: target.videoId,
          url: target.url,
          error: message
        });
        this.store.logAction({
          kind: "youtube_context_error",
          guildId: trace.guildId,
          channelId: trace.channelId,
          userId: trace.userId,
          content: `${target.videoId}: ${message}`.slice(0, 2000),
          metadata: {
            source: trace.source || "unknown",
            videoId: target.videoId,
            url: target.url,
            attempts: Number(error?.attempts || 1)
          }
        });
      }
    }

    return {
      videos,
      errors
    };
  }

  async fetchVideoContext({ videoId, sourceUrl, maxTranscriptChars }) {
    this.pruneCache();
    const cached = this.cache.get(videoId);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return {
        ...cached.value,
        cacheHit: true
      };
    }

    const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const html = await fetchTextWithRetry({
      url: `${watchUrl}&hl=en`,
      accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.2"
    });
    const playerResponse = extractPlayerResponse(html);
    if (!playerResponse) {
      throw new Error("YouTube page did not expose playable metadata.");
    }

    const summary = summarizeVideo({
      videoId,
      url: sourceUrl || watchUrl,
      playerResponse
    });
    let transcript = "";
    let transcriptError = null;
    try {
      transcript = await fetchTranscriptText({
        playerResponse,
        maxTranscriptChars
      });
    } catch (error) {
      transcriptError = String(error?.message || error);
    }
    summary.transcript = transcript;
    if (transcriptError) {
      summary.transcriptError = transcriptError;
    }

    const value = {
      ...summary,
      cacheHit: false
    };
    this.cache.set(videoId, {
      cachedAt: Date.now(),
      value
    });
    return value;
  }

  pruneCache() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (!entry || now - entry.cachedAt >= CACHE_TTL_MS) {
        this.cache.delete(key);
      }
    }
  }
}

function extractUrls(text) {
  URL_IN_TEXT_RE.lastIndex = 0;
  return [...String(text || "").matchAll(URL_IN_TEXT_RE)].map((match) => String(match[0] || ""));
}

function parseYoutubeTarget(rawUrl) {
  const safeUrl = normalizeDiscoveryUrl(rawUrl);
  if (!safeUrl) return null;

  let parsed = null;
  try {
    parsed = new URL(safeUrl);
  } catch {
    return null;
  }

  const host = String(parsed.hostname || "").toLowerCase();
  const compactHost = host.replace(/^www\./, "");
  let videoId = "";
  if (compactHost === "youtu.be") {
    videoId = parsed.pathname.split("/").filter(Boolean)[0] || "";
  } else if (compactHost.endsWith("youtube.com") || compactHost === "youtube-nocookie.com") {
    if (parsed.pathname === "/watch" || parsed.pathname === "/watch/") {
      videoId = parsed.searchParams.get("v") || "";
    } else {
      const pathParts = parsed.pathname.split("/").filter(Boolean);
      if (pathParts[0] === "shorts" || pathParts[0] === "embed" || pathParts[0] === "live") {
        videoId = pathParts[1] || "";
      }
    }
  }

  videoId = String(videoId || "").trim();
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) return null;

  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`
  };
}

function summarizeVideo({ videoId, url, playerResponse }) {
  const details = playerResponse?.videoDetails || {};
  const micro = playerResponse?.microformat?.playerMicroformatRenderer || {};

  const title =
    sanitizeText(
      details?.title || micro?.title?.simpleText || micro?.title || "",
      180
    ) || "untitled video";
  const channel =
    sanitizeText(
      details?.author || micro?.ownerChannelName || micro?.ownerChannel || "",
      120
    ) || "unknown channel";
  const description = sanitizeText(details?.shortDescription || micro?.description?.simpleText || "", 360);
  const publishedAt = normalizeDateIso(micro?.publishDate || micro?.uploadDate || "");
  const durationSeconds = safeNumber(details?.lengthSeconds);
  const viewCount = safeNumber(details?.viewCount);

  return {
    videoId,
    url: String(url || `https://www.youtube.com/watch?v=${videoId}`),
    title,
    channel,
    publishedAt,
    durationSeconds,
    viewCount,
    description,
    transcript: ""
  };
}

async function fetchTranscriptText({ playerResponse, maxTranscriptChars }) {
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || !tracks.length) return "";

  const preferred =
    tracks.find((track) => /^en(?:-|$)/i.test(String(track?.languageCode || "")) && track?.kind !== "asr") ||
    tracks.find((track) => /^en(?:-|$)/i.test(String(track?.languageCode || ""))) ||
    tracks.find((track) => track?.kind !== "asr") ||
    tracks[0];
  const baseUrl = String(preferred?.baseUrl || "").trim();
  if (!baseUrl) return "";

  const transcriptUrl = new URL(baseUrl);
  transcriptUrl.searchParams.set("fmt", "srv3");
  transcriptUrl.searchParams.set("xorb", "2");
  transcriptUrl.searchParams.set("hl", "en");

  const raw = await fetchTextWithRetry({
    url: transcriptUrl.toString(),
    accept: "application/xml,text/xml,text/plain;q=0.9,*/*;q=0.2"
  });
  const blocks = [...raw.matchAll(/<(?:text|p)\b[^>]*>([\s\S]*?)<\/(?:text|p)>/gi)];
  if (!blocks.length) return "";

  const joined = blocks
    .map((match) =>
      decodeHtmlEntities(
        String(match?.[1] || "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      )
    )
    .filter(Boolean)
    .join(" ");

  return sanitizeText(joined, maxTranscriptChars);
}

function extractPlayerResponse(html) {
  const source = String(html || "");
  const markers = [
    "var ytInitialPlayerResponse = ",
    'window["ytInitialPlayerResponse"] = ',
    "window['ytInitialPlayerResponse'] = ",
    '"ytInitialPlayerResponse":'
  ];

  for (const marker of markers) {
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) continue;
    const startIndex = source.indexOf("{", markerIndex + marker.length);
    if (startIndex < 0) continue;
    const json = extractBalancedJsonObject(source, startIndex);
    if (!json) continue;
    try {
      return JSON.parse(json);
    } catch {
      // Continue to next marker.
    }
  }

  return null;
}

function extractBalancedJsonObject(text, startIndex) {
  if (!text || startIndex < 0 || text[startIndex] !== "{") return null;

  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

async function fetchTextWithRetry({ url, accept = "*/*", maxAttempts = MAX_FETCH_ATTEMPTS }) {
  const { response, attempts } = await fetchWithRetry({
    request: () =>
      fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: {
          "user-agent": YOUTUBE_USER_AGENT,
          accept
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      }),
    shouldRetryResponse: (res) => !res.ok && shouldRetryHttpStatus(res.status),
    maxAttempts
  });

  if (!response.ok) {
    const error = new Error(`YouTube HTTP ${response.status}`);
    error.attempts = attempts;
    throw error;
  }

  let text = "";
  try {
    text = await response.text();
  } catch (error) {
    throw withAttemptCount(error, attempts);
  }
  if (!text) {
    const error = new Error("YouTube returned empty response.");
    error.attempts = attempts;
    throw error;
  }

  return text;
}

async function fetchWithRetry({
  request,
  shouldRetryResponse,
  maxAttempts = MAX_FETCH_ATTEMPTS
}) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const response = await request();
      if (!shouldRetryResponse(response) || attempt >= maxAttempts) {
        return { response, attempts: attempt };
      }
    } catch (error) {
      if (!isRetryableFetchError(error) || attempt >= maxAttempts) {
        throw withAttemptCount(error, attempt);
      }
    }

    await sleep(getRetryDelayMs(attempt));
  }

  throw withAttemptCount(new Error("YouTube fetch failed after retries."), maxAttempts);
}

function shouldRetryHttpStatus(status) {
  return RETRYABLE_HTTP_STATUS.has(Number(status));
}

function isRetryableFetchError(error) {
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  if (RETRYABLE_FETCH_ERROR_CODES.has(code)) return true;

  const name = String(error?.name || "");
  if (name === "AbortError" || name === "TimeoutError") return true;

  const message = String(error?.message || "").toLowerCase();
  return message.includes("timeout") || message.includes("timed out") || message.includes("fetch failed");
}

function withAttemptCount(error, attempts) {
  if (error && typeof error === "object") {
    try {
      error.attempts = Number(attempts || 1);
      return error;
    } catch {
      // Fall through to wrapped error.
    }
  }

  const wrapped = new Error(String(error?.message || error || "unknown error"));
  wrapped.attempts = Number(attempts || 1);
  return wrapped;
}

function getRetryDelayMs(attempt) {
  return Math.min(900, RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeDateIso(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function sanitizeText(value, maxLen = 240) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_match, numberText) => {
      const number = Number(numberText);
      return Number.isFinite(number) ? String.fromCharCode(number) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, hexText) => {
      const number = Number.parseInt(hexText, 16);
      return Number.isFinite(number) ? String.fromCharCode(number) : "";
    });
}
