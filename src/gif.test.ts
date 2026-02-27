import test from "node:test";
import assert from "node:assert/strict";
import { GifService } from "./gif.ts";

function createService({
  apiKey = "test-giphy-key",
  rating = "pg-13"
} = {}) {
  const logs = [];
  const store = {
    logAction(entry) {
      logs.push(entry);
    }
  };
  const service = new GifService({
    appConfig: {
      giphyApiKey: apiKey,
      giphyRating: rating
    },
    store
  });
  return { service, logs };
}

async function withMockFetch(handler, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("gif service reports unconfigured state without API key", async () => {
  const { service } = createService({ apiKey: "" });
  assert.equal(service.isConfigured(), false);
  await assert.rejects(
    () => service.pickGif({ query: "cats" }),
    /GIPHY GIF search is not configured/i
  );
});

test("searchGiphy builds request params and filters duplicate/non-https media", async () => {
  const { service } = createService({ rating: "PG" });
  let requestedUrl = "";
  let requestHeaders = null;

  await withMockFetch(
    async (url, options) => {
      requestedUrl = String(url);
      requestHeaders = options?.headers || null;
      return {
        ok: true,
        async json() {
          return {
            data: [
              {
                id: "a",
                title: "alpha",
                images: {
                  fixed_height: { url: "https://media.giphy.com/media/a/giphy.gif" }
                },
                url: "https://giphy.com/gifs/a"
              },
              {
                id: "dup",
                title: "duplicate",
                images: {
                  fixed_height: { url: "https://media.giphy.com/media/a/giphy.gif" }
                },
                url: "https://giphy.com/gifs/a-dup"
              },
              {
                id: "http-only",
                title: "bad",
                images: {
                  fixed_height: { url: "http://media.giphy.com/media/http/giphy.gif" }
                }
              }
            ]
          };
        }
      };
    },
    async () => {
      const rows = await service.searchGiphy({ query: "  cats   and   dogs  ", limit: 200 });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, "a");
      assert.equal(rows[0].url, "https://media.giphy.com/media/a/giphy.gif");
      assert.equal(rows[0].pageUrl, "https://giphy.com/gifs/a");
    }
  );

  const parsed = new URL(requestedUrl);
  assert.equal(parsed.origin + parsed.pathname, "https://api.giphy.com/v1/gifs/search");
  assert.equal(parsed.searchParams.get("limit"), "25");
  assert.equal(parsed.searchParams.get("rating"), "pg");
  assert.equal(parsed.searchParams.get("q"), "  cats   and   dogs  ");
  assert.equal(parsed.searchParams.get("lang"), "en");
  assert.equal(parsed.searchParams.get("bundle"), "messaging_non_clips");
  assert.equal(requestHeaders?.accept, "application/json");
});

test("pickGif returns null for empty sanitized query", async () => {
  const { service, logs } = createService();
  let fetchCallCount = 0;
  await withMockFetch(
    async () => {
      fetchCallCount += 1;
      throw new Error("fetch should not run");
    },
    async () => {
      const selected = await service.pickGif({ query: "   " });
      assert.equal(selected, null);
    }
  );
  assert.equal(fetchCallCount, 0);
  assert.equal(logs.length, 0);
});

test("pickGif logs successful call metadata", async () => {
  const { service, logs } = createService();
  const originalRandom = Math.random;
  Math.random = () => 0;

  await withMockFetch(
    async () => ({
      ok: true,
      async json() {
        return {
          data: [
            {
              id: "pick-1",
              title: "picked gif",
              images: {
                fixed_height: { url: "https://media.giphy.com/media/pick/giphy.gif" }
              },
              url: "https://giphy.com/gifs/pick"
            }
          ]
        };
      }
    }),
    async () => {
      const result = await service.pickGif({
        query: "show me hype",
        trace: { guildId: "guild-1", channelId: "chan-1", userId: "user-1", source: "reply" }
      });
      assert.equal(result?.id, "pick-1");
    }
  );

  Math.random = originalRandom;

  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.kind, "gif_call");
  assert.equal(logs[0]?.guildId, "guild-1");
  assert.equal(logs[0]?.metadata?.used, true);
  assert.equal(logs[0]?.metadata?.gifUrl, "https://media.giphy.com/media/pick/giphy.gif");
});

test("pickGif logs errors from failed provider calls", async () => {
  const { service, logs } = createService();

  await withMockFetch(
    async () => ({
      ok: false,
      status: 503
    }),
    async () => {
      await assert.rejects(
        () => service.pickGif({ query: "something", trace: { source: "test-case" } }),
        /GIPHY HTTP 503/
      );
    }
  );

  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.kind, "gif_error");
  assert.equal(logs[0]?.metadata?.provider, "giphy");
  assert.equal(logs[0]?.metadata?.source, "test-case");
  assert.match(String(logs[0]?.content || ""), /503/);
});
