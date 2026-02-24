import {
  Client,
  GatewayIntentBits,
  Partials
} from "discord.js";
import {
  buildInitiativePrompt,
  buildReactionPrompt,
  buildReplyPrompt,
  buildSystemPrompt
} from "./prompts.js";
import { chance, clamp, sanitizeBotText, sleep } from "./utils.js";

const UNICODE_REACTIONS = ["🔥", "💀", "😂", "👀", "🤝", "🫡", "😮", "🧠", "💯", "😭"];
const CLANKER_KEYWORD_RE = /\bclank(?:er|a)\b/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i;
const MAX_IMAGE_INPUTS = 3;
const REACTION_CONTEXT_LIMIT = 12;
const STARTUP_TASK_DELAY_MS = 4500;
const INITIATIVE_TICK_MS = 60_000;

export class ClankerBot {
  constructor({ appConfig, store, llm, memory }) {
    this.appConfig = appConfig;
    this.store = store;
    this.llm = llm;
    this.memory = memory;

    this.lastBotMessageAt = 0;
    this.memoryTimer = null;
    this.initiativeTimer = null;
    this.startupTasksRan = false;
    this.initiativePosting = false;

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

    this.initiativeTimer = setInterval(() => {
      this.maybeRunInitiativeCycle().catch((error) => {
        this.store.logAction({
          kind: "bot_error",
          content: `initiative_cycle: ${String(error?.message || error)}`
        });
      });
    }, INITIATIVE_TICK_MS);

    setTimeout(() => {
      this.runStartupTasks().catch((error) => {
        this.store.logAction({
          kind: "bot_error",
          content: `startup_tasks: ${String(error?.message || error)}`
        });
      });
    }, STARTUP_TASK_DELAY_MS);
  }

