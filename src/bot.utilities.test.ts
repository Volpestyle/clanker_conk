import test from "node:test";
import assert from "node:assert/strict";
import { ClankerBot } from "./bot.ts";

function baseSettings(overrides = {}) {
  const base = {
    botName: "clanker conk",
    activity: {
      minSecondsBetweenMessages: 10
    },
    initiative: {
      maxImagesPerDay: 5,
      maxVideosPerDay: 3,
      maxGifsPerDay: 4,
      discovery: {
        enabled: true
      }
    },
    webSearch: {
      enabled: true,
      maxSearchesPerHour: 6
    },
    videoContext: {
      enabled: true,
      maxLookupsPerHour: 5
    },
    memory: {
      enabled: true
    },
    permissions: {
      allowedChannelIds: [],
      blockedChannelIds: [],
      initiativeChannelIds: []
    }
  };

  return {
    ...base,
    ...overrides,
    activity: {
      ...base.activity,
      ...(overrides.activity || {})
    },
    initiative: {
      ...base.initiative,
      ...(overrides.initiative || {}),
      discovery: {
        ...base.initiative.discovery,
        ...(overrides.initiative?.discovery || {})
      }
    },
    webSearch: {
      ...base.webSearch,
      ...(overrides.webSearch || {})
    },
    videoContext: {
      ...base.videoContext,
      ...(overrides.videoContext || {})
    },
    memory: {
      ...base.memory,
      ...(overrides.memory || {})
    },
    permissions: {
      ...base.permissions,
      ...(overrides.permissions || {})
    }
  };
}

function createBot({
  countByKind = {},
  llm = {},
  discovery = null,
  search = null,
  memory = null,
  video = null
} = {}) {
  const logs = [];
  const store = {
    countActionsSince(kind) {
      return Number(countByKind[kind] || 0);
    },
    logAction(entry) {
      logs.push(entry);
    },
    getSettings() {
      return baseSettings();
    }
  };

  const bot = new ClankerBot({
    appConfig: {},
    store,
    llm,
    memory,
    discovery,
    search,
    gifs: null,
    video
  });

  return { bot, logs, store };
}

test("ClankerBot message pacing and action budgets are enforced", () => {
  const nowMs = Date.parse("2026-02-27T22:00:00.000Z");
  const originalNow = Date.now;
  Date.now = () => nowMs;
  try {
    const { bot } = createBot({
      countByKind: {
        reacted: 1,
        sent_reply: 2,
        sent_message: 2,
        initiative_post: 1
      }
    });

    bot.lastBotMessageAt = nowMs - 9_000;
    assert.equal(bot.canTalkNow(baseSettings()), false);
    bot.lastBotMessageAt = nowMs - 11_000;
    assert.equal(bot.canTalkNow(baseSettings()), true);

    bot.markSpoke();
    assert.equal(bot.lastBotMessageAt, nowMs);
    assert.equal(bot.canTakeAction("reacted", 2), true);
    assert.equal(bot.canTakeAction("reacted", 1), false);
    assert.equal(bot.canSendMessage(6), true);
    assert.equal(bot.canSendMessage(5), false);
  } finally {
    Date.now = originalNow;
  }
});

test("ClankerBot media/search/video budgets and capability fallbacks", () => {
  const { bot } = createBot({
    countByKind: {
      image_call: 2,
      video_call: 3,
      gif_call: 1,
      search_call: 2,
      search_error: 1,
      video_context_call: 3,
      video_context_error: 1
    }
  });

  const settings = baseSettings();
  const imageBudget = bot.getImageBudgetState(settings);
  assert.deepEqual(imageBudget, {
    maxPerDay: 5,
    used: 2,
    remaining: 3,
    canGenerate: true
  });

  const videoBudget = bot.getVideoGenerationBudgetState(settings);
  assert.deepEqual(videoBudget, {
    maxPerDay: 3,
    used: 3,
    remaining: 0,
    canGenerate: false
  });

  const gifBudget = bot.getGifBudgetState(settings);
  assert.equal(gifBudget.remaining, 3);
  assert.equal(gifBudget.canFetch, true);

  const searchBudget = bot.getWebSearchBudgetState(settings);
  assert.equal(searchBudget.used, 3);
  assert.equal(searchBudget.remaining, 3);
  assert.equal(searchBudget.canSearch, true);

  const videoContextBudget = bot.getVideoContextBudgetState(settings);
  assert.equal(videoContextBudget.used, 4);
  assert.equal(videoContextBudget.remaining, 1);
  assert.equal(videoContextBudget.canLookup, true);

  assert.deepEqual(bot.getMediaGenerationCapabilities(settings), {
    simpleImageReady: false,
    complexImageReady: false,
    videoReady: false,
    simpleImageModel: null,
    complexImageModel: null,
    videoModel: null
  });
});

