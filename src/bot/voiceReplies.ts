import { buildSystemPrompt, buildVoiceTurnPrompt } from "../prompts.ts";
import {
  buildHardLimitsSection,
  getPromptBotName,
  getPromptCapabilityHonestyLine,
  getPromptVoiceOperationalGuidance,
  getPromptStyle,
  buildVoiceToneGuardrails
} from "../promptCore.ts";
import {
  normalizeSkipSentinel,
  parseReplyDirectives,
  resolveMaxMediaPromptLen,
  serializeForPrompt
} from "../botHelpers.ts";
import { clamp, sanitizeBotText } from "../utils.ts";

export async function composeVoiceOperationalMessage(bot, {
  settings,
  guildId = null,
  channelId = null,
  userId = null,
  messageId = null,
  event = "voice_runtime",
  reason = null,
  details = {},
  fallbackText = "",
  maxOutputChars = 180,
  allowSkip = false
}) {
  if (!bot.llm?.generate || !settings) return "";
  const normalizedEvent = String(event || "voice_runtime")
    .trim()
    .toLowerCase();
  const isVoiceSessionEnd = normalizedEvent === "voice_session_end";
  const isScreenShareOffer = normalizedEvent === "voice_screen_share_offer";
  const operationalTemperature = isVoiceSessionEnd ? 0.35 : 0.55;
  const operationalMaxOutputTokens = isVoiceSessionEnd ? 60 : isScreenShareOffer ? 140 : 100;
  const outputCharLimit = clamp(Number(maxOutputChars) || 180, 80, 700);

  const tunedSettings = {
    ...settings,
    llm: {
      ...(settings?.llm || {}),
      temperature: clamp(Number(settings?.llm?.temperature) || operationalTemperature, 0, 0.7),
      maxOutputTokens: clamp(Number(settings?.llm?.maxOutputTokens) || operationalMaxOutputTokens, 32, 110)
    }
  };
  const operationalMemoryFacts = await bot.loadRelevantMemoryFacts({
    settings,
    guildId,
    channelId,
    queryText: `${String(event || "")} ${String(reason || "")} ${String(fallbackText || "")}`
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 280),
    trace: {
      guildId,
      channelId,
      userId,
      source: "voice_operational_message"
    },
    limit: 6
  });
  const operationalMemoryHints = bot.buildMediaMemoryFacts({
    userFacts: [],
    relevantFacts: operationalMemoryFacts,
    maxItems: 6
  });
  const operationalGuidance = getPromptVoiceOperationalGuidance(settings, [
    "Keep it chill and simple. No overexplaining.",
    "Clearly state what happened and why, especially when a request is blocked.",
    "If relevant, mention required permissions/settings plainly.",
    "Avoid dramatic wording, blame, apology spirals, and long postmortems."
  ]);

  const systemPrompt = [
    `You are ${getPromptBotName(settings)}, a Discord regular posting a voice-mode update.`,
    `Style: ${getPromptStyle(settings, "laid-back, concise, low-drama chat tone")}.`,
    allowSkip
      ? "Write one short user-facing message for the text channel only if it's actually helpful."
      : "Write exactly one short user-facing message for the text channel.",
    ...operationalGuidance,
    "For voice_session_end, keep it to one brief sentence (4-12 words).",
    isScreenShareOffer
      ? "If Details JSON includes linkUrl, include that exact URL unchanged in the final message."
      : "",
    getPromptCapabilityHonestyLine(settings),
    ...buildHardLimitsSection(settings, { maxItems: 12 }),
    allowSkip
      ? "If posting a message would be redundant, output exactly [SKIP]."
      : "Do not output [SKIP].",
    "Do not output JSON, markdown headings, code blocks, labels, or directives.",
    "Do not invent details that are not in the event payload."
  ].join("\n");

  const userPrompt = [
    `Event: ${String(event || "voice_runtime")}`,
    `Reason: ${String(reason || "unknown")}`,
    `Details JSON: ${serializeForPrompt(details, 1400)}`,
    operationalMemoryHints.length
      ? `Relevant durable memory (use only if directly useful): ${operationalMemoryHints.join(" | ")}`
      : "",
    fallbackText ? `Baseline meaning: ${String(fallbackText || "").trim()}` : "",
    isVoiceSessionEnd
      ? "Constraint: one chill sentence, 4-12 words."
      : isScreenShareOffer
        ? "Constraint: low-key tone, 1-2 short sentences."
        : "Constraint: one brief sentence.",
    allowSkip ? "If no useful update is needed, return exactly [SKIP]." : "",
    "Return only the final message text."
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const generation = await bot.llm.generate({
      settings: tunedSettings,
      systemPrompt,
      userPrompt,
      trace: {
        guildId,
        channelId,
        messageId,
        userId,
        source: "voice_operational_message",
        event,
        reason
      }
    });

    const parsed = parseReplyDirectives(generation.text, resolveMaxMediaPromptLen(settings));
    const normalized = sanitizeBotText(
      normalizeSkipSentinel(parsed.text || generation.text || ""),
      outputCharLimit
    );
    if (!normalized) return "";
    if (normalized === "[SKIP]") return allowSkip ? "[SKIP]" : "";
    return normalized;
  } catch (error) {
    bot.store.logAction({
      kind: "voice_error",
      guildId: guildId || null,
      channelId: channelId || null,
      messageId: messageId || null,
      userId: userId || null,
      content: `voice_operational_llm_failed: ${String(error?.message || error)}`,
      metadata: {
        event,
        reason
      }
    });
    return "";
  }
}

