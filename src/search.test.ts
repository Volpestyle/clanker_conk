import test from "node:test";
import assert from "node:assert/strict";
import { WebSearchService, normalizeProviderOrder } from "./search.ts";

function createService() {
  const logs = [];
  const service = new WebSearchService({
    appConfig: {},
    store: {
      logAction(entry) {
        logs.push(entry);
      }
    }
  });
  return { service, logs };
}

test("normalizeProviderOrder dedupes values and falls back to defaults", () => {
  assert.deepEqual(normalizeProviderOrder(["SERPAPI", "brave", "serpapi", "unknown"]), [
    "serpapi",
    "brave"
  ]);
  assert.deepEqual(normalizeProviderOrder([]), ["brave", "serpapi"]);
  assert.deepEqual(normalizeProviderOrder(null), ["brave", "serpapi"]);
});

test("searchAndRead returns empty payload for blank query", async () => {
  const { service } = createService();
  const result = await service.searchAndRead({
    settings: {},
    query: "   "
  });

  assert.deepEqual(result, {
    query: "",
    results: [],
    fetchedPages: 0,
    providerUsed: null,
    providerFallbackUsed: false
  });
});

test("searchAndRead falls back to secondary provider and records successful reads", async () => {
  const { service, logs } = createService();
  service.providers = [
    {
      name: "brave",
      isConfigured() {
        return true;
      },
      async search() {
        throw new Error("primary offline");
      }
    },
    {
      name: "serpapi",
      isConfigured() {
        return true;
      },
      async search() {
        return {
          results: [
            {
              title: "Space story",
              url: "https://example.com/space",
              domain: "example.com",
              snippet: "space"
            }
          ]
        };
      }
    }
  ];
  service.readPageSummary = async () => ({
    title: "Space story",
    summary: "Readable summary",
    extractionMethod: "fast"
  });

  const result = await service.searchAndRead({
    settings: {
      webSearch: {
        maxResults: 3,
        maxPagesToRead: 1,
        providerOrder: ["brave", "serpapi"]
      }
    },
    query: "  space cats ",
    trace: {
      guildId: "guild-1",
      channelId: "chan-1",
      userId: "user-1",
      source: "test"
    }
  });

  assert.equal(result.query, "space cats");
  assert.equal(result.providerUsed, "serpapi");
  assert.equal(result.providerFallbackUsed, true);
  assert.equal(result.fetchedPages, 1);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.pageSummary, "Readable summary");
  assert.equal(logs.some((entry) => entry.kind === "search_call"), true);
  const callLog = logs.find((entry) => entry.kind === "search_call");
  assert.equal(callLog?.metadata?.fallbackUsed, true);
});

test("searchAndRead preserves results when page fetches fail and logs fetch-stage errors", async () => {
  const { service, logs } = createService();
  service.providers = [
    {
      name: "brave",
      isConfigured() {
        return true;
      },
      async search() {
        return {
          results: [
            {
              title: "A",
              url: "https://example.com/a",
              domain: "example.com",
              snippet: "a"
            }
          ]
        };
      }
    }
  ];

  service.readPageSummary = async () => {
    const error = new Error("page fetch blew up");
    error.attempts = 2;
    throw error;
  };

  const result = await service.searchAndRead({
    settings: {
      webSearch: {
        maxPagesToRead: 1
      }
    },
    query: "query"
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.pageSummary, null);
  assert.equal(result.results[0]?.pageError, "page fetch blew up");
  assert.equal(result.results[0]?.provider, "brave");
  assert.equal(result.fetchedPages, 0);
  assert.equal(
    logs.some((entry) => entry.kind === "search_error" && entry.metadata?.stage === "fetch"),
    true
  );
});

test("searchAndRead logs provider-stage errors and rethrows when search fails", async () => {
  const { service, logs } = createService();
  service.providers = [
    {
      name: "brave",
      isConfigured() {
        return true;
      },
      async search() {
        throw new Error("provider hard failure");
      }
    }
  ];

  await assert.rejects(
    () =>
      service.searchAndRead({
        settings: {
          webSearch: {
            providerOrder: ["brave"]
          }
        },
        query: "deep topic",
        trace: {
          guildId: "guild-1",
          channelId: "chan-2",
          userId: "user-9",
          source: "policy"
        }
      }),
    /provider hard failure/
  );

  assert.equal(
    logs.some((entry) => entry.kind === "search_error" && entry.metadata?.stage === "provider"),
    true
  );
});
