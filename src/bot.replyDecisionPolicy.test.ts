import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { ClankerBot } from "./bot.ts";
import { Store } from "./store.ts";

async function withTempStore(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-bot-reply-policy-test-"));
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

function buildGuild() {
  return {
    id: "guild-1",
    emojis: {
      cache: {
        map() {
          return [];
        }
      }
    },
    members: {
      cache: new Map()
    }
  };
}

function buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef }) {
  return {
    id: channelId,
    guildId: guild.id,
    name: "general",
    guild,
    isTextBased() {
      return true;
    },
    async sendTyping() {
      typingCallsRef.count += 1;
    },
    async send(payload) {
      channelSendPayloads.push(payload);
      return {
        id: `standalone-${Date.now()}`,
        createdTimestamp: Date.now(),
        guildId: guild.id,
        channelId,
        content: String(payload?.content || ""),
        attachments: new Map(),
        embeds: []
      };
    }
  };
}

function buildIncomingMessage({
  guild,
  channel,
  messageId,
  content,
  replyPayloads
}) {
  return {
    id: messageId,
    createdTimestamp: Date.now(),
    guildId: guild.id,
    channelId: channel.id,
    guild,
    channel,
    author: {
      id: "user-1",
      username: "alice",
      bot: false
    },
    member: {
      displayName: "alice"
    },
    content,
    mentions: {
      users: {
        has() {
          return false;
        }
      },
      repliedUser: null
    },
    reference: null,
    attachments: new Map(),
    embeds: [],
    reactions: {
      cache: new Map()
    },
    async react() {
      return undefined;
    },
    async reply(payload) {
      replyPayloads.push(payload);
      return {
        id: `reply-${Date.now()}`,
        createdTimestamp: Date.now(),
        guildId: guild.id,
        channelId: channel.id,
        content: String(payload?.content || ""),
        attachments: new Map(),
        embeds: []
      };
    }
  };
}

function applyBaselineSettings(store, channelId) {
  store.patchSettings({
    activity: {
      replyLevelInitiative: 65,
      replyLevelNonInitiative: 10,
      reactionLevel: 20,
      minSecondsBetweenMessages: 5,
      replyCoalesceWindowSeconds: 0,
      replyCoalesceMaxMessages: 1
    },
    permissions: {
      allowReplies: true,
      allowInitiativeReplies: true,
      allowReactions: true,
      initiativeChannelIds: [],
      allowedChannelIds: [channelId],
      blockedChannelIds: [],
      blockedUserIds: [],
      maxMessagesPerHour: 120,
      maxReactionsPerHour: 120
    },
    memory: {
      enabled: false,
      maxRecentMessages: 12
    },
    webSearch: {
      enabled: false,
      maxSearchesPerHour: 0
    },
    videoContext: {
      enabled: false,
      maxLookupsPerHour: 0
    },
    initiative: {
      enabled: false,
      allowReplyImages: false,
      allowReplyVideos: false,
      allowReplyGifs: false
    }
  });
}

test("non-addressed non-initiative turn can still post when model contributes value", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);

    const llmCalls = [];
    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload) {
          llmCalls.push(payload);
          return {
            text: JSON.stringify({
              text: "evo lines decide everything ngl, base forms are only first impressions",
              skip: false,
              reactionEmoji: null,
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              memoryLine: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "none", confidence: 0, reason: null },
              screenShareIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
      memory: null,
      discovery: null,
      search: null,
      gifs: null,
      video: null
    });

    bot.client.user = {
      id: "bot-1",
      username: "clanker conk",
      tag: "clanker conk#0001"
    };

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });

    store.recordMessage({
      messageId: "bot-context-1",
      createdAt: Date.now() - 750,
      guildId: guild.id,
      channelId,
      authorId: "bot-1",
      authorName: "clanker conk",
      isBot: true,
      content: "last bot line",
      referencedMessageId: null
    });

    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-1",
      content: "pokemon starter takes are all over the place rn",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(channelId, settings.memory.maxRecentMessages);
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      recentMessages,
      addressSignal: {
        direct: false,
        inferred: false,
        triggered: false,
        reason: "llm_decides"
      }
    });

    assert.equal(sent, true);
    assert.equal(replyPayloads.length, 0);
    assert.equal(channelSendPayloads.length, 1);
    assert.equal(typingCallsRef.count > 0, true);
    assert.match(String(channelSendPayloads[0]?.content || ""), /evo lines decide everything/i);

    const llmPrompt = String(llmCalls[0]?.userPrompt || "");
    assert.match(llmPrompt, /Reply eagerness hint: 10\/100\./);
    assert.match(llmPrompt, /soft threshold/i);
    assert.match(llmPrompt, /Higher eagerness means lower contribution threshold; lower eagerness means higher threshold\./);
  });
});

