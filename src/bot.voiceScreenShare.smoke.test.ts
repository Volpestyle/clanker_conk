import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClankerBot } from "./bot.ts";
import { Store } from "./store.ts";

async function withTempStore(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-voice-screen-share-smoke-"));
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

test("smoke: voice generation runtime wires screen-share capability hooks", async () => {
  await withTempStore(async (store) => {
    const generationPayloads = [];
    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload) {
          generationPayloads.push(payload);
          return {
            text: JSON.stringify({
              text: "bet send it",
              skip: false,
              reactionEmoji: null,
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              imageLookupQuery: null,
              openArticleRef: null,
              memoryLine: null,
              selfMemoryLine: null,
              soundboardRefs: [],
              leaveVoiceChannel: false,
              automationAction: {
                operation: "none",
                title: null,
                instruction: null,
                schedule: null,
                targetQuery: null,
                automationId: null,
                runImmediately: false,
                targetChannelId: null
              },
              voiceIntent: {
                intent: "none",
                confidence: 0,
                reason: null
              },
              screenShareIntent: {
                action: "offer_link",
                confidence: 0.95,
                reason: "speaker asked to share screen"
              }
            })
          };
        }
      },
      memory: null,
      discovery: null,
      search: null,
      gifs: null,
      video: null
    });

    const guildId = "guild-1";
    const channelId = "text-1";
    const userId = "user-1";
    bot.client.user = {
      id: "bot-1",
      username: "clanker conk",
      tag: "clanker conk#0001"
    };
    bot.client.guilds = {
      cache: new Map([
        [
          guildId,
          {
            members: {
              cache: new Map([
                [
                  userId,
                  {
                    displayName: "alice",
                    user: { username: "alice_user" }
                  }
                ]
              ])
            }
          }
        ]
      ])
    };
    bot.client.users = {
      cache: new Map()
    };

    let capabilityCalls = 0;
    const offerCalls = [];
    bot.getVoiceScreenShareCapability = () => {
      capabilityCalls += 1;
      return {
        supported: true,
        enabled: true,
        available: true,
        status: "ready",
        publicUrl: "https://demo.trycloudflare.com",
        reason: null
      };
    };
    bot.offerVoiceScreenShareLink = async (payload) => {
      offerCalls.push(payload);
      return {
        offered: true,
        reason: "offered"
      };
    };

    store.patchSettings({
      voice: {
        enabled: true
      },
      memory: {
        enabled: false
      },
      webSearch: {
        enabled: false
      }
    });

    const reply = await bot.generateVoiceTurnReply({
      settings: store.getSettings(),
      guildId,
      channelId,
      userId,
      transcript: "can you check my screen?"
    });

    assert.equal(reply.text, "bet send it");
    assert.equal(reply.usedScreenShareOffer, true);
    assert.equal(capabilityCalls > 0, true);
    assert.equal(offerCalls.length, 1);
    assert.equal(offerCalls[0]?.guildId, guildId);
    assert.equal(offerCalls[0]?.channelId, channelId);
    assert.equal(offerCalls[0]?.requesterUserId, userId);
    assert.equal(generationPayloads.length > 0, true);
    assert.equal(
      String(generationPayloads[0]?.userPrompt || "").includes("VC screen-share link offers are available."),
      true
    );
  });
});
