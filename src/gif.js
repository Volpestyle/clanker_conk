import { clamp } from "./utils.js";

const TENOR_SEARCH_API_URL = "https://tenor.googleapis.com/v2/search";
const GIF_TIMEOUT_MS = 8_500;
const GIF_USER_AGENT =
  "clanker-conk/0.1 (+gif-search; https://github.com/Volpestyle/clanker_conk)";
const MAX_GIF_QUERY_LEN = 120;

export class GifService {
  constructor({ appConfig, store }) {
    this.store = store;
    this.apiKey = String(appConfig?.tenorApiKey || "").trim();
    this.clientKey = String(appConfig?.tenorClientKey || "").trim();
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async pickGif({ query, trace = {} }) {
    if (!this.isConfigured()) {
      throw new Error("Tenor GIF search is not configured. Set TENOR_API_KEY.");
    }

    const normalizedQuery = sanitizeExternalText(query, MAX_GIF_QUERY_LEN);
    if (!normalizedQuery) {
      return null;
    }

    try {
      const matches = await this.searchTenor({
        query: normalizedQuery,
        limit: 10
      });
      const selected = pickRandom(matches);

      this.store.logAction({
        kind: "gif_call",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: normalizedQuery,
        metadata: {
          provider: "tenor",
          query: normalizedQuery,
          source: trace.source || "unknown",
          returnedResults: matches.length,
          used: Boolean(selected),
          gifUrl: selected?.url || null
        }
      });

      return selected || null;
    } catch (error) {
      this.store.logAction({
        kind: "gif_error",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: String(error?.message || error),
        metadata: {
          provider: "tenor",
          query: normalizedQuery,
          source: trace.source || "unknown"
        }
      });
      throw error;
    }
  }

  async searchTenor({ query, limit }) {
    const endpoint = new URL(TENOR_SEARCH_API_URL);
    endpoint.searchParams.set("key", this.apiKey);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("limit", String(clamp(Number(limit) || 10, 1, 25)));
    endpoint.searchParams.set("media_filter", "gif");
    endpoint.searchParams.set("contentfilter", "medium");
    endpoint.searchParams.set("locale", "en_US");
    if (this.clientKey) {
      endpoint.searchParams.set("client_key", this.clientKey);
    }

    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        "user-agent": GIF_USER_AGENT,
        accept: "application/json"
      },
      signal: AbortSignal.timeout(GIF_TIMEOUT_MS)
    });

    if (!response.ok) {
      throw new Error(`Tenor HTTP ${response.status}`);
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Tenor returned invalid JSON.");
    }

    const rawItems = Array.isArray(payload?.results) ? payload.results : [];
    const seenUrls = new Set();
    const items = [];

    for (const row of rawItems) {
      const media = row?.media_formats ?? {};
      const url = sanitizeHttpsUrl(media?.gif?.url || media?.mediumgif?.url || media?.tinygif?.url || "");
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);

      items.push({
        id: String(row?.id || ""),
        title: sanitizeExternalText(row?.content_description || row?.title || "", 140),
        url,
        pageUrl: sanitizeHttpsUrl(row?.itemurl || row?.url || "")
      });
    }

    return items;
  }
}

function pickRandom(items) {
  if (!Array.isArray(items) || !items.length) return null;
  return items[Math.floor(Math.random() * items.length)];
}

function sanitizeExternalText(text, maxLen) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, clamp(Number(maxLen) || 120, 1, 5000));
}

function sanitizeHttpsUrl(rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) return "";

  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "https:") return "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}