test("non-addressed non-initiative turn is skipped when model declines", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);

    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate() {
          return {
            text: JSON.stringify({
              text: "[SKIP]",
              skip: true,
              reactionEmoji: null,
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              memoryLine: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "none", confidence: 0, reason: null },
              screenShareIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
      memory: null,
      discovery: null,
      search: null,
      gifs: null,
      video: null
    });

    bot.client.user = {
      id: "bot-1",
      username: "clanker conk",
      tag: "clanker conk#0001"
    };

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });

    store.recordMessage({
      messageId: "bot-context-1",
      createdAt: Date.now() - 750,
      guildId: guild.id,
      channelId,
      authorId: "bot-1",
      authorName: "clanker conk",
      isBot: true,
      content: "last bot line",
      referencedMessageId: null
    });

    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-2",
      content: "random side chatter between people",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(channelId, settings.memory.maxRecentMessages);
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      recentMessages,
      addressSignal: {
        direct: false,
        inferred: false,
        triggered: false,
        reason: "llm_decides"
      }
    });

    assert.equal(sent, false);
    assert.equal(replyPayloads.length, 0);
    assert.equal(channelSendPayloads.length, 0);

    const recentActions = store.getRecentActions(12);
    const skipped = recentActions.find(
      (row) => row.kind === "reply_skipped" && row.message_id === "msg-2"
    );
    assert.equal(Boolean(skipped), true);
    assert.equal(skipped?.content, "llm_skip");
  });
});

test("non-addressed turn is dropped before llm when unsolicited gate is closed", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);

    const llmCalls = [];
    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload) {
          llmCalls.push(payload);
          return {
            text: JSON.stringify({
              text: "this should never be used",
              skip: false,
              reactionEmoji: null,
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              memoryLine: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "none", confidence: 0, reason: null },
              screenShareIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
      memory: null,
      discovery: null,
      search: null,
      gifs: null,
      video: null
    });

    bot.client.user = {
      id: "bot-1",
      username: "clanker conk",
      tag: "clanker conk#0001"
    };

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-gated",
      content: "this should stay between humans",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(channelId, settings.memory.maxRecentMessages);
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      recentMessages,
      addressSignal: {
        direct: false,
        inferred: false,
        triggered: false,
        reason: "llm_decides"
      }
    });

    assert.equal(sent, false);
    assert.equal(llmCalls.length, 0);
    assert.equal(replyPayloads.length, 0);
    assert.equal(channelSendPayloads.length, 0);
    assert.equal(typingCallsRef.count, 0);
  });
});

test("direct-addressed turn bypasses unsolicited gate and marks response as required", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      permissions: {
        allowInitiativeReplies: false
      }
    });

    const llmCalls = [];
    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload) {
          llmCalls.push(payload);
          return {
            text: JSON.stringify({
              text: "yeah i'm here, what's up",
              skip: false,
              reactionEmoji: null,
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              memoryLine: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "none", confidence: 0, reason: null },
              screenShareIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
      memory: null,
      discovery: null,
      search: null,
      gifs: null,
      video: null
    });

    bot.client.user = {
      id: "bot-1",
      username: "clanker conk",
      tag: "clanker conk#0001"
    };

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-direct",
      content: "clanker conk you there?",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(channelId, settings.memory.maxRecentMessages);
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      forceRespond: true,
      recentMessages,
      addressSignal: {
        direct: true,
        inferred: false,
        triggered: true,
        reason: "direct"
      }
    });

    assert.equal(sent, true);
    assert.equal(llmCalls.length, 1);
    assert.equal(replyPayloads.length, 1);
    assert.equal(channelSendPayloads.length, 0);
    assert.equal(typingCallsRef.count > 0, true);

    const llmPrompt = String(llmCalls[0]?.userPrompt || "");
    assert.match(llmPrompt, /This message directly addressed you\./);
    assert.match(llmPrompt, /A reply is required for this turn unless safety policy requires refusing\./);
    assert.match(llmPrompt, /Do not output \[SKIP\] except for safety refusals\./);
  });
});

