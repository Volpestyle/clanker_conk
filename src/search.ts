import dns from "node:dns/promises";
import net from "node:net";
import { normalizeDiscoveryUrl } from "./discovery.ts";
import { clamp } from "./utils.ts";

const BRAVE_SEARCH_API_URL = "https://api.search.brave.com/res/v1/web/search";
const SERPAPI_SEARCH_API_URL = "https://serpapi.com/search.json";
const SEARCH_TIMEOUT_MS = 5_000;
const FAST_FETCH_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const SEARCH_RETRY_ATTEMPTS = 2;
const FETCH_RETRY_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 180;
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
const SEARCH_USER_AGENT =
  "clanker-conk/0.2 (+web-search-v2; https://github.com/Volpestyle/clanker_conk)";

export class WebSearchService {
  constructor({ appConfig, store }) {
    this.store = store;
    this.providers = buildProviders(appConfig);
  }

  isConfigured() {
    return this.providers.some((provider) => provider.isConfigured());
  }

  async searchAndRead({ settings, query, trace = {} }) {
    const config = normalizeWebSearchConfig(settings?.webSearch);
    const normalizedQuery = sanitizeExternalText(query, 220);
    if (!normalizedQuery) {
      return {
        query: "",
        results: [],
        fetchedPages: 0,
        providerUsed: null,
        providerFallbackUsed: false
      };
    }

    const providers = resolveProviderOrder(this.providers, config.providerOrder);
    const primaryProvider = providers[0] || null;
    const secondaryProvider = providers[1] || null;

    if (!primaryProvider) {
      throw new Error("Live search is not configured. Set BRAVE_SEARCH_API_KEY and/or SERPAPI_API_KEY.");
    }

    const started = Date.now();
    let providerUsed = primaryProvider.name;
    let providerFallbackUsed = false;

    try {
      let searchData;
      try {
        searchData = await primaryProvider.search({
          query: normalizedQuery,
          maxResults: config.maxResults,
          recencyDays: config.recencyDaysDefault,
          safeSearch: config.safeSearch
        });
      } catch (error) {
        if (!secondaryProvider) throw error;
        providerFallbackUsed = true;
        providerUsed = secondaryProvider.name;
        searchData = await secondaryProvider.search({
          query: normalizedQuery,
          maxResults: config.maxResults,
          recencyDays: config.recencyDaysDefault,
          safeSearch: config.safeSearch
        });
      }

      const readCandidates = searchData.results.slice(0, config.maxPagesToRead);
      const pageSummaries = await mapConcurrent(readCandidates, config.maxConcurrentFetches, async (item) => {
        try {
          return await this.readPageSummary(item.url, config.maxCharsPerPage);
        } catch (error) {
          this.logSearchError({
            trace,
            query: normalizedQuery,
            provider: providerUsed,
            stage: "fetch",
            attempts: Number(error?.attempts || 1),
            error
          });
          return { error: String(error?.message || error), attempts: Number(error?.attempts || 1) };
        }
      });

      const summaryByUrl = new Map();
      for (let index = 0; index < readCandidates.length; index += 1) {
        summaryByUrl.set(readCandidates[index].url, pageSummaries[index]);
      }

      const results = searchData.results.map((item) => {
        const page = summaryByUrl.get(item.url);
        return {
          ...item,
          provider: item.provider || providerUsed,
          pageTitle: page?.title || null,
          pageSummary: page?.summary || null,
          pageError: page?.error || null,
          extractionMethod: page?.extractionMethod || null
        };
      });

      const fetchedPages = results.filter((row) => row.pageSummary).length;

      this.store.logAction({
        kind: "search_call",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: normalizedQuery,
        metadata: {
          query: normalizedQuery,
          source: trace.source || "unknown",
          maxResults: config.maxResults,
          returnedResults: results.length,
          pageReadsRequested: readCandidates.length,
          pageReadsSucceeded: fetchedPages,
          providerUsed,
          fallbackUsed: providerFallbackUsed,
          latencyMs: Date.now() - started
        }
      });

      return {
        query: normalizedQuery,
        results,
        fetchedPages,
        providerUsed,
        providerFallbackUsed
      };
    } catch (error) {
      this.logSearchError({
        trace,
        query: normalizedQuery,
        provider: providerUsed,
        stage: "provider",
        attempts: Number(error?.attempts || 1),
        error
      });
      throw error;
    }
  }

