import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  invalidateSessionBehavioralMemoryCache,
  loadSessionBehavioralMemoryFacts,
  loadSessionConversationHistory
} from "./voiceSessionMemoryCache.ts";
import type { MemoryFactRow } from "../store/storeMemory.ts";

type TestSession = {
  behavioralFactCache?: {
    guildId: string;
    participantKey: string;
    loadedAt: number;
    facts: MemoryFactRow[];
  } | null;
  conversationHistoryCaches?: Record<string, {
    strategy: "lexical" | "semantic";
    guildId: string;
    channelId: string | null;
    queryText: string;
    queryTokens: string[];
    limit: number;
    maxAgeHours: number;
    loadedAt: number;
    windows: unknown[];
  } | null> | null;
};

function buildFactRow({
  id,
  subject,
  fact,
  channelId = null,
  confidence = 0.9
}: {
  id: number;
  subject: string;
  fact: string;
  channelId?: string | null;
  confidence?: number;
}): MemoryFactRow {
  return {
    id,
    created_at: "2026-03-01T12:00:00.000Z",
    updated_at: "2026-03-01T12:00:00.000Z",
    guild_id: "guild-1",
    channel_id: channelId,
    subject,
    fact,
    fact_type: "behavioral",
    evidence_text: null,
    source_message_id: `msg-${id}`,
    confidence
  };
}

test("loadSessionBehavioralMemoryFacts caches the session fact pool and invalidates cleanly", async () => {
  let searchCalls = 0;
  const session: TestSession = {};
  const rows = [
    buildFactRow({
      id: 1,
      subject: "user-1",
      fact: "Always greet James in Spanish."
    }),
    buildFactRow({
      id: 2,
      subject: "__lore__",
      fact: "Send a GIF when someone says what the heli."
    })
  ];

  const searchDurableFacts = async ({ queryText }: { queryText: string }) => {
    searchCalls += 1;
    assert.equal(queryText, "__ALL__");
    return rows;
  };

  const first = await loadSessionBehavioralMemoryFacts({
    session,
    searchDurableFacts,
    guildId: "guild-1",
    channelId: "text-1",
    queryText: "please greet james in spanish",
    participantIds: ["user-1"],
    limit: 8
  });
  assert.equal(searchCalls, 1);
  assert.equal(first?.length, 1);
  assert.equal(first?.[0]?.fact, "Always greet James in Spanish.");

  const second = await loadSessionBehavioralMemoryFacts({
    session,
    searchDurableFacts,
    guildId: "guild-1",
    channelId: "text-1",
    queryText: "what the heli just happened",
    participantIds: ["user-1"],
    limit: 8
  });
  assert.equal(searchCalls, 1);
  assert.equal(second?.length, 1);
  assert.equal(second?.[0]?.fact, "Send a GIF when someone says what the heli.");

  await loadSessionBehavioralMemoryFacts({
    session,
    searchDurableFacts,
    guildId: "guild-1",
    channelId: "text-1",
    queryText: "please greet james in spanish",
    participantIds: ["user-1", "user-2"],
    limit: 8
  });
  assert.equal(searchCalls, 2);

  invalidateSessionBehavioralMemoryCache(session);

  await loadSessionBehavioralMemoryFacts({
    session,
    searchDurableFacts,
    guildId: "guild-1",
    channelId: "text-1",
    queryText: "please greet james in spanish",
    participantIds: ["user-1", "user-2"],
    limit: 8
  });
  assert.equal(searchCalls, 3);
});

test("loadSessionBehavioralMemoryFacts uses a custom ranker over the cached pool when available", async () => {
  let searchCalls = 0;
  let rankCalls = 0;
  const session: TestSession = {};
  const rows = [
    buildFactRow({
      id: 1,
      subject: "user-1",
      fact: "Always greet James in Spanish."
    }),
    buildFactRow({
      id: 2,
      subject: "__lore__",
      fact: "Send a GIF when someone says what the heli."
    })
  ];

  const ranked = await loadSessionBehavioralMemoryFacts({
    session,
    searchDurableFacts: async () => {
      searchCalls += 1;
      return rows;
    },
    rankBehavioralFacts: async ({ queryText }) => {
      rankCalls += 1;
      return queryText.includes("heli") ? [rows[1]] : [];
    },
    guildId: "guild-1",
    channelId: "text-1",
    queryText: "what the heli just happened",
    participantIds: ["user-1"],
    limit: 8
  });

  assert.equal(searchCalls, 1);
  assert.equal(rankCalls, 1);
  assert.equal(ranked?.length, 1);
  assert.equal(ranked?.[0]?.fact, "Send a GIF when someone says what the heli.");
});

test("loadSessionBehavioralMemoryFacts falls back to lexical reranking when semantic ranking is unavailable", async () => {
  const rows = [
    buildFactRow({
      id: 1,
      subject: "user-1",
      fact: "Always greet James in Spanish."
    }),
    buildFactRow({
      id: 2,
      subject: "__lore__",
      fact: "Send a GIF when someone says what the heli."
    })
  ];

  const ranked = await loadSessionBehavioralMemoryFacts({
    session: {},
    searchDurableFacts: async () => rows,
    rankBehavioralFacts: async () => null,
    guildId: "guild-1",
    channelId: "text-1",
    queryText: "please greet james in spanish",
    participantIds: ["user-1"],
    limit: 8
  });

  assert.equal(ranked?.length, 1);
  assert.equal(ranked?.[0]?.fact, "Always greet James in Spanish.");
});

