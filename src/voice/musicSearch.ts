export type MusicPlatform = "youtube" | "soundcloud";

export type MusicSearchResult = {
  id: string;
  title: string;
  artist: string;
  platform: MusicPlatform;
  streamUrl: string | null;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  externalUrl: string;
};

export type MusicSearchOptions = {
  platform?: MusicPlatform | "auto";
  limit?: number;
};

export type MusicSearchResponse = {
  ok: boolean;
  query: string;
  results: MusicSearchResult[];
  error: string | null;
};

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 25;

function normalizeQuery(value = ""): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clampLimit(value = 0): number {
  const n = Math.floor(Number(value) || 0);
  return Math.max(1, Math.min(n, SEARCH_LIMIT_MAX));
}

function calculateFuzzyScore(query: string, title: string, artist: string): number {
  const q = normalizeQuery(query).toLowerCase();
  const t = normalizeQuery(title).toLowerCase();
  const a = normalizeQuery(artist).toLowerCase();

  if (t === q || a === q) return 1.0;
  if (t.includes(q) || a.includes(q)) return 0.9;
  if (t.startsWith(q) || a.startsWith(q)) return 0.85;

  let score = 0;
  const qWords = q.split(" ").filter(Boolean);
  const tWords = t.split(" ").filter(Boolean);
  const aWords = a.split(" ").filter(Boolean);

  for (const qw of qWords) {
    if (tWords.some((tw) => tw.includes(qw) || qw.includes(tw))) score += 0.3;
    if (aWords.some((aw) => aw.includes(qw) || qw.includes(aw))) score += 0.3;
  }

  return Math.min(1.0, score);
}

export class MusicSearchProvider {
  youtubeApiKey: string;
  soundcloudClientId: string;

  constructor({
    youtubeApiKey = "",
    soundcloudClientId = ""
  } = {}) {
    this.youtubeApiKey = String(youtubeApiKey || "").trim();
    this.soundcloudClientId = String(soundcloudClientId || "").trim();
  }

  isConfigured(): boolean {
    return Boolean(this.youtubeApiKey || this.soundcloudClientId);
  }

  async search(query: string, options: MusicSearchOptions = {}): Promise<MusicSearchResponse> {
    const normalizedQuery = normalizeQuery(query);
    if (!normalizedQuery) {
      return { ok: false, query: "", results: [], error: "empty query" };
    }

    const platform = options.platform || "auto";
    const limit = clampLimit(options.limit || SEARCH_LIMIT_DEFAULT);

    const searches: Promise<MusicSearchResponse>[] = [];

    if (platform === "auto" || platform === "youtube") {
      searches.push(this.searchYoutube(normalizedQuery, limit));
    }
    if (platform === "auto" || platform === "soundcloud") {
      searches.push(this.searchSoundcloud(normalizedQuery, limit));
    }

    const results = await Promise.all(searches);
    const allResults = results.flatMap((r) => r.results);

    allResults.sort((a, b) => {
      const scoreA = calculateFuzzyScore(normalizedQuery, a.title, a.artist);
      const scoreB = calculateFuzzyScore(normalizedQuery, b.title, b.artist);
      return scoreB - scoreA;
    });

    return {
      ok: true,
      query: normalizedQuery,
      results: allResults.slice(0, limit),
      error: null
    };
  }

  private async searchYoutube(query: string, limit: number): Promise<MusicSearchResponse> {
    if (!this.youtubeApiKey) {
      return { ok: true, query, results: [], error: null };
    }

    try {
      const params = new URLSearchParams({
        part: "snippet",
        q: query,
        type: "video",
        videoCategoryId: "10",
        maxResults: String(limit),
        key: this.youtubeApiKey
      });

      const response = await fetch(`${YOUTUBE_API_BASE}/search?${params}`);
      if (!response.ok) {
        return { ok: true, query, results: [], error: `youtube api error: ${response.status}` };
      }

      const data = await response.json().catch(() => null);
      if (!data?.items) {
        return { ok: true, query, results: [], error: null };
      }

      const results: MusicSearchResult[] = data.items
        .filter((item: Record<string, unknown>) => (item.id as Record<string, string>)?.videoId)
        .map((item: Record<string, unknown>) => {
          const snippet = item.snippet as Record<string, unknown>;
          const idObj = item.id as Record<string, string>;
          const videoId = idObj.videoId || "";
          const thumbnails = (snippet.thumbnails as Record<string, { url?: string }>) || {};
          return {
            id: `youtube:${videoId}`,
            title: String(snippet.title || "Unknown"),
            artist: String(snippet.channelTitle || "Unknown Artist"),
            platform: "youtube" as MusicPlatform,
            streamUrl: null,
            durationSeconds: null,
            thumbnailUrl: thumbnails.medium?.url || thumbnails.default?.url || null,
            externalUrl: `https://www.youtube.com/watch?v=${videoId}`
          };
        });

      return { ok: true, query, results, error: null };
    } catch (error) {
      return { ok: true, query, results: [], error: String(error?.message || error) };
    }
  }

