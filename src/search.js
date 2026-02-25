import { normalizeDiscoveryUrl } from "./discovery.js";
import { clamp } from "./utils.js";

const GOOGLE_SEARCH_API_URL = "https://www.googleapis.com/customsearch/v1";
const SEARCH_TIMEOUT_MS = 9_000;
const PAGE_TIMEOUT_MS = 8_500;
const SEARCH_USER_AGENT =
  "clanker-conk/0.1 (+web-search; https://github.com/Volpestyle/clanker_conk)";

export class WebSearchService {
  constructor({ appConfig, store }) {
    this.store = store;
    this.apiKey = String(appConfig?.googleSearchApiKey || "").trim();
    this.engineId = String(appConfig?.googleSearchEngineId || "").trim();
  }

  isConfigured() {
    return Boolean(this.apiKey && this.engineId);
  }

  async searchAndRead({
    settings,
    query,
    trace = {}
  }) {
    if (!this.isConfigured()) {
      throw new Error(
        "Google search is not configured. Set GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_ENGINE_ID."
      );
    }

    const config = normalizeWebSearchConfig(settings?.webSearch);
    const normalizedQuery = sanitizeExternalText(query, 220);
    if (!normalizedQuery) {
      return {
        query: "",
        results: [],
        fetchedPages: 0
      };
    }

    try {
      const searchResults = await this.searchGoogle({
        query: normalizedQuery,
        maxResults: config.maxResults,
        safeSearch: config.safeSearch
      });
      const readCandidates = searchResults.slice(0, config.maxPagesToRead);
      const pageSummaries = await Promise.all(
        readCandidates.map((item) =>
          this.readPageSummary(item.url, config.maxCharsPerPage).catch((error) => ({
            error: String(error?.message || error)
          }))
        )
      );

      const summaryByUrl = new Map();
      for (let index = 0; index < readCandidates.length; index += 1) {
        summaryByUrl.set(readCandidates[index].url, pageSummaries[index]);
      }

      const results = searchResults.map((item) => {
        const page = summaryByUrl.get(item.url);
        return {
          ...item,
          pageTitle: page?.title || null,
          pageSummary: page?.summary || null,
          pageError: page?.error || null
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
          safeSearch: config.safeSearch
        }
      });

      return {
        query: normalizedQuery,
        results,
        fetchedPages
      };
    } catch (error) {
      this.store.logAction({
        kind: "search_error",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: String(error?.message || error),
        metadata: {
          query: normalizedQuery,
          source: trace.source || "unknown"
        }
      });
      throw error;
    }
  }

  async searchGoogle({ query, maxResults, safeSearch }) {
    const endpoint = new URL(GOOGLE_SEARCH_API_URL);
    endpoint.searchParams.set("key", this.apiKey);
    endpoint.searchParams.set("cx", this.engineId);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("num", String(clamp(Number(maxResults) || 5, 1, 10)));
    endpoint.searchParams.set("safe", safeSearch ? "active" : "off");
    endpoint.searchParams.set("hl", "en");
    endpoint.searchParams.set("gl", "us");

    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        "user-agent": SEARCH_USER_AGENT,
        accept: "application/json"
      },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
    });

    if (!response.ok) {
      throw new Error(`Google Search HTTP ${response.status}`);
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Google Search returned invalid JSON.");
    }

    if (payload?.error?.message) {
      throw new Error(`Google Search API error: ${payload.error.message}`);
    }

    const rawItems = Array.isArray(payload?.items) ? payload.items : [];
    const seen = new Set();
    const items = [];

    for (const entry of rawItems) {
      const normalizedUrl = normalizeDiscoveryUrl(entry?.link || "");
      if (!normalizedUrl || seen.has(normalizedUrl)) continue;
      seen.add(normalizedUrl);

      items.push({
        rank: items.length + 1,
        title: sanitizeExternalText(entry?.title || "untitled", 180),
        url: normalizedUrl,
        domain: extractDomain(normalizedUrl),
        snippet: sanitizeExternalText(entry?.snippet || "", 260)
      });
    }

    return items.slice(0, clamp(Number(maxResults) || 5, 1, 10));
  }

  async readPageSummary(url, maxChars) {
    const safeUrl = normalizeDiscoveryUrl(url);
    if (!safeUrl) {
      throw new Error(`blocked or invalid page URL: ${url}`);
    }

    const response = await fetch(safeUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent": SEARCH_USER_AGENT,
        accept: "text/html,text/plain;q=0.9,*/*;q=0.2"
      },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS)
    });

    if (!response.ok) {
      throw new Error(`page fetch HTTP ${response.status}`);
    }

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (
      contentType &&
      !contentType.includes("text/html") &&
      !contentType.includes("text/plain")
    ) {
      throw new Error(`unsupported content type: ${contentType || "unknown"}`);
    }

    const raw = await response.text();
    if (!raw) {
      throw new Error("empty page response");
    }

    if (contentType.includes("text/plain")) {
      const summary = sanitizeExternalText(raw, maxChars);
      if (!summary) {
        throw new Error("page text had no usable content");
      }

      return {
        title: null,
        summary
      };
    }

    const title = sanitizeExternalText(extractTitle(raw), 120) || null;
    const summary = sanitizeExternalText(extractReadableHtmlText(raw), maxChars);
    if (!summary) {
      throw new Error("HTML page had no usable text");
    }

    return {
      title,
      summary
    };
  }
}

function normalizeWebSearchConfig(rawConfig) {
  const cfg = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const maxResultsRaw = Number(cfg.maxResults);
  const maxPagesRaw = Number(cfg.maxPagesToRead);
  const maxCharsRaw = Number(cfg.maxCharsPerPage);

  return {
    maxResults: clamp(Number.isFinite(maxResultsRaw) ? maxResultsRaw : 5, 1, 10),
    maxPagesToRead: clamp(Number.isFinite(maxPagesRaw) ? maxPagesRaw : 3, 0, 6),
    maxCharsPerPage: clamp(Number.isFinite(maxCharsRaw) ? maxCharsRaw : 1400, 350, 4000),
    safeSearch: cfg.safeSearch !== undefined ? Boolean(cfg.safeSearch) : true
  };
}

function extractDomain(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
}

function extractTitle(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return decodeHtmlEntities(match?.[1] || "");
}

function extractReadableHtmlText(html) {
  const source = String(html || "");
  const bodyMatch = source.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch?.[1] || source;

  const withoutNoise = body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ");

  const blocksToBreak = withoutNoise.replace(
    /<\/(p|div|article|section|h1|h2|h3|h4|h5|h6|li|tr|blockquote|pre)>/gi,
    "\n"
  );

  const withoutTags = blocksToBreak.replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(withoutTags);
}

function decodeHtmlEntities(value) {
  return String(value || "")
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
    });
}

function sanitizeExternalText(value, maxLen = 240) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}
