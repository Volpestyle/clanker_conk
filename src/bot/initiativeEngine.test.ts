import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Store } from "../store/store.ts";
import { normalizeSettings } from "../store/settingsNormalization.ts";
import { createTestSettingsPatch } from "../testSettings.ts";
import { getEligibleInitiativeChannelIds, maybeRunInitiativeCycle } from "./initiativeEngine.ts";

async function withTempStore(run: (store: Store) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-initiative-test-"));
  const dbPath = path.join(dir, "clanker.db");
  const store = new Store(dbPath);
  store.init();

  try {
    await run(store);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("getEligibleInitiativeChannelIds uses the canonical unified reply-channel pool", () => {
  const rawSettings: unknown = {
    permissions: {
      replies: {
        replyChannelIds: ["reply-1"]
      }
    },
    initiative: {
      discovery: {
        channelIds: ["disc-1"]
      }
    }
  };

  const settings = normalizeSettings(rawSettings);

  assert.deepEqual(getEligibleInitiativeChannelIds(settings), ["reply-1", "disc-1"]);
});

test("maybeRunInitiativeCycle starts the min-gap cooldown after an initiative skip", async () => {
  await withTempStore(async (store) => {
    const guildId = "guild-1";
    const channelId = "channel-1";
    const botUserId = "bot-1";
    const llmCalls: Array<Record<string, unknown>> = [];

    store.patchSettings(createTestSettingsPatch({
      permissions: {
        allowReplies: true,
        allowUnsolicitedReplies: true,
        allowReactions: false,
        replyChannelIds: [channelId],
        allowedChannelIds: [channelId],
        blockedChannelIds: [],
        blockedUserIds: [],
        maxMessagesPerHour: 100,
        maxReactionsPerHour: 0
      },
      memory: {
        enabled: false
      },
      textThoughtLoop: {
        enabled: true,
        eagerness: 100,
        minMinutesBetweenPosts: 60,
        maxPostsPerDay: 3,
        lookbackMessages: 12,
        allowActiveCuriosity: false,
        maxToolSteps: 0,
        maxToolCalls: 0
      }
    }));

    store.recordMessage({
      messageId: "msg-1",
      createdAt: Date.now() - 1_000,
      guildId,
      channelId,
      authorId: "user-1",
      authorName: "alice",
      isBot: false,
      content: "anyone have a strong take on proton mail",
      referencedMessageId: null
    });

    const channel = {
      id: channelId,
      guildId,
      name: "general",
      guild: {
        id: guildId
      },
      isTextBased() {
        return true;
      },
      async sendTyping() {
        return true;
      },
      async send() {
        throw new Error("initiative skip should not send a message");
      }
    };

    const runtime = {
      appConfig: { env: "test" },
      store,
      llm: {
        async generate(payload: Record<string, unknown>) {
          llmCalls.push(payload);
          return {
            text: JSON.stringify({
              skip: true,
              reason: "too quiet to jump in naturally"
            }),
            toolCalls: [],
            rawContent: null,
            provider: "test",
            model: "test-model",
            usage: {
              inputTokens: 0,
              outputTokens: 0
            }
          };
        }
      },
      memory: {},
      client: {
        user: {
          id: botUserId,
          username: "clanker conk"
        },
        guilds: {
          cache: new Map()
        },
        channels: {
          cache: {
            get(id: string) {
              return id === channelId ? channel : undefined;
            }
          }
        }
      },
      botUserId,
      discovery: null,
      search: null,
      initiativeCycleRunning: false,
      canSendMessage() {
        return true;
      },
      canTalkNow() {
        return true;
      },
      async hydrateRecentMessages() {
        return [];
      },
      isChannelAllowed() {
        return true;
      },
      isNonPrivateReplyEligibleChannel() {
        return true;
      },
      getSimulatedTypingDelayMs() {
        return 0;
      },
      markSpoke() {},
      composeMessageContentForHistory() {
        return "";
      },
      async loadRelevantMemoryFacts() {
        return [];
      },
      buildMediaMemoryFacts() {
        return [];
      },
      getImageBudgetState() {
        return { canGenerate: false, remaining: 0 };
      },
      getVideoGenerationBudgetState() {
        return { canGenerate: false, remaining: 0 };
      },
      getGifBudgetState() {
        return { canFetch: false, remaining: 0 };
      },
      getMediaGenerationCapabilities() {
        return {
          simpleImageReady: false,
          complexImageReady: false,
          videoReady: false
        };
      },
      async resolveMediaAttachment() {
        throw new Error("initiative skip should not resolve media");
      },
      buildBrowserBrowseContext() {
        return {
          enabled: false,
          configured: false,
          budget: {
            canBrowse: false
          }
        };
      },
      async runModelRequestedBrowserBrowse() {
        return {
          used: false,
          text: "",
          steps: 0,
          hitStepLimit: false,
          error: null,
          blockedByBudget: false
        };
      }
    } as Parameters<typeof maybeRunInitiativeCycle>[0];

    await maybeRunInitiativeCycle(runtime);
    assert.equal(llmCalls.length, 1);

    const since = new Date(Date.now() - 5 * 60_000).toISOString();
    assert.equal(store.countActionsSince("initiative_skip", since), 1);

    await maybeRunInitiativeCycle(runtime);
    assert.equal(llmCalls.length, 1);
    assert.equal(store.countActionsSince("initiative_skip", since), 1);
  });
});