  private async searchSoundcloud(query: string, limit: number): Promise<MusicSearchResponse> {
    if (!this.soundcloudClientId) {
      return { ok: true, query, results: [], error: null };
    }

    try {
      const params = new URLSearchParams({
        q: query,
        client_id: this.soundcloudClientId,
        limit: String(limit),
        offset: "0"
      });

      const response = await fetch(`https://api.soundcloud.com/tracks?${params}`);
      if (!response.ok) {
        return { ok: true, query, results: [], error: `soundcloud api error: ${response.status}` };
      }

      const data = await response.json().catch(() => null);
      if (!Array.isArray(data)) {
        return { ok: true, query, results: [], error: null };
      }

      const results: MusicSearchResult[] = data
        .filter((track: Record<string, unknown>) => track.id && track.stream_url)
        .map((track: Record<string, unknown>) => {
          const permalinkUrl = String(track.permalink_url || "").trim();
          const normalizedExternalUrl = permalinkUrl
            ? /^https?:\/\//i.test(permalinkUrl)
              ? permalinkUrl
              : `https://soundcloud.com${permalinkUrl.startsWith("/") ? "" : "/"}${permalinkUrl}`
            : "";
          return {
            id: `soundcloud:${track.id}`,
            title: (track.title as string) || "Unknown",
            artist: ((track.user as Record<string, unknown>)?.username as string) || "Unknown Artist",
            platform: "soundcloud" as MusicPlatform,
            streamUrl: `${track.stream_url}?client_id=${this.soundcloudClientId}`,
            durationSeconds: track.duration ? Math.floor((track.duration as number) / 1000) : null,
            thumbnailUrl: (track.artwork_url as string) || null,
            externalUrl: normalizedExternalUrl
          };
        });

      return { ok: true, query, results, error: null };
    } catch (error) {
      return { ok: true, query, results: [], error: String(error?.message || error) };
    }
  }

  async resolveStreamUrl(result: MusicSearchResult): Promise<string | null> {
    if (result.streamUrl) return result.streamUrl;

    if (result.platform === "youtube" && result.id.startsWith("youtube:")) {
      const videoId = result.id.replace("youtube:", "");
      return `https://www.youtube.com/watch?v=${videoId}`;
    }

    if (result.platform === "soundcloud" && result.id.startsWith("soundcloud:")) {
      return result.externalUrl;
    }

    return result.externalUrl;
  }

  formatDisambiguationMessage(results: MusicSearchResult[]): string {
    if (results.length === 0) return "No results found.";
    if (results.length === 1) {
      const r = results[0];
      return `Playing "${r.title}" by ${r.artist} on ${r.platform}`;
    }

    const display = results.slice(0, 5).map((r, i) => {
      const p = r.platform === "youtube" ? "YT" : "SC";
      return `${i + 1}. "${r.title}" by ${r.artist} (${p})`;
    });

    return `Which track did you mean?\n${display.join("\n")}\n\nReply with the number (1-${Math.min(5, results.length)})`;
  }
}

export function createMusicSearchProvider(appConfig: {
  youtubeApiKey?: string;
  soundcloudClientId?: string;
}): MusicSearchProvider {
  return new MusicSearchProvider({
    youtubeApiKey: appConfig?.youtubeApiKey,
    soundcloudClientId: appConfig?.soundcloudClientId
  });
}