  async stop() {
    if (this.memoryTimer) clearInterval(this.memoryTimer);
    if (this.initiativeTimer) clearInterval(this.initiativeTimer);
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

  async maybeReplyToMessage(message, settings, options = {}) {
    if (!settings.permissions.allowReplies) return;
    if (!this.canSendMessage(settings.permissions.maxMessagesPerHour)) return;
    if (!this.canTalkNow(settings)) return;

    const replyActivity01 = settings.activity.replyLevel / 100;
    const directlyAddressed = this.isDirectlyAddressed(settings, message);

    const naturalProbability =
      settings.permissions.allowInitiativeReplies ? replyActivity01 : 0;
    const shouldRespond = options.forceRespond || directlyAddressed || chance(naturalProbability);
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
    const imageInputs = this.getImageInputs(message);

    const systemPrompt = buildSystemPrompt(settings, memorySlice.memoryMarkdown);
    const userPrompt = buildReplyPrompt({
      message: {
        authorName: message.member?.displayName || message.author.username,
        content: message.content
      },
      imageInputs,
      recentMessages,
      relevantMessages: memorySlice.relevantMessages,
      userFacts: memorySlice.userFacts,
      emojiHints: this.getEmojiHints(message.guild)
    });

    const generation = await this.llm.generate({
      settings,
      systemPrompt,
      userPrompt,
      imageInputs,
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
        source: options.source || "message_event",
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

    const emojiOptions = [...new Set([...this.getReactionEmojiOptions(message.guild), ...UNICODE_REACTIONS])];
    if (!emojiOptions.length) return;

    const recentMessages = this.store.getRecentMessages(message.channelId, REACTION_CONTEXT_LIMIT);
    const decision = await this.decideReaction({
      message,
      settings,
      emojiOptions,
      recentMessages
    });
    if (!decision.shouldReact || !decision.emoji) return;

    try {
      await message.react(decision.emoji);
      this.store.logAction({
        kind: "reacted",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: this.client.user.id,
        content: decision.emoji,
        metadata: {
          source: decision.source,
          confidence: decision.confidence,
          reason: decision.reason,
          llm: decision.llm
        }
      });
    } catch {
      // Ignore failed reactions (permissions or emoji constraints).
    }
  }

  async decideReaction({ message, settings, emojiOptions, recentMessages }) {
    const reactionLevel = clamp(Number(settings.activity?.reactionLevel) || 0, 0, 100);
    const reactionSettings = {
      ...settings,
      llm: {
        ...settings.llm,
        temperature: Math.min(Number(settings.llm?.temperature) || 0.9, 0.35),
        maxOutputTokens: Math.min(Number(settings.llm?.maxOutputTokens) || 220, 120)
      }
    };

    const systemPrompt = this.buildReactionDecisionSystemPrompt(settings);
    const userPrompt = buildReactionPrompt({
      message: {
        authorName: message.member?.displayName || message.author?.username || "unknown",
        content: String(message.content || ""),
        attachmentCount: message.attachments?.size || 0
      },
      recentMessages,
      emojiOptions,
      reactionLevel
    });

    const fallback = this.heuristicReactionDecision({
      messageText: message.content,
      emojiOptions,
      reactionLevel
    });

    try {
      const generation = await this.llm.generate({
        settings: reactionSettings,
        systemPrompt,
        userPrompt,
        trace: {
          guildId: message.guildId,
          channelId: message.channelId,
          userId: this.client.user.id
        }
      });

      const parsed = parseReactionDecision(generation.text);
      const normalized = this.normalizeReactionDecision({
        parsed,
        emojiOptions,
        reactionLevel
      });

      return {
        ...normalized,
        source: "llm",
        llm: {
          provider: generation.provider,
          model: generation.model,
          usage: generation.usage,
          costUsd: generation.costUsd
        }
      };
    } catch {
      return {
        ...fallback,
        source: "heuristic_fallback",
        llm: null
      };
    }
  }

  buildReactionDecisionSystemPrompt(settings) {
    return [
      `You are ${settings.botName}, deciding whether to add a Discord reaction.`,
      "React only when it feels natural and adds social value.",
      "Do not react to every message.",
      "Avoid reacting on sensitive, personal, or potentially harmful topics.",
      "Prefer reactions for humor, excitement, agreement, surprise, or supportive moments.",
      "Pick one emoji that best matches tone and context, or no reaction.",
      "Output JSON only with this schema:",
      '{"shouldReact": boolean, "emoji": string|null, "confidence": number, "reason": string}'
    ].join("\n");
  }

  normalizeReactionDecision({ parsed, emojiOptions, reactionLevel }) {
    const fallback = {
      shouldReact: false,
      emoji: null,
      confidence: 0,
      reason: "No valid reaction decision."
    };
    if (!parsed || typeof parsed !== "object") return fallback;

    const shouldReact = Boolean(parsed.shouldReact);
    const rawEmojiValue = parsed.emoji === null || parsed.emoji === undefined ? null : String(parsed.emoji).trim();
    const emojiRaw = rawEmojiValue ? normalizeReactionEmojiToken(rawEmojiValue) : null;
    const confidenceNumber = Number(parsed.confidence);
    const confidence = Number.isFinite(confidenceNumber) ? clamp(confidenceNumber, 0, 1) : 0;
    const reason = String(parsed.reason || "").trim().slice(0, 180) || "No reason provided.";

    if (!shouldReact) {
      return {
        shouldReact: false,
        emoji: null,
        confidence,
        reason
      };
    }

    if (!emojiRaw || !emojiOptions.includes(emojiRaw)) {
      return {
        shouldReact: false,
        emoji: null,
        confidence,
        reason: "LLM chose an emoji outside allowed options."
      };
    }

    const minConfidence = this.getReactionConfidenceThreshold(reactionLevel);
    if (!Number.isFinite(confidence) || confidence < minConfidence) {
      return {
        shouldReact: false,
        emoji: null,
        confidence,
        reason: "Decision confidence below reaction threshold."
      };
    }

    return {
      shouldReact: true,
      emoji: emojiRaw,
      confidence,
      reason
    };
  }

  getReactionConfidenceThreshold(reactionLevel) {
    const level = clamp(Number(reactionLevel) || 0, 0, 100);
    return 0.9 - level * 0.0065;
  }

  heuristicReactionDecision({ messageText, emojiOptions, reactionLevel }) {
    const text = String(messageText || "").toLowerCase();
    if (!text) {
      return {
        shouldReact: false,
        emoji: null,
        confidence: 0,
        reason: "No message text."
      };
    }

    const candidates = [
      {
        re: /\b(lol|lmao|lmfao|haha|rofl|😂|💀)\b/i,
        emojis: ["😂", "💀"],
        confidence: 0.9,
        reason: "Laughter signal."
      },
      {
        re: /\b(gg|nice|fire|lit|huge|lets go|let's go|goat|w|win|based)\b/i,
        emojis: ["🔥", "💯", "🤝", "🫡"],
        confidence: 0.84,
        reason: "Hype/approval signal."
      },
      {
        re: /\b(wtf|no way|wild|crazy|insane)\b/i,
        emojis: ["😮", "👀"],
        confidence: 0.78,
        reason: "Surprise signal."
      },
      {
        re: /\b(rip|sad|pain|unlucky|oof)\b/i,
        emojis: ["😭"],
        confidence: 0.82,
        reason: "Sympathy signal."
      },
      {
        re: /\?\s*$/i,
        emojis: ["👀", "🧠"],
        confidence: 0.62,
        reason: "Question/prompt signal."
      }
    ];

    for (const candidate of candidates) {
      if (!candidate.re.test(text)) continue;
      const emoji = pickFirstAvailableEmoji(candidate.emojis, emojiOptions);
      if (!emoji) break;

      if (candidate.confidence < this.getReactionConfidenceThreshold(reactionLevel)) {
        return {
          shouldReact: false,
          emoji: null,
          confidence: candidate.confidence,
          reason: "Heuristic confidence below threshold."
        };
      }

      return {
        shouldReact: true,
        emoji,
        confidence: candidate.confidence,
        reason: candidate.reason
      };
    }

    return {
      shouldReact: false,
      emoji: null,
      confidence: 0.3,
      reason: "No meaningful reaction pattern matched."
    };
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
    const initiativePosts = this.store.countActionsSince("initiative_post", since);
    return sentReplies + sentMessages + initiativePosts < maxPerHour;
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

  isDirectlyAddressed(settings, message) {
    const mentioned = message.mentions?.users?.has(this.client.user.id);
    const content = String(message.content || "");
    const namePing =
      content.toLowerCase().includes(settings.botName.toLowerCase()) || CLANKER_KEYWORD_RE.test(content);
    const isReplyToBot = message.mentions?.repliedUser?.id === this.client.user.id;
    return Boolean(mentioned || namePing || isReplyToBot);
  }

  async runStartupTasks() {
    if (this.startupTasksRan) return;
    this.startupTasksRan = true;

    const settings = this.store.getSettings();
    await this.runStartupCatchup(settings);
    await this.maybeRunInitiativeCycle({ startup: true });
  }

  async runStartupCatchup(settings) {
    if (!settings.startup?.catchupEnabled) return;
    if (!settings.permissions.allowReplies) return;

    const channels = this.getStartupScanChannels(settings);
    const lookbackMs = settings.startup.catchupLookbackHours * 60 * 60_000;
    const maxMessages = settings.startup.catchupMaxMessagesPerChannel;
    const maxRepliesPerChannel = settings.startup.maxCatchupRepliesPerChannel;
    const now = Date.now();

    for (const channel of channels) {
      let repliesSent = 0;

      const messages = await this.hydrateRecentMessages(channel, maxMessages);
      for (const message of messages) {
        if (repliesSent >= maxRepliesPerChannel) break;
        if (!message?.author || message.author.bot) continue;
        if (!message.guild || !message.channel) continue;
        if (!this.isChannelAllowed(settings, message.channelId)) continue;
        if (this.isUserBlocked(settings, message.author.id)) continue;
        if (!this.isDirectlyAddressed(settings, message)) continue;
        if (now - message.createdTimestamp > lookbackMs) continue;
        if (this.store.hasTriggeredResponse(message.id)) continue;

        await this.maybeReplyToMessage(message, settings, {
          forceRespond: true,
          source: "startup_catchup"
        });
        repliesSent += 1;
      }
    }
  }

  getStartupScanChannels(settings) {
    const channels = [];
    const seen = new Set();

    const explicit = [
      ...settings.permissions.initiativeChannelIds,
      ...settings.permissions.allowedChannelIds
    ];

    for (const id of explicit) {
      const channel = this.client.channels.cache.get(String(id));
      if (!channel || !channel.isTextBased?.() || typeof channel.send !== "function") continue;
      if (seen.has(channel.id)) continue;
      seen.add(channel.id);
      channels.push(channel);
    }

    if (channels.length) return channels;

    for (const guild of this.client.guilds.cache.values()) {
      const guildChannels = guild.channels.cache
        .filter((channel) => channel.isTextBased?.() && typeof channel.send === "function")
        .first(8);

      for (const channel of guildChannels) {
        if (seen.has(channel.id)) continue;
        if (!this.isChannelAllowed(settings, channel.id)) continue;
        seen.add(channel.id);
        channels.push(channel);
      }
    }

    return channels;
  }

  async hydrateRecentMessages(channel, limit) {
    try {
      const fetched = await channel.messages.fetch({ limit });
      const sorted = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

      for (const message of sorted) {
        this.store.recordMessage({
          messageId: message.id,
          guildId: message.guildId,
          channelId: message.channelId,
          authorId: message.author?.id || "unknown",
          authorName: message.member?.displayName || message.author?.username || "unknown",
          isBot: Boolean(message.author?.bot),
          content: String(message.content || "").trim(),
          referencedMessageId: message.reference?.messageId
        });
      }

      return sorted;
    } catch {
      return [];
    }
  }

  async maybeRunInitiativeCycle({ startup = false } = {}) {
    if (this.initiativePosting) return;
    this.initiativePosting = true;

    try {
      const settings = this.store.getSettings();
      if (!settings.initiative?.enabled) return;
      if (!settings.permissions.initiativeChannelIds.length) return;
      if (settings.initiative.maxPostsPerDay <= 0) return;
      if (!this.canSendMessage(settings.permissions.maxMessagesPerHour)) return;
      if (!this.canTalkNow(settings)) return;

      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const posts24h = this.store.countInitiativePostsSince(since24h);
      if (posts24h >= settings.initiative.maxPostsPerDay) return;

      const lastPostAt = this.store.getLastActionTime("initiative_post");
      const lastPostTs = lastPostAt ? new Date(lastPostAt).getTime() : 0;
      const elapsed = Date.now() - lastPostTs;
      const requiredInterval = this.getInitiativePostingIntervalMs(settings);

      if (startup) {
        if (!settings.initiative.postOnStartup) return;
        if (lastPostTs && elapsed < requiredInterval) return;
      } else if (lastPostTs && elapsed < requiredInterval) {
        return;
      }

      const channel = this.pickInitiativeChannel(settings);
      if (!channel) return;

      const recent = await this.hydrateRecentMessages(channel, settings.memory.maxRecentMessages);
      const recentMessages = recent.length
        ? recent
            .slice()
            .reverse()
            .slice(0, settings.memory.maxRecentMessages)
            .map((msg) => ({
              author_name: msg.member?.displayName || msg.author?.username || "unknown",
              content: String(msg.content || "").trim()
            }))
        : this.store.getRecentMessages(channel.id, settings.memory.maxRecentMessages);

      const memoryMarkdown = settings.memory.enabled
        ? await this.memory.readMemoryMarkdown()
        : "";
      const systemPrompt = buildSystemPrompt(settings, memoryMarkdown);
      const userPrompt = buildInitiativePrompt({
        channelName: channel.name || "channel",
        recentMessages,
        emojiHints: this.getEmojiHints(channel.guild),
        allowImagePosts: settings.initiative.allowImagePosts
      });

      const generation = await this.llm.generate({
        settings,
        systemPrompt,
        userPrompt,
        trace: {
          guildId: channel.guildId,
          channelId: channel.id,
          userId: this.client.user.id
        }
      });

      const finalText = sanitizeBotText(generation.text);
      if (!finalText || finalText === "[SKIP]") return;

      let payload = { content: finalText };
      let imageUsed = false;
      if (
        settings.initiative.allowImagePosts &&
        chance((settings.initiative.imagePostChancePercent || 0) / 100)
      ) {
        try {
          const image = await this.llm.generateImage({
            settings,
            prompt: `Create a playful Discord-ready image for this post:\n\n${finalText}`,
            trace: {
              guildId: channel.guildId,
              channelId: channel.id,
              userId: this.client.user.id,
              source: "initiative_post"
            }
          });

          if (image.imageBuffer) {
            payload = {
              content: finalText,
              files: [{ attachment: image.imageBuffer, name: `clanker-${Date.now()}.png` }]
            };
            imageUsed = true;
          } else if (image.imageUrl) {
            payload = { content: `${finalText}\n${image.imageUrl}` };
            imageUsed = true;
          }
        } catch {
          // Fallback to text-only post when image generation fails.
        }
      }

      await channel.sendTyping();
      await sleep(500 + Math.floor(Math.random() * 1200));

      const sent = await channel.send(payload);

      this.markSpoke();
      this.store.recordMessage({
        messageId: sent.id,
        guildId: sent.guildId,
        channelId: sent.channelId,
        authorId: this.client.user.id,
        authorName: settings.botName,
        isBot: true,
        content: finalText,
        referencedMessageId: null
      });

      this.store.logAction({
        kind: "initiative_post",
        guildId: sent.guildId,
        channelId: sent.channelId,
        messageId: sent.id,
        userId: this.client.user.id,
        content: finalText,
        metadata: {
          source: startup ? "initiative_startup" : "initiative_scheduler",
          imageUsed,
          llm: {
            provider: generation.provider,
            model: generation.model,
            usage: generation.usage,
            costUsd: generation.costUsd
          }
        }
      });
    } finally {
      this.initiativePosting = false;
    }
  }

  getInitiativePostingIntervalMs(settings) {
    const minByGap = settings.initiative.minMinutesBetweenPosts * 60_000;
    const perDay = Math.max(settings.initiative.maxPostsPerDay, 1);
    const evenPacing = Math.floor((24 * 60 * 60 * 1000) / perDay);
    return Math.max(minByGap, evenPacing);
  }

  pickInitiativeChannel(settings) {
    const ids = settings.permissions.initiativeChannelIds
      .map((id) => String(id).trim())
      .filter(Boolean);
    if (!ids.length) return null;

    const shuffled = ids
      .map((id) => ({ id, sortKey: Math.random() }))
      .sort((a, b) => a.sortKey - b.sortKey)
      .map((item) => item.id);

    for (const id of shuffled) {
      const channel = this.client.channels.cache.get(id);
      if (!channel || !channel.isTextBased?.() || typeof channel.send !== "function") continue;
      if (!this.isChannelAllowed(settings, channel.id)) continue;
      return channel;
    }

    return null;
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

  getImageInputs(message) {
    const images = [];

    for (const attachment of message.attachments.values()) {
      if (images.length >= MAX_IMAGE_INPUTS) break;

      const url = String(attachment.url || attachment.proxyURL || "").trim();
      if (!url) continue;

      const filename = String(attachment.name || "").trim();
      const contentType = String(attachment.contentType || "").toLowerCase();
      const urlPath = url.split("?")[0];
      const isImage = contentType.startsWith("image/") || IMAGE_EXT_RE.test(filename) || IMAGE_EXT_RE.test(urlPath);
      if (!isImage) continue;

      images.push({ url, filename, contentType });
    }

    return images;
  }
}

function parseReactionDecision(rawText) {
  if (!rawText) return null;
  const text = String(rawText).trim();

  const direct = safeParseJson(text);
  if (direct) return direct;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const parsedFence = safeParseJson(fenced[1].trim());
    if (parsedFence) return parsedFence;
  }

  const objectLike = text.match(/\{[\s\S]*\}/);
  if (objectLike?.[0]) {
    return safeParseJson(objectLike[0]);
  }

  return null;
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeReactionEmojiToken(emojiToken) {
  const token = String(emojiToken || "").trim();
  const custom = token.match(/^<a?:([^:>]+):(\d+)>$/);
  if (custom) {
    return `${custom[1]}:${custom[2]}`;
  }
  return token;
}

function pickFirstAvailableEmoji(preferredEmojis, allowedEmojis) {
  for (const emoji of preferredEmojis) {
    if (allowedEmojis.includes(emoji)) return emoji;
  }
  return null;
}