  async readPageSummary(url, maxChars) {
    const safeUrl = normalizeSearchUrl(url);
    if (!safeUrl) {
      throw new Error(`blocked or invalid page URL: ${url}`);
    }

    await assertPublicUrl(safeUrl);

    const { response, attempts } = await fetchWithRetry({
      request: () =>
        fetch(safeUrl, {
          method: "GET",
          redirect: "follow",
          headers: {
            "user-agent": SEARCH_USER_AGENT,
            accept: "text/html,text/plain;q=0.9,*/*;q=0.2"
          },
          signal: AbortSignal.timeout(FAST_FETCH_TIMEOUT_MS)
        }),
      shouldRetryResponse: (res) => !res.ok && shouldRetryHttpStatus(res.status),
      maxAttempts: FETCH_RETRY_ATTEMPTS
    });

    if (!response.ok) {
      const error = new Error(`page fetch HTTP ${response.status}`);
      error.attempts = attempts;
      throw error;
    }

    const finalUrl = normalizeSearchUrl(response.url);
    if (!finalUrl) {
      const error = new Error(`redirected to blocked URL: ${response.url}`);
      error.attempts = attempts;
      throw error;
    }
    await assertPublicUrl(finalUrl);

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (
      contentType &&
      !contentType.includes("text/html") &&
      !contentType.includes("text/plain")
    ) {
      const error = new Error(`unsupported content type: ${contentType || "unknown"}`);
      error.attempts = attempts;
      throw error;
    }

    const raw = await readResponseBodyLimited(response, MAX_RESPONSE_BYTES);
    if (!raw) {
      const error = new Error("empty page response");
      error.attempts = attempts;
      throw error;
    }

    if (contentType.includes("text/plain")) {
      const summary = sanitizeExternalText(raw, maxChars);
      if (!summary) {
        const error = new Error("page text had no usable content");
        error.attempts = attempts;
        throw error;
      }

      return {
        title: null,
        summary,
        attempts,
        extractionMethod: "fast"
      };
    }

    const extraction = extractReadableContent(raw, maxChars);
    if (!extraction.summary) {
      const error = new Error("HTML page had no usable text");
      error.attempts = attempts;
      throw error;
    }

    return {
      title: extraction.title,
      summary: extraction.summary,
      attempts,
      extractionMethod: "fast"
    };
  }

  logSearchError({ trace, query, provider, stage, attempts, error }) {
    this.store.logAction({
      kind: "search_error",
      guildId: trace.guildId,
      channelId: trace.channelId,
      userId: trace.userId,
      content: String(error?.message || error),
      metadata: {
        query,
        source: trace.source || "unknown",
        provider,
        stage,
        attempts,
        maxAttemptsPerRequest: Math.max(SEARCH_RETRY_ATTEMPTS, FETCH_RETRY_ATTEMPTS)
      }
    });
  }
}

function buildProviders(appConfig) {
  return [
    new BraveSearchProvider(appConfig),
    new SerpApiSearchProvider(appConfig)
  ];
}

function resolveProviderOrder(providers, configuredOrder) {
  const desired = Array.isArray(configuredOrder) && configuredOrder.length
    ? configuredOrder
    : ["brave", "serpapi"];
  const byName = new Map(providers.map((provider) => [provider.name, provider]));
  const ordered = [];
  for (const key of desired) {
    const provider = byName.get(key);
    if (provider?.isConfigured()) ordered.push(provider);
  }
  for (const provider of providers) {
    if (provider.isConfigured() && !ordered.includes(provider)) {
      ordered.push(provider);
    }
  }
  return ordered;
}

