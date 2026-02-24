import {
  Client,
  GatewayIntentBits,
  Partials
} from "discord.js";
import { buildReplyPrompt, buildSystemPrompt } from "./prompts.js";
import { chance, pickRandom, sanitizeBotText, sleep } from "./utils.js";

const UNICODE_REACTIONS = ["🔥", "💀", "😂", "👀", "🤝", "🫡", "😮", "🧠", "💯", "😭"];

export class ClankerBot {
  constructor({ appConfig, store, llm, memory }) {
    this.appConfig = appConfig;
    this.store = store;
    this.llm = llm;
    this.memory = memory;

    this.lastBotMessageAt = 0;
    this.memoryTimer = null;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction]
    });

    this.registerEvents();
  }

  registerEvents() {
    this.client.once("ready", () => {
      console.log(`Logged in as ${this.client.user.tag}`);
    });

    this.client.on("messageCreate", async (message) => {
      try {
        await this.handleMessage(message);
      } catch (error) {
        this.store.logAction({
          kind: "bot_error",
          guildId: message.guildId,
          channelId: message.channelId,
          messageId: message.id,
          userId: message.author?.id,
          content: String(error?.message || error)
        });
      }
    });
  }

  async start() {
    await this.client.login(this.appConfig.discordToken);

    this.memoryTimer = setInterval(() => {
      this.memory.refreshMemoryMarkdown().catch(() => undefined);
    }, 5 * 60_000);
  }

  async stop() {
    if (this.memoryTimer) clearInterval(this.memoryTimer);
    await this.client.destroy();
  }

  getRuntimeState() {
    return {
      isReady: this.client.isReady(),
      userTag: this.client.user?.tag ?? null,
      guildCount: this.client.guilds.cache.size,
      lastBotMessageAt: this.lastBotMessageAt ? new Date(this.lastBotMessageAt).toISOString() : null
    };
  }

  async handleMessage(message) {
    if (!message.guild || !message.channel || !message.author) return;

    const settings = this.store.getSettings();

    const text = String(message.content || "").trim();
    this.store.recordMessage({
      messageId: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      authorId: message.author.id,
      authorName: message.member?.displayName || message.author.username,
      isBot: message.author.bot,
      content: text,
      referencedMessageId: message.reference?.messageId
    });

    if (message.author.bot) return;
    if (!this.isChannelAllowed(settings, message.channelId)) return;
    if (this.isUserBlocked(settings, message.author.id)) return;

    if (settings.memory.enabled) {
      await this.memory.ingestMessage({
        messageId: message.id,
        authorId: message.author.id,
        authorName: message.member?.displayName || message.author.username,
        content: text
      });
    }

    await this.maybeReactToMessage(message, settings);
    await this.maybeReplyToMessage(message, settings);
  }

  async maybeReplyToMessage(message, settings) {
    if (!settings.permissions.allowReplies) return;
    if (!this.canSendMessage(settings.permissions.maxMessagesPerHour)) return;
    if (!this.canTalkNow(settings)) return;

    const activity01 = settings.activity.level / 100;
    const mentioned = message.mentions.users.has(this.client.user.id);
    const namePing = message.content.toLowerCase().includes(settings.botName.toLowerCase());
    const isReplyToBot = message.mentions.repliedUser?.id === this.client.user.id;
    const directlyAddressed = mentioned || namePing || isReplyToBot;

    const naturalProbability =
      settings.permissions.allowInitiativeReplies ? 0.01 + activity01 * 0.08 : 0;
    const shouldRespond = directlyAddressed || chance(naturalProbability);
    if (!shouldRespond) return;

    const recentMessages = this.store.getRecentMessages(
      message.channelId,
      settings.memory.maxRecentMessages
    );

    const memorySlice = settings.memory.enabled
      ? await this.memory.buildPromptMemorySlice({
          userId: message.author.id,
          channelId: message.channelId,
          queryText: message.content
        })
      : { userFacts: [], relevantMessages: [], memoryMarkdown: "" };

    const systemPrompt = buildSystemPrompt(settings, memorySlice.memoryMarkdown);
    const userPrompt = buildReplyPrompt({
      message: {
        authorName: message.member?.displayName || message.author.username,
        content: message.content
      },
      recentMessages,
      relevantMessages: memorySlice.relevantMessages,
      userFacts: memorySlice.userFacts,
      emojiHints: this.getEmojiHints(message.guild)
    });

    const generation = await this.llm.generate({
      settings,
      systemPrompt,
      userPrompt,
      trace: {
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id
      }
    });

    const finalText = sanitizeBotText(generation.text);
    if (!finalText || finalText === "[SKIP]") return;

    await message.channel.sendTyping();
    await sleep(600 + Math.floor(Math.random() * 1800));

    const canStandalonePost = this.isInitiativeChannel(settings, message.channelId);
    const sendAsReply = canStandalonePost ? (directlyAddressed ? chance(0.65) : false) : true;
    const sent = sendAsReply
      ? await message.reply({
          content: finalText,
          allowedMentions: { repliedUser: false }
        })
      : await message.channel.send(finalText);
    const actionKind = sendAsReply ? "sent_reply" : "sent_message";
    const referencedMessageId = sendAsReply ? message.id : null;

    this.markSpoke();
    this.store.recordMessage({
      messageId: sent.id,
      guildId: sent.guildId,
      channelId: sent.channelId,
      authorId: this.client.user.id,
      authorName: settings.botName,
      isBot: true,
      content: finalText,
      referencedMessageId
    });
    this.store.logAction({
      kind: actionKind,
      guildId: sent.guildId,
      channelId: sent.channelId,
      messageId: sent.id,
      userId: this.client.user.id,
      content: finalText,
      metadata: {
        triggerMessageId: message.id,
        sendAsReply,
        canStandalonePost,
        llm: {
          provider: generation.provider,
          model: generation.model,
          usage: generation.usage,
          costUsd: generation.costUsd
        }
      }
    });
  }

  async maybeReactToMessage(message, settings) {
    if (!settings.permissions.allowReactions) return;
    if (!this.canTakeAction("reacted", settings.permissions.maxReactionsPerHour)) return;

    const activity01 = settings.activity.level / 100;
    const reactionProbability = 0.02 + activity01 * 0.12;
    if (!chance(reactionProbability)) return;

    const emoji = pickRandom([...this.getReactionEmojiOptions(message.guild), ...UNICODE_REACTIONS]);
    if (!emoji) return;

    try {
      await message.react(emoji);
      this.store.logAction({
        kind: "reacted",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: this.client.user.id,
        content: emoji
      });
    } catch {
      // Ignore failed reactions (permissions or emoji constraints).
    }
  }

  canTalkNow(settings) {
    const elapsed = Date.now() - this.lastBotMessageAt;
    return elapsed >= settings.activity.minSecondsBetweenMessages * 1000;
  }

  markSpoke() {
    this.lastBotMessageAt = Date.now();
  }

  canTakeAction(kind, maxPerHour) {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const count = this.store.countActionsSince(kind, since);
    return count < maxPerHour;
  }

  canSendMessage(maxPerHour) {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const sentReplies = this.store.countActionsSince("sent_reply", since);
    const sentMessages = this.store.countActionsSince("sent_message", since);
    return sentReplies + sentMessages < maxPerHour;
  }

  isUserBlocked(settings, userId) {
    return settings.permissions.blockedUserIds.includes(String(userId));
  }

  isChannelAllowed(settings, channelId) {
    const id = String(channelId);

    if (settings.permissions.blockedChannelIds.includes(id)) {
      return false;
    }

    const allowList = settings.permissions.allowedChannelIds;
    if (allowList.length === 0) return true;

    return allowList.includes(id);
  }

  isInitiativeChannel(settings, channelId) {
    const id = String(channelId);
    return settings.permissions.initiativeChannelIds.includes(id);
  }

  getEmojiHints(guild) {
    const custom = guild.emojis.cache
      .map((emoji) => (emoji.animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`))
      .slice(0, 24);

    return custom;
  }

  getReactionEmojiOptions(guild) {
    return guild.emojis.cache.map((emoji) => emoji.identifier).slice(0, 24);
  }
}