test("loadSessionConversationHistory keeps lexical and semantic caches separate", async () => {
  let historyCalls = 0;
  const session: TestSession = {};

  const loadRecentConversationHistory = async ({ queryText }: { queryText: string }) => {
    historyCalls += 1;
    return [{ queryText, historyCalls }];
  };

  const lexical = await loadSessionConversationHistory({
    session,
    loadRecentConversationHistory,
    strategy: "lexical",
    guildId: "guild-1",
    channelId: "text-1",
    queryText: "rust ownership rules",
    limit: 4,
    maxAgeHours: 24
  });
  assert.equal(historyCalls, 1);
  assert.equal(Array.isArray(lexical), true);

  const semantic = await loadSessionConversationHistory({
    session,
    loadRecentConversationHistory,
    strategy: "semantic",
    guildId: "guild-1",
    channelId: "text-1",
    queryText: "rust ownership rules",
    limit: 4,
    maxAgeHours: 24
  });
  assert.equal(historyCalls, 2);
  assert.notDeepEqual(semantic, lexical);
});

test("loadSessionConversationHistory reuses recent similar and low-signal queries before expiring", async () => {
  let historyCalls = 0;
  const session: TestSession = {};

  const loadRecentConversationHistory = async ({ queryText }: { queryText: string }) => {
    historyCalls += 1;
    return [{ queryText, historyCalls }];
  };

  const first = await loadSessionConversationHistory({
    session,
    loadRecentConversationHistory,
    strategy: "semantic",
    guildId: "guild-1",
    channelId: "text-1",
    queryText: "rust ownership rules",
    limit: 4,
    maxAgeHours: 24
  });
  assert.equal(historyCalls, 1);
  assert.equal(Array.isArray(first), true);

  const similar = await loadSessionConversationHistory({
    session,
    loadRecentConversationHistory,
    strategy: "semantic",
    guildId: "guild-1",
    channelId: "text-1",
    queryText: "rust ownership borrow rules",
    limit: 4,
    maxAgeHours: 24
  });
  assert.equal(historyCalls, 1);
  assert.deepEqual(similar, first);

  const lowSignal = await loadSessionConversationHistory({
    session,
    loadRecentConversationHistory,
    strategy: "semantic",
    guildId: "guild-1",
    channelId: "text-1",
    queryText: "exactly",
    limit: 4,
    maxAgeHours: 24
  });
  assert.equal(historyCalls, 1);
  assert.deepEqual(lowSignal, first);

  const different = await loadSessionConversationHistory({
    session,
    loadRecentConversationHistory,
    strategy: "semantic",
    guildId: "guild-1",
    channelId: "text-1",
    queryText: "music volume keeps clipping",
    limit: 4,
    maxAgeHours: 24
  });
  assert.equal(historyCalls, 2);
  assert.notDeepEqual(different, first);

  session.conversationHistoryCaches = {
    ...(session.conversationHistoryCaches || {}),
    semantic: {
      ...(session.conversationHistoryCaches?.semantic || {
        strategy: "semantic" as const,
        guildId: "guild-1",
        channelId: "text-1",
        queryText: "music volume keeps clipping",
        queryTokens: ["music", "volume", "keeps", "clipping"],
        limit: 4,
        maxAgeHours: 24,
        windows: different
      }),
      strategy: "semantic",
      loadedAt: Date.now() - 60_000
    }
  };
  await loadSessionConversationHistory({
    session,
    loadRecentConversationHistory,
    strategy: "semantic",
    guildId: "guild-1",
    channelId: "text-1",
    queryText: "music volume clipping again",
    limit: 4,
    maxAgeHours: 24
  });
  assert.equal(historyCalls, 3);
});

test("loadSessionConversationHistory skips fresh retrieval for low-signal turns when no cache exists", async () => {
  let historyCalls = 0;

  const result = await loadSessionConversationHistory({
    session: {},
    loadRecentConversationHistory: async () => {
      historyCalls += 1;
      return [{ historyCalls }];
    },
    strategy: "semantic",
    guildId: "guild-1",
    channelId: "text-1",
    queryText: "yeah",
    limit: 4,
    maxAgeHours: 24
  });

  assert.equal(historyCalls, 0);
  assert.deepEqual(result, []);
});

test("loadSessionConversationHistory still retrieves meaningful one-word queries", async () => {
  let historyCalls = 0;

  await loadSessionConversationHistory({
    session: {},
    loadRecentConversationHistory: async () => {
      historyCalls += 1;
      return [{ historyCalls }];
    },
    strategy: "semantic",
    guildId: "guild-1",
    channelId: "text-1",
    queryText: "pause",
    limit: 4,
    maxAgeHours: 24
  });

  assert.equal(historyCalls, 1);
});