export async function generateVoiceTurnReply(bot, {
  settings,
  guildId = null,
  channelId = null,
  userId = null,
  transcript = "",
  contextMessages = [],
  sessionId = null,
  isEagerTurn = false,
  voiceEagerness = 0,
  soundboardCandidates = []
}) {
  if (!bot.llm?.generate || !settings) return { text: "" };
  const incomingTranscript = String(transcript || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
  if (!incomingTranscript) return { text: "" };

  const normalizedContextMessages = (Array.isArray(contextMessages) ? contextMessages : [])
    .map((row) => ({
      role: row?.role === "assistant" ? "assistant" : "user",
      content: String(row?.content || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 520)
    }))
    .filter((row) => row.content)
    .slice(-10);
  const normalizedSoundboardCandidates = (Array.isArray(soundboardCandidates) ? soundboardCandidates : [])
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .slice(0, 40);
  const allowSoundboardDirective = Boolean(
    settings?.voice?.soundboard?.enabled && normalizedSoundboardCandidates.length
  );

  const guild = bot.client.guilds.cache.get(String(guildId || ""));
  const speakerName =
    guild?.members?.cache?.get(String(userId || ""))?.displayName ||
    guild?.members?.cache?.get(String(userId || ""))?.user?.username ||
    bot.client.users?.cache?.get(String(userId || ""))?.username ||
    "unknown";

  if (settings.memory?.enabled && bot.memory?.ingestMessage && userId) {
    try {
      await bot.memory.ingestMessage({
        messageId: `voice-${String(guildId || "guild")}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        authorId: String(userId),
        authorName: String(speakerName || "unknown"),
        content: incomingTranscript,
        settings,
        trace: {
          guildId,
          channelId,
          userId,
          source: "voice_stt_pipeline_ingest"
        }
      });
    } catch (error) {
      bot.store.logAction({
        kind: "voice_error",
        guildId,
        channelId,
        userId,
        content: `voice_stt_memory_ingest_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId
        }
      });
    }
  }

  const memorySlice = await bot.loadPromptMemorySlice({
    settings,
    userId,
    guildId,
    channelId: null,
    queryText: incomingTranscript,
    trace: {
      guildId,
      channelId,
      userId
    },
    source: "voice_stt_pipeline_generation"
  });

  const tunedSettings = {
    ...settings,
    llm: {
      ...(settings?.llm || {}),
      temperature: clamp(Number(settings?.llm?.temperature) || 0.8, 0, 1.2),
      maxOutputTokens: clamp(Number(settings?.llm?.maxOutputTokens) || 220, 40, 180)
    }
  };

  const voiceToneGuardrails = buildVoiceToneGuardrails();
  const systemPrompt = [
    buildSystemPrompt(settings),
    "You are speaking in live Discord voice chat.",
    ...voiceToneGuardrails,
    "Output plain spoken text only.",
    allowSoundboardDirective
      ? "Optional control: append exactly one trailing [[SOUNDBOARD:<sound_ref>]] directive when you want a soundboard effect."
      : null,
    isEagerTurn
      ? allowSoundboardDirective
        ? "If responding would be an interruption or you have nothing to add, output exactly [SKIP]. Otherwise, output plain spoken text and only the optional trailing soundboard directive."
        : "If responding would be an interruption or you have nothing to add, output exactly [SKIP]. Otherwise, output plain spoken text only, no directives or markdown."
      : allowSoundboardDirective
        ? "Do not output directives or markdown, except the optional trailing [[SOUNDBOARD:<sound_ref>]] directive. Do not output [SKIP]."
        : "Do not output directives like [[...]], [SKIP], or markdown.",
    allowSoundboardDirective ? "Never mention the control directive in normal speech." : null
  ] 
    .filter(Boolean)
    .join("\n");
  const userPrompt = buildVoiceTurnPrompt({
    speakerName,
    transcript: incomingTranscript,
    userFacts: memorySlice.userFacts,
    relevantFacts: memorySlice.relevantFacts,
    isEagerTurn,
    voiceEagerness,
    soundboardCandidates: normalizedSoundboardCandidates
  });

  try {
    const generation = await bot.llm.generate({
      settings: tunedSettings,
      systemPrompt,
      userPrompt,
      contextMessages: normalizedContextMessages,
      trace: {
        guildId,
        channelId,
        userId,
        source: "voice_stt_pipeline_generation",
        event: sessionId ? "voice_session" : "voice_turn"
      }
    });

    const parsed = parseReplyDirectives(generation.text, resolveMaxMediaPromptLen(settings));
    const soundboardRef = allowSoundboardDirective
      ? String(parsed.soundboardRef || "")
          .trim()
          .slice(0, 180) || null
      : null;
    const finalText = sanitizeBotText(normalizeSkipSentinel(parsed.text || generation.text || ""), 520);
    if (!finalText || finalText === "[SKIP]") {
      return { text: "", soundboardRef: null };
    }

    if (settings.memory?.enabled && parsed.memoryLine && bot.memory?.rememberLine && userId) {
      await bot.memory
        .rememberLine({
          line: parsed.memoryLine,
          sourceMessageId: `voice-${String(guildId || "guild")}-${Date.now()}-memory`,
          userId: String(userId),
          guildId,
          channelId,
          sourceText: incomingTranscript
        })
        .catch(() => undefined);
    }

    return {
      text: finalText,
      soundboardRef
    };
  } catch (error) {
    bot.store.logAction({
      kind: "voice_error",
      guildId,
      channelId,
      userId,
      content: `voice_stt_generation_failed: ${String(error?.message || error)}`,
      metadata: {
        sessionId
      }
    });
    return { text: "" };
  }
}