test("ClankerBot web/memory/image lookup context helpers behave deterministically", async () => {
  const { bot } = createBot({
    search: {
      isConfigured() {
        return true;
      }
    },
    memory: {
      async searchDurableFacts() {
        return [];
      }
    }
  });

  const web = bot.buildWebSearchContext(baseSettings(), "do not search this");
  assert.equal(web.configured, true);
  assert.equal(web.enabled, true);
  assert.equal(web.optedOutByUser, true);

  const memoryLookup = bot.buildMemoryLookupContext({
    settings: baseSettings({
      memory: {
        enabled: true
      }
    })
  });
  assert.equal(memoryLookup.enabled, true);

  const imageLookup = bot.buildImageLookupContext({
    recentMessages: [
      {
        message_id: "m1",
        author_name: "alice",
        created_at: "2026-02-27T20:00:00.000Z",
        content: "look https://cdn.example.com/cat.png and text"
      },
      {
        message_id: "m2",
        author_name: "bob",
        created_at: "2026-02-27T20:10:00.000Z",
        content: "duplicate https://cdn.example.com/cat.png"
      },
      {
        message_id: "m3",
        author_name: "chad",
        created_at: "2026-02-27T20:20:00.000Z",
        content: "jpeg https://cdn.example.com/dog.jpg"
      }
    ],
    excludedUrls: ["https://cdn.example.com/dog.jpg"]
  });
  assert.equal(imageLookup.candidates.length, 1);
  assert.equal(imageLookup.candidates[0]?.url, "https://cdn.example.com/cat.png");

  const ranked = bot.rankImageLookupCandidates({
    candidates: imageLookup.candidates,
    query: "show the cat picture again"
  });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.matchReason.includes("token"), true);

  const selected = await bot.runModelRequestedImageLookup({
    imageLookup,
    query: "cat"
  });
  assert.equal(selected.used, true);
  assert.equal(selected.selectedImageInputs.length, 1);

  const merged = bot.mergeImageInputs({
    baseInputs: [{ url: "https://a.example/x.png" }],
    extraInputs: [
      { url: "https://a.example/x.png" },
      { url: "https://a.example/y.png" }
    ],
    maxInputs: 3
  });
  assert.deepEqual(
    merged.map((item) => item.url),
    ["https://a.example/x.png", "https://a.example/y.png"]
  );
});

test("ClankerBot discovery link policy matches existing links or forces fallback links", () => {
  const { bot } = createBot();

  const matched = bot.applyDiscoveryLinkPolicy({
    text: "check this https://example.com/post?utm_source=abc",
    candidates: [
      {
        url: "https://example.com/post",
        source: "reddit"
      }
    ],
    selected: [],
    requireDiscoveryLink: true
  });
  assert.equal(matched.usedLinks.length, 1);
  assert.equal(matched.forcedLink, false);
  assert.equal(matched.usedLinks[0]?.source, "reddit");

  const forced = bot.applyDiscoveryLinkPolicy({
    text: "no link in model output",
    candidates: [],
    selected: [
      {
        url: "https://news.example.org/story",
        source: "rss"
      }
    ],
    requireDiscoveryLink: true
  });
  assert.equal(forced.forcedLink, true);
  assert.equal(forced.text.includes("https://news.example.org/story"), true);

  const skipped = bot.applyDiscoveryLinkPolicy({
    text: "still no links",
    candidates: [],
    selected: [],
    requireDiscoveryLink: true
  });
  assert.equal(skipped.text, "[SKIP]");
  assert.deepEqual(skipped.usedLinks, []);
});

test("ClankerBot collectDiscoveryForInitiative returns disabled or error payloads", async () => {
  const { bot, logs } = createBot({
    discovery: {
      async collect() {
        throw new Error("discovery offline");
      }
    }
  });

  const disabled = await bot.collectDiscoveryForInitiative({
    settings: baseSettings({
      initiative: {
        discovery: {
          enabled: false
        }
      }
    }),
    channel: {
      guildId: "guild-1",
      id: "chan-1",
      name: "general"
    },
    recentMessages: []
  });
  assert.equal(disabled.enabled, false);

  const failed = await bot.collectDiscoveryForInitiative({
    settings: baseSettings({
      initiative: {
        discovery: {
          enabled: true
        }
      }
    }),
    channel: {
      guildId: "guild-1",
      id: "chan-1",
      name: "general"
    },
    recentMessages: []
  });
  assert.equal(failed.enabled, true);
  assert.equal(failed.errors.length, 1);
  assert.equal(String(failed.errors[0]).includes("discovery offline"), true);
  assert.equal(logs.some((entry) => entry.kind === "bot_error"), true);
});

test("ClankerBot initiative channel picker uses channel allowlist checks", () => {
  const { bot } = createBot();
  const channels = new Map([
    [
      "chan-1",
      {
        id: "chan-1",
        isTextBased() {
          return true;
        },
        async send() {}
      }
    ],
    [
      "chan-2",
      {
        id: "chan-2",
        isTextBased() {
          return true;
        },
        async send() {}
      }
    ]
  ]);
  bot.client.channels = {
    cache: channels
  };

  const settings = baseSettings({
    permissions: {
      initiativeChannelIds: ["chan-1", "chan-2"],
      allowedChannelIds: ["chan-2"],
      blockedChannelIds: []
    }
  });

  const picked = bot.pickInitiativeChannel(settings);
  assert.equal(picked?.id, "chan-2");
});