class BraveSearchProvider {
  constructor(appConfig) {
    this.name = "brave";
    this.apiKey = String(appConfig?.braveSearchApiKey || "").trim();
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async search(input) {
    const endpoint = new URL(BRAVE_SEARCH_API_URL);
    endpoint.searchParams.set("q", input.query);
    endpoint.searchParams.set("count", String(clamp(Number(input.maxResults) || 5, 1, 10)));
    if (input.recencyDays) {
      endpoint.searchParams.set("freshness", `${clamp(Number(input.recencyDays) || 30, 1, 365)}d`);
    }
    endpoint.searchParams.set("safesearch", input.safeSearch ? "strict" : "off");

    const { response, attempts } = await fetchWithRetry({
      request: () =>
        fetch(endpoint, {
          method: "GET",
          headers: {
            "x-subscription-token": this.apiKey,
            accept: "application/json",
            "user-agent": SEARCH_USER_AGENT
          },
          signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
        }),
      shouldRetryResponse: (res) => !res.ok && shouldRetryHttpStatus(res.status),
      maxAttempts: SEARCH_RETRY_ATTEMPTS
    });

    if (!response.ok) {
      const error = new Error(`Brave Search HTTP ${response.status}`);
      error.attempts = attempts;
      throw error;
    }

    const payload = await safeJson(response, attempts, "Brave Search returned invalid JSON.");
    const rawItems = Array.isArray(payload?.web?.results) ? payload.web.results : [];
    return { results: normalizeProviderResults(rawItems, "brave", input.maxResults) };
  }
}

class SerpApiSearchProvider {
  constructor(appConfig) {
    this.name = "serpapi";
    this.apiKey = String(appConfig?.serpApiKey || "").trim();
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async search(input) {
    const endpoint = new URL(SERPAPI_SEARCH_API_URL);
    endpoint.searchParams.set("engine", "google");
    endpoint.searchParams.set("q", input.query);
    endpoint.searchParams.set("api_key", this.apiKey);
    endpoint.searchParams.set("num", String(clamp(Number(input.maxResults) || 5, 1, 10)));
    endpoint.searchParams.set("safe", input.safeSearch ? "active" : "off");
    if (input.recencyDays) {
      endpoint.searchParams.set("tbs", `qdr:d${clamp(Number(input.recencyDays) || 30, 1, 365)}`);
    }

    const { response, attempts } = await fetchWithRetry({
      request: () =>
        fetch(endpoint, {
          method: "GET",
          headers: {
            accept: "application/json",
            "user-agent": SEARCH_USER_AGENT
          },
          signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
        }),
      shouldRetryResponse: (res) => !res.ok && shouldRetryHttpStatus(res.status),
      maxAttempts: SEARCH_RETRY_ATTEMPTS
    });

    if (!response.ok) {
      const error = new Error(`SerpApi HTTP ${response.status}`);
      error.attempts = attempts;
      throw error;
    }

    const payload = await safeJson(response, attempts, "SerpApi returned invalid JSON.");
    const rawItems = Array.isArray(payload?.organic_results) ? payload.organic_results : [];
    return { results: normalizeProviderResults(rawItems, "serpapi", input.maxResults) };
  }
}

function normalizeProviderResults(rawItems, provider, maxResults) {
  const seen = new Set();
  const normalized = [];
  for (const entry of rawItems) {
    const normalizedUrl = normalizeSearchUrl(entry?.url || entry?.link || "");
    if (!normalizedUrl || seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);

    normalized.push({
      rank: normalized.length + 1,
      title: sanitizeExternalText(entry?.title || "untitled", 180),
      url: normalizedUrl,
      domain: extractDomain(normalizedUrl),
      snippet: sanitizeExternalText(entry?.description || entry?.snippet || "", 320),
      published: entry?.age || entry?.date || null,
      provider
    });
  }
  return normalized.slice(0, clamp(Number(maxResults) || 5, 1, 10));
}

function normalizeWebSearchConfig(rawConfig) {
  const cfg = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const maxResultsRaw = Number(cfg.maxResults);
  const maxPagesRaw = Number(cfg.maxPagesToRead);
  const maxCharsRaw = Number(cfg.maxCharsPerPage);
  const maxConcurrentFetches = Number(cfg.maxConcurrentFetches);

  return {
    maxResults: clamp(Number.isFinite(maxResultsRaw) ? maxResultsRaw : 5, 1, 10),
    maxPagesToRead: clamp(Number.isFinite(maxPagesRaw) ? maxPagesRaw : 3, 0, 5),
    maxCharsPerPage: clamp(Number.isFinite(maxCharsRaw) ? maxCharsRaw : 1400, 350, 4000),
    safeSearch: cfg.safeSearch !== undefined ? Boolean(cfg.safeSearch) : true,
    recencyDaysDefault: clamp(Number(cfg.recencyDaysDefault) || 30, 1, 365),
    providerOrder: normalizeProviderOrder(cfg.providerOrder),
    maxConcurrentFetches: clamp(Number.isFinite(maxConcurrentFetches) ? maxConcurrentFetches : 5, 1, 10)
  };
}

export function normalizeProviderOrder(order) {
  const allowed = new Set(["brave", "serpapi"]);
  const values = Array.isArray(order) ? order : ["brave", "serpapi"];
  const normalized = [];
  for (const value of values) {
    const key = String(value || "").toLowerCase();
    if (!allowed.has(key) || normalized.includes(key)) continue;
    normalized.push(key);
  }
  if (!normalized.length) {
    return ["brave", "serpapi"];
  }
  return normalized;
}

function extractDomain(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
}

function sanitizeExternalText(value, maxLen = 240) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

async function fetchWithRetry({ request, shouldRetryResponse, maxAttempts }) {
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

  throw withAttemptCount(new Error("Web fetch failed after retries."), maxAttempts);
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
      // noop
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

function normalizeSearchUrl(raw) {
  return normalizeDiscoveryUrl(raw);
}

async function assertPublicUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  const host = String(parsed.hostname || "").toLowerCase();
  if (isBlockedHost(host)) {
    throw new Error(`blocked host: ${host}`);
  }

  const records = await dns.lookup(host, { all: true });
  for (const record of records) {
    if (isPrivateIp(record?.address)) {
      throw new Error(`blocked private address for host ${host}`);
    }
  }
}

function isBlockedHost(host) {
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".local")) return true;
  return isPrivateIp(host);
}