test("reply follow-up regeneration can use dedicated provider/model override", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      llm: {
        provider: "openai",
        model: "gpt-4.1-mini"
      },
      replyFollowupLlm: {
        enabled: true,
        provider: "anthropic",
        model: "claude-haiku-4-5"
      }
    });

    const llmCalls = [];
    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload) {
          llmCalls.push(payload);
          if (llmCalls.length === 1) {
            return {
              text: JSON.stringify({
                text: "checking memory rq",
                skip: false,
                reactionEmoji: null,
                media: null,
                webSearchQuery: null,
                memoryLookupQuery: "starter opinions",
                memoryLine: null,
                automationAction: { operation: "none" },
                voiceIntent: { intent: "none", confidence: 0, reason: null },
                screenShareIntent: { action: "none", confidence: 0, reason: null }
              }),
              provider: "test",
              model: "test-model",
              usage: null,
              costUsd: 0
            };
          }
          return {
            text: JSON.stringify({
              text: "still think evo lines decide everything",
              skip: false,
              reactionEmoji: null,
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              memoryLine: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "none", confidence: 0, reason: null },
              screenShareIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
      memory: null,
      discovery: null,
      search: null,
      gifs: null,
      video: null
    });

    bot.client.user = {
      id: "bot-1",
      username: "clanker conk",
      tag: "clanker conk#0001"
    };

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    store.recordMessage({
      messageId: "bot-context-1",
      createdAt: Date.now() - 750,
      guildId: guild.id,
      channelId,
      authorId: "bot-1",
      authorName: "clanker conk",
      isBot: true,
      content: "last bot line",
      referencedMessageId: null
    });
    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-followup-override",
      content: "starter takes still chaotic",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(channelId, settings.memory.maxRecentMessages);
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      recentMessages,
      addressSignal: {
        direct: false,
        inferred: false,
        triggered: false,
        reason: "llm_decides"
      }
    });

    assert.equal(sent, true);
    assert.equal(replyPayloads.length, 0);
    assert.equal(channelSendPayloads.length, 1);
    assert.equal(llmCalls.length, 2);
    assert.equal(llmCalls[0]?.settings?.llm?.provider, "openai");
    assert.equal(llmCalls[0]?.settings?.llm?.model, "gpt-4.1-mini");
    assert.equal(llmCalls[1]?.settings?.llm?.provider, "anthropic");
    assert.equal(llmCalls[1]?.settings?.llm?.model, "claude-haiku-4-5");
  });
});

