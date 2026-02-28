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
import {
  defaultModelForLlmProvider,
  normalizeLlmProvider
} from "../llm/llmHelpers.ts";
import { clamp, sanitizeBotText } from "../utils.ts";

export async function composeVoiceOperationalMessage(runtime, {
  settings,
  guildId = null,
  channelId = null,
  userId = null,
  messageId = null,
  event = "voice_runtime",
  reason = null,
  details = {},
  maxOutputChars = 180,
  allowSkip = false
}) {
  if (!runtime.llm?.generate || !settings) {
    runtime.store?.logAction?.({
      kind: "voice_error",
      guildId: guildId || null,
      channelId: channelId || null,
      messageId: messageId || null,
      userId: userId || null,
      content: "voice_operational_llm_unavailable",
      metadata: {
        event,
        reason
      }
    });
    return "";
  }
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
  const operationalMemoryFacts = await runtime.loadRelevantMemoryFacts({
    settings,
    guildId,
    channelId,
    queryText: `${String(event || "")} ${String(reason || "")}`
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
  const operationalMemoryHints = runtime.buildMediaMemoryFacts({
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
    const generation = await runtime.llm.generate({
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
    runtime.store?.logAction?.({
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

export async function generateVoiceTurnReply(runtime, {
  settings,
  guildId = null,
  channelId = null,
  userId = null,
  transcript = "",
  contextMessages = [],
  sessionId = null,
  isEagerTurn = false,
  voiceEagerness = 0,
  conversationContext = null,
  soundboardCandidates = [],
  onWebLookupStart = null,
  onWebLookupComplete = null,
  webSearchTimeoutMs = null
}) {
  if (!runtime.llm?.generate || !settings) return { text: "" };
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
  const allowMemoryDirectives = Boolean(settings?.memory?.enabled);
  const allowWebSearchDirective = Boolean(
    settings?.webSearch?.enabled &&
      runtime.search?.isConfigured?.() &&
      typeof runtime.runModelRequestedWebSearch === "function" &&
      typeof runtime.buildWebSearchContext === "function"
  );
  const allowedDirectives = [
    ...(allowMemoryDirectives
      ? [
          "[[MEMORY_LINE:<durable fact from speaker turn>]]",
          "[[SELF_MEMORY_LINE:<durable fact about your own stable identity/preference/commitment in your reply>]]"
        ]
      : []),
    ...(allowSoundboardDirective ? ["[[SOUNDBOARD:<sound_ref>]]"] : []),
    ...(allowWebSearchDirective ? ["[[WEB_SEARCH:<concise query>]]"] : [])
  ];
  const directivesLine = allowedDirectives.length
    ? `Allowed optional trailing directives: ${allowedDirectives.join(", ")}.`
    : "Do not output directives like [[...]].";

  const guild = runtime.client.guilds.cache.get(String(guildId || ""));
  const speakerName =
    guild?.members?.cache?.get(String(userId || ""))?.displayName ||
    guild?.members?.cache?.get(String(userId || ""))?.user?.username ||
    runtime.client.users?.cache?.get(String(userId || ""))?.username ||
    "unknown";

  const memorySlice = await runtime.loadPromptMemorySlice({
    settings,
    userId,
    guildId,
    channelId,
    queryText: incomingTranscript,
    trace: {
      guildId,
      channelId,
      userId
    },
    source: "voice_stt_pipeline_generation"
  });

  const voiceGenerationProvider = normalizeLlmProvider(settings?.voice?.generationLlm?.provider);
  const voiceGenerationModel = String(
    settings?.voice?.generationLlm?.model || defaultModelForLlmProvider(voiceGenerationProvider)
  )
    .trim()
    .slice(0, 120) || defaultModelForLlmProvider(voiceGenerationProvider);
  const tunedSettings = {
    ...settings,
    llm: {
      ...(settings?.llm || {}),
      provider: voiceGenerationProvider,
      model: voiceGenerationModel,
      temperature: clamp(Number(settings?.llm?.temperature) || 0.8, 0, 1.2),
      maxOutputTokens: clamp(Number(settings?.llm?.maxOutputTokens) || 220, 40, 180)
    }
  };

  let webSearch = allowWebSearchDirective
    ? runtime.buildWebSearchContext(settings, incomingTranscript)
    : {
        requested: false,
        configured: false,
        enabled: false,
        used: false,
        blockedByBudget: false,
        optedOutByUser: false,
        error: null,
        query: "",
        results: [],
        fetchedPages: 0,
        providerUsed: null,
        providerFallbackUsed: false,
        budget: {
          canSearch: false
        }
      };
  let usedWebSearchFollowup = false;

  const voiceToneGuardrails = buildVoiceToneGuardrails();
  const systemPrompt = [
    buildSystemPrompt(settings),
    "You are speaking in live Discord voice chat.",
    ...voiceToneGuardrails,
    "Output plain spoken text only.",
    directivesLine,
    isEagerTurn
      ? allowedDirectives.length
        ? "If responding would be an interruption or you have nothing to add, output exactly [SKIP]. Otherwise, output plain spoken text and only optional trailing directives."
        : "If responding would be an interruption or you have nothing to add, output exactly [SKIP]. Otherwise, output plain spoken text only, no directives or markdown."
      : allowedDirectives.length
        ? "Do not output markdown or [SKIP]. Optional trailing directives are allowed only as listed."
        : "Do not output directives like [[...]], [SKIP], or markdown.",
    allowSoundboardDirective ? "Never mention the soundboard control directive in normal speech." : null
  ] 
    .filter(Boolean)
    .join("\n");
  const buildVoiceUserPrompt = ({
    webSearchContext = webSearch,
    allowWebSearch = allowWebSearchDirective
  } = {}) =>
    buildVoiceTurnPrompt({
      speakerName,
      transcript: incomingTranscript,
      userFacts: memorySlice.userFacts,
      relevantFacts: memorySlice.relevantFacts,
      isEagerTurn,
      voiceEagerness,
      conversationContext,
      botName: getPromptBotName(settings),
      soundboardCandidates: normalizedSoundboardCandidates,
      memoryEnabled: Boolean(settings.memory?.enabled),
      webSearch: webSearchContext,
      allowWebSearchDirective: allowWebSearch
    });

  try {
    let generation = await runtime.llm.generate({
      settings: tunedSettings,
      systemPrompt,
      userPrompt: buildVoiceUserPrompt(),
      contextMessages: normalizedContextMessages,
      trace: {
        guildId,
        channelId,
        userId,
        source: "voice_stt_pipeline_generation",
        event: sessionId ? "voice_session" : "voice_turn"
      }
    });

    let parsed = parseReplyDirectives(generation.text, resolveMaxMediaPromptLen(settings));
    if (allowWebSearchDirective && parsed.webSearchQuery && typeof runtime.runModelRequestedWebSearch === "function") {
      usedWebSearchFollowup = true;
      const normalizedQuery = String(parsed.webSearchQuery || "").trim();
      let lookupStarted = false;
      try {
        if (typeof onWebLookupStart === "function") {
          lookupStarted = true;
          await onWebLookupStart({
            query: normalizedQuery,
            guildId,
            channelId,
            userId
          });
        }
        const lookupTimeoutMs = resolveVoiceWebSearchTimeoutMs({
          settings,
          overrideMs: webSearchTimeoutMs
        });
        webSearch = await runVoiceWebSearchWithTimeout(runtime, {
          settings,
          webSearch,
          query: normalizedQuery,
          trace: {
            guildId,
            channelId,
            userId,
            source: "voice_stt_pipeline_generation",
            event: sessionId ? "voice_session_web_lookup" : "voice_turn_web_lookup"
          },
          timeoutMs: lookupTimeoutMs
        });
      } finally {
        if (lookupStarted && typeof onWebLookupComplete === "function") {
          await onWebLookupComplete({
            query: normalizedQuery,
            guildId,
            channelId,
            userId
          });
        }
      }

      generation = await runtime.llm.generate({
        settings: tunedSettings,
        systemPrompt,
        userPrompt: buildVoiceUserPrompt({
          webSearchContext: webSearch,
          allowWebSearch: false
        }),
        contextMessages: normalizedContextMessages,
        trace: {
          guildId,
          channelId,
          userId,
          source: "voice_stt_pipeline_generation",
          event: sessionId ? "voice_session_lookup_followup" : "voice_turn_lookup_followup"
        }
      });
      parsed = parseReplyDirectives(generation.text, resolveMaxMediaPromptLen(settings));
    }

    const soundboardRef = allowSoundboardDirective
      ? String(parsed.soundboardRef || "")
          .trim()
          .slice(0, 180) || null
      : null;
    const finalText = sanitizeBotText(normalizeSkipSentinel(parsed.text || generation.text || ""), 520);
    if (!finalText || finalText === "[SKIP]") {
      return { text: "", soundboardRef: null };
    }

    if (settings.memory?.enabled && parsed.memoryLine && runtime.memory?.rememberDirectiveLine && userId) {
      await runtime.memory
        .rememberDirectiveLine({
          line: parsed.memoryLine,
          sourceMessageId: `voice-${String(guildId || "guild")}-${Date.now()}-memory`,
          userId: String(userId),
          guildId,
          channelId,
          sourceText: incomingTranscript,
          scope: "lore"
        })
        .catch(() => undefined);
    }

    if (settings.memory?.enabled && parsed.selfMemoryLine && runtime.memory?.rememberDirectiveLine && userId) {
      await runtime.memory
        .rememberDirectiveLine({
          line: parsed.selfMemoryLine,
          sourceMessageId: `voice-${String(guildId || "guild")}-${Date.now()}-self-memory`,
          userId: runtime.client?.user?.id || String(userId),
          guildId,
          channelId,
          sourceText: finalText,
          scope: "self"
        })
        .catch(() => undefined);
    }

    return {
      text: finalText,
      soundboardRef,
      usedWebSearchFollowup
    };
  } catch (error) {
    runtime.store.logAction({
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

function resolveVoiceWebSearchTimeoutMs({ settings, overrideMs }) {
  const explicit = Number(overrideMs);
  const configured = Number(settings?.voice?.webSearchTimeoutMs);
  const raw = Number.isFinite(explicit) ? explicit : Number.isFinite(configured) ? configured : 8000;
  return clamp(Math.floor(raw), 500, 45000);
}

async function runVoiceWebSearchWithTimeout(runtime, {
  settings,
  webSearch,
  query,
  trace = {},
  timeoutMs = 8000
}) {
  type WebSearchSuccess = {
    ok: true;
    value: Record<string, unknown>;
  };
  type WebSearchFailure = {
    ok: false;
    error: Error;
  };
  type WebSearchTimeout = {
    ok: false;
    timeout: true;
  };

  const runPromise = Promise.resolve(
    runtime.runModelRequestedWebSearch({
      settings,
      webSearch,
      query,
      trace
    })
  ).then(
    (value): WebSearchSuccess => ({ ok: true, value }),
    (error): WebSearchFailure => ({ ok: false, error: error instanceof Error ? error : new Error(String(error)) })
  );

  const timeoutPromise = new Promise<WebSearchTimeout>((resolve) => {
    setTimeout(() => {
      resolve({ ok: false, timeout: true });
    }, Math.max(50, Number(timeoutMs) || 8000));
  });

  const result = await Promise.race<WebSearchSuccess | WebSearchFailure | WebSearchTimeout>([
    runPromise,
    timeoutPromise
  ]);
  if (result?.ok && result.value) return result.value;
  if ("timeout" in result && result.timeout) {
    return {
      ...(webSearch || {}),
      requested: true,
      query: String(query || "").trim(),
      used: false,
      error: `web lookup timed out after ${Math.max(50, Number(timeoutMs) || 8000)}ms`
    };
  }
  return {
    ...(webSearch || {}),
    requested: true,
    query: String(query || "").trim(),
    used: false,
    error: "error" in result
      ? String(result.error?.message || result.error || "web lookup failed")
      : "web lookup failed"
  };
}