function isPrivateIp(value) {
  const ipType = net.isIP(value);
  if (!ipType) return false;

  if (ipType === 4) {
    const parts = value.split(".").map((part) => Number(part || 0));
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    return false;
  }

  const compact = value.replace(/^\[|\]$/g, "").toLowerCase();
  if (compact === "::1") return true;
  if (compact.startsWith("fc") || compact.startsWith("fd")) return true;
  return compact.startsWith("fe80");
}

async function safeJson(response, attempts, errorMessage) {
  try {
    return await response.json();
  } catch {
    const error = new Error(errorMessage);
    error.attempts = attempts;
    throw error;
  }
}

async function readResponseBodyLimited(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        throw new Error(`response exceeds max size of ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return buffer.toString("utf8");
}

function extractReadableContent(html, maxChars) {
  const title = sanitizeExternalText(extractTitle(html), 120) || null;
  const body = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<\/\s*(p|div|article|section|h1|h2|h3|h4|h5|h6|li|tr|blockquote|pre|br)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_m, code) => {
      const num = Number(code);
      return Number.isFinite(num) ? String.fromCharCode(num) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const num = Number.parseInt(hex, 16);
      return Number.isFinite(num) ? String.fromCharCode(num) : "";
    })
    .replace(/\s+/g, " ")
    .trim();
  const summary = sanitizeExternalText(body, maxChars);
  return { title, summary };
}

function extractTitle(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return String(match?.[1] || "").replace(/\s+/g, " ").trim();
}

async function mapConcurrent(items, limit, mapper) {
  const max = Math.max(1, Number(limit) || 1);
  const results = new Array(items.length);
  let cursor = 0;

  // Safe because mapper is always async (does I/O), so cursor is only
  // read/incremented synchronously between awaits on the single JS thread.
  async function worker() {
    while (cursor < items.length) {
      const current = cursor;
      cursor += 1;
      results[current] = await mapper(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(max, items.length) }, () => worker()));
  return results;
}