test("reply follow-up regeneration can add history images when model requests image lookup", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      activity: {
        replyLevelNonInitiative: 100
      }
    });

    const llmCalls = [];
    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload) {
          llmCalls.push(payload);
          if (llmCalls.length === 1) {
            return {
              text: JSON.stringify({
                text: "lemme check that image rq",
                skip: false,
                reactionEmoji: null,
                media: null,
                webSearchQuery: null,
                memoryLookupQuery: null,
                imageLookupQuery: "that dog starter photo",
                memoryLine: null,
                automationAction: { operation: "none" },
                voiceIntent: { intent: "none", confidence: 0, reason: null },
                screenShareIntent: { action: "none", confidence: 0, reason: null }
              }),
              provider: "test",
              model: "test-model",
              usage: null,
              costUsd: 0
            };
          }

          return {
            text: JSON.stringify({
              text: "that one was the dog starter image",
              skip: false,
              reactionEmoji: null,
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              imageLookupQuery: null,
              memoryLine: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "none", confidence: 0, reason: null },
              screenShareIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
      memory: null,
      discovery: null,
      search: null,
      gifs: null,
      video: null
    });

    bot.client.user = {
      id: "bot-1",
      username: "clanker conk",
      tag: "clanker conk#0001"
    };

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    store.recordMessage({
      messageId: "img-context-1",
      createdAt: Date.now() - 3_000,
      guildId: guild.id,
      channelId,
      authorId: "user-2",
      authorName: "smelly conk",
      isBot: false,
      content:
        "https://cdn.discordapp.com/attachments/chan-1/9001/starter-dog.jpg?ex=69a358b6&is=69a20736&hm=abc",
      referencedMessageId: null
    });

    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-image-lookup",
      content: "my bad, what is the photo referencing?",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(channelId, settings.memory.maxRecentMessages);
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      forceRespond: true,
      recentMessages,
      addressSignal: {
        direct: false,
        inferred: false,
        triggered: false,
        reason: "llm_decides"
      }
    });

    assert.equal(sent, true);
    assert.equal(replyPayloads.length, 1);
    assert.equal(channelSendPayloads.length, 0);
    assert.equal(llmCalls.length, 2);
    assert.equal(Array.isArray(llmCalls[0]?.imageInputs) ? llmCalls[0].imageInputs.length : 0, 0);
    assert.equal(Array.isArray(llmCalls[1]?.imageInputs), true);
    assert.equal(llmCalls[1]?.imageInputs?.length || 0, 1);
    assert.match(String(llmCalls[1]?.imageInputs?.[0]?.url || ""), /starter-dog\.jpg/i);
  });
});

test("voice intent handoff routes join requests to voice session manager instead of sending text", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      voice: {
        enabled: true,
        intentConfidenceThreshold: 0.75
      }
    });

    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };
    let joinCall = null;

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate() {
          return {
            text: JSON.stringify({
              text: "bet hopping in",
              skip: false,
              reactionEmoji: null,
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              memoryLine: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "join", confidence: 0.92, reason: "explicit join request" },
              screenShareIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
      memory: null,
      discovery: null,
      search: null,
      gifs: null,
      video: null
    });

    bot.client.user = {
      id: "bot-1",
      username: "clanker conk",
      tag: "clanker conk#0001"
    };
    bot.voiceSessionManager.requestJoin = async (payload) => {
      joinCall = payload;
      return true;
    };

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-voice-join",
      content: "clanker join vc",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(channelId, settings.memory.maxRecentMessages);
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      forceRespond: true,
      recentMessages,
      addressSignal: {
        direct: true,
        inferred: false,
        triggered: true,
        reason: "direct"
      }
    });

    assert.equal(sent, true);
    assert.equal(Boolean(joinCall), true);
    assert.equal(joinCall?.intentConfidence, 0.92);
    assert.equal(replyPayloads.length, 0);
    assert.equal(channelSendPayloads.length, 0);
    assert.equal(typingCallsRef.count, 0);

    const intentEvent = store
      .getRecentActions(20)
      .find((row) => row.kind === "voice_intent_detected" && row.message_id === "msg-voice-join");
    assert.equal(Boolean(intentEvent), true);
    assert.equal(intentEvent?.content, "join");
  });
});

test("voice intent below confidence threshold falls back to normal text reply path", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      voice: {
        enabled: true,
        intentConfidenceThreshold: 0.9
      }
    });

    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };
    let joinCallCount = 0;

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate() {
          return {
            text: JSON.stringify({
              text: "yo say less",
              skip: false,
              reactionEmoji: null,
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              memoryLine: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "join", confidence: 0.5, reason: "weak intent guess" },
              screenShareIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
      memory: null,
      discovery: null,
      search: null,
      gifs: null,
      video: null
    });

    bot.client.user = {
      id: "bot-1",
      username: "clanker conk",
      tag: "clanker conk#0001"
    };
    bot.voiceSessionManager.requestJoin = async () => {
      joinCallCount += 1;
      return true;
    };

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-voice-low-confidence",
      content: "clanker join vc maybe?",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(channelId, settings.memory.maxRecentMessages);
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      forceRespond: true,
      recentMessages,
      addressSignal: {
        direct: true,
        inferred: false,
        triggered: true,
        reason: "direct"
      }
    });

    assert.equal(sent, true);
    assert.equal(joinCallCount, 0);
    assert.equal(replyPayloads.length, 1);
    assert.equal(channelSendPayloads.length, 0);
    assert.equal(typingCallsRef.count > 0, true);
  });
});

test("voice intent dispatcher routes all supported intents to voice session manager handlers", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      voice: {
        enabled: true,
        intentConfidenceThreshold: 0.75
      }
    });

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate() {
          return {
            text: "",
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
      memory: null,
      discovery: null,
      search: null,
      gifs: null,
      video: null
    });

    bot.client.user = {
      id: "bot-1",
      username: "clanker conk",
      tag: "clanker conk#0001"
    };

    const called = [];
    bot.voiceSessionManager.requestJoin = async () => {
      called.push("join");
      return true;
    };
    bot.voiceSessionManager.requestLeave = async () => {
      called.push("leave");
      return true;
    };
    bot.voiceSessionManager.requestStatus = async () => {
      called.push("status");
      return true;
    };
    bot.voiceSessionManager.requestWatchStream = async () => {
      called.push("watch_stream");
      return true;
    };
    bot.voiceSessionManager.requestStopWatchingStream = async () => {
      called.push("stop_watching_stream");
      return true;
    };
    bot.voiceSessionManager.requestStreamWatchStatus = async () => {
      called.push("stream_status");
      return true;
    };

    const message = {
      id: "msg-intent-dispatch",
      guildId: "guild-1",
      channelId,
      author: { id: "user-1", username: "alice" },
      member: { displayName: "alice" }
    };
    const settings = store.getSettings();
    const intents = [
      "join",
      "leave",
      "status",
      "watch_stream",
      "stop_watching_stream",
      "stream_status"
    ];

    for (const intent of intents) {
      const handled = await bot.maybeHandleStructuredVoiceIntent({
        message,
        settings,
        replyDirective: {
          voiceIntent: {
            intent,
            confidence: 0.99,
            reason: "explicit command"
          }
        }
      });
      assert.equal(handled, true);
    }

    assert.deepEqual(called, intents);
  });
});

test("initiative-channel direct turns can be routed to thread replies when policy chooses reply mode", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      permissions: {
        initiativeChannelIds: [channelId]
      }
    });

    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate() {
          return {
            text: JSON.stringify({
              text: "threaded response",
              skip: false,
              reactionEmoji: null,
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              memoryLine: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "none", confidence: 0, reason: null },
              screenShareIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
      memory: null,
      discovery: null,
      search: null,
      gifs: null,
      video: null
    });

    bot.client.user = {
      id: "bot-1",
      username: "clanker conk",
      tag: "clanker conk#0001"
    };
    bot.shouldSendAsReply = () => true;

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-initiative-threaded",
      content: "clanker respond in thread",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(channelId, settings.memory.maxRecentMessages);
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      forceRespond: true,
      recentMessages,
      addressSignal: {
        direct: true,
        inferred: false,
        triggered: true,
        reason: "direct"
      }
    });

    assert.equal(sent, true);
    assert.equal(replyPayloads.length, 1);
    assert.equal(channelSendPayloads.length, 0);
  });
});

test("initiative-channel direct turns can be routed to standalone channel messages when policy chooses standalone mode", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      permissions: {
        initiativeChannelIds: [channelId]
      }
    });

    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate() {
          return {
            text: JSON.stringify({
              text: "standalone response",
              skip: false,
              reactionEmoji: null,
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              memoryLine: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "none", confidence: 0, reason: null },
              screenShareIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
      memory: null,
      discovery: null,
      search: null,
      gifs: null,
      video: null
    });

    bot.client.user = {
      id: "bot-1",
      username: "clanker conk",
      tag: "clanker conk#0001"
    };
    bot.shouldSendAsReply = () => false;

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-initiative-standalone",
      content: "clanker respond standalone",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(channelId, settings.memory.maxRecentMessages);
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      forceRespond: true,
      recentMessages,
      addressSignal: {
        direct: true,
        inferred: false,
        triggered: true,
        reason: "direct"
      }
    });

    assert.equal(sent, true);
    assert.equal(replyPayloads.length, 0);
    assert.equal(channelSendPayloads.length, 1);
  });
});
