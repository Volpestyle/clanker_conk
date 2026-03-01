import { buildSystemPrompt, buildVoiceTurnPrompt } from "../prompts.ts";
import {
  buildHardLimitsSection,
  DEFAULT_PROMPT_VOICE_OPERATIONAL_GUIDANCE,
  getPromptBotName,
  getPromptCapabilityHonestyLine,
  getPromptVoiceOperationalGuidance,
  getPromptStyle,
  buildVoiceToneGuardrails
} from "../promptCore.ts";
import {
  normalizeSkipSentinel,
  parseStructuredReplyOutput,
  REPLY_OUTPUT_JSON_SCHEMA,
  serializeForPrompt
} from "../botHelpers.ts";
import {
  defaultModelForLlmProvider,
  normalizeLlmProvider
} from "../llm/llmHelpers.ts";
import { runModelRequestedWebSearchWithTimeout } from "./replyFollowup.ts";
import { clamp, sanitizeBotText } from "../utils.ts";

const MAX_SOUNDBOARD_LEAK_TOKEN_SCAN = 24;
const SOUNDBOARD_CANDIDATE_PARSE_LIMIT = 40;
const SOUNDBOARD_SIMPLE_TOKEN_RE = /^[a-z0-9 _-]+$/i;
const MAX_VOICE_SOUNDBOARD_REFS = 10;
const LOOKUP_CONTEXT_PROMPT_LIMIT = 4;
const LOOKUP_CONTEXT_PROMPT_MAX_AGE_HOURS = 72;
const OPEN_ARTICLE_DEFAULT_MAX_CHARS = 12_000;
const OPEN_ARTICLE_REF_MAX_LEN = 260;
const OPEN_ARTICLE_MAX_CANDIDATES = 12;
const OPEN_ARTICLE_ROW_LIMIT = 4;
const OPEN_ARTICLE_RESULTS_PER_ROW = 5;
const OPEN_ARTICLE_ROW_REF_RE = /^r(\d+):(\d+)$/i;
const OPEN_ARTICLE_INDEX_REF_RE = /^\d+$/;
const OPEN_ARTICLE_URL_RE = /^https?:\/\//i;
const VOICE_MEMORY_CONTEXT_MAX_FACTS = 24;
const VOICE_MEMORY_PREFETCH_WAIT_MS = 120;
const VOICE_MEMORY_FOLLOWUP_WAIT_MS = 240;

type VoiceMemoryFact = Record<string, unknown>;

type VoiceMemorySlice = {
  userFacts: VoiceMemoryFact[];
  relevantFacts: VoiceMemoryFact[];
};

function emptyVoiceMemorySlice(): VoiceMemorySlice {
  return {
    userFacts: [],
    relevantFacts: []
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeVoiceMemoryFactList(value: unknown): VoiceMemoryFact[] {
  const rows = Array.isArray(value) ? value : [];
  const normalized: VoiceMemoryFact[] = [];
  for (const row of rows) {
    if (!isPlainRecord(row)) continue;
    normalized.push({ ...row });
    if (normalized.length >= VOICE_MEMORY_CONTEXT_MAX_FACTS) break;
  }
  return normalized;
}

function normalizeVoiceMemorySlice(value: unknown): VoiceMemorySlice {
  if (!isPlainRecord(value)) return emptyVoiceMemorySlice();
  return {
    userFacts: normalizeVoiceMemoryFactList(value.userFacts),
    relevantFacts: normalizeVoiceMemoryFactList(value.relevantFacts)
  };
}

async function resolveVoiceMemorySliceWithTimeout({
  memorySlicePromise,
  fallbackSlice,
  maxWaitMs = 0
}: {
  memorySlicePromise: Promise<VoiceMemorySlice> | null;
  fallbackSlice: VoiceMemorySlice;
  maxWaitMs?: number;
}): Promise<VoiceMemorySlice> {
  if (!memorySlicePromise) return fallbackSlice;
  const boundedWaitMs = Math.max(0, Math.floor(Number(maxWaitMs) || 0));
  if (!boundedWaitMs) return fallbackSlice;

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      memorySlicePromise.catch(() => fallbackSlice),
      new Promise<VoiceMemorySlice>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(fallbackSlice), boundedWaitMs);
      })
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function runAsyncCallback(callback: unknown, payload: Record<string, unknown>) {
  if (typeof callback !== "function") return;
  try {
    const maybePromise = callback(payload);
    if (
      maybePromise &&
      typeof maybePromise === "object" &&
      "catch" in maybePromise &&
      typeof maybePromise.catch === "function"
    ) {
      maybePromise.catch(() => undefined);
    }
  } catch {
    // callback errors should not block voice generation
  }
}

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
  const detailsPayload: Record<string, unknown> = {};
  if (details && typeof details === "object" && !Array.isArray(details)) {
    for (const [key, value] of Object.entries(details)) {
      detailsPayload[String(key)] = value;
    }
  } else {
    detailsPayload.detail = String(details || "");
  }
  const normalizedEvent = String(event || "voice_runtime")
    .trim()
    .toLowerCase();
  const isVoiceSessionEnd = normalizedEvent === "voice_session_end";
  const isVoiceStatusRequest = normalizedEvent === "voice_status_request";
  const isScreenShareOffer = normalizedEvent === "voice_screen_share_offer";
  const operationalTemperature = isVoiceSessionEnd ? 0.35 : 0.55;
  const operationalMaxOutputTokens = isVoiceSessionEnd ? 60 : isScreenShareOffer ? 140 : 100;
  const outputCharLimit = clamp(Number(maxOutputChars) || 180, 80, 700);
  const statusRequesterText = isVoiceStatusRequest
    ? String(detailsPayload?.requestText || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 220)
    : "";

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
  const operationalGuidance = getPromptVoiceOperationalGuidance(
    settings,
    DEFAULT_PROMPT_VOICE_OPERATIONAL_GUIDANCE
  );

  const systemPrompt = [
    `You are ${getPromptBotName(settings)}, a Discord regular posting a voice-mode update.`,
    `Style: ${getPromptStyle(settings)}.`,
    allowSkip
      ? "Write one short user-facing message for the text channel only if it's actually helpful."
      : "Write exactly one short user-facing message for the text channel.",
    "Stay in character as a regular server member with your usual voice, not a dashboard logger.",
    ...operationalGuidance,
    "For voice_session_end, keep it to one brief sentence (4-12 words).",
    isVoiceStatusRequest
      ? "For voice_status_request, answer the user's actual ask first in character using Details JSON."
      : "",
    isVoiceStatusRequest
      ? "Default to a direct presence check answer for check-in questions; include extra metrics only when asked."
      : "",
    isVoiceStatusRequest
      ? "Do not dump every status field by default."
      : "",
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
    `Details JSON: ${serializeForPrompt(detailsPayload, 1400)}`,
    statusRequesterText ? `Requester text: ${statusRequesterText}` : "",
    isVoiceStatusRequest
      ? "Status field meanings: elapsedSeconds=time already in VC; inactivitySeconds=time until inactivity auto-leave; remainingSeconds=time until max session time cap; activeCaptures=current live inbound captures."
      : "",
    isVoiceStatusRequest
      ? "Answer the requester text directly. If they asked a yes/no presence question, lead with that answer and keep timers secondary."
      : "",
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

    const normalized = sanitizeBotText(
      normalizeSkipSentinel(generation.text || ""),
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
  directAddressed = false,
  contextMessages = [],
  sessionId = null,
  isEagerTurn = false,
  sessionTiming = null,
  joinWindowActive = false,
  joinWindowAgeMs = null,
  voiceEagerness = 0,
  conversationContext = null,
  participantRoster = [],
  recentMembershipEvents = [],
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
  const allowSoundboardToolCall = Boolean(
    settings?.voice?.soundboard?.enabled && normalizedSoundboardCandidates.length
  );
  const allowMemoryToolCalls = Boolean(settings?.memory?.enabled);
  const allowWebSearchToolCall = Boolean(
      typeof runtime.runModelRequestedWebSearch === "function" &&
      typeof runtime.buildWebSearchContext === "function"
  );
  const allowOpenArticleToolCall = Boolean(typeof runtime.search?.readPageSummary === "function");
  const screenShare = resolveVoiceScreenShareCapability(runtime, {
    settings,
    guildId,
    channelId,
    userId
  });
  const allowScreenShareToolCall = Boolean(
    screenShare.available &&
      typeof runtime.offerVoiceScreenShareLink === "function" &&
      guildId &&
      channelId &&
      userId
  );

  const guild = runtime.client.guilds.cache.get(String(guildId || ""));
  const speakerName =
    guild?.members?.cache?.get(String(userId || ""))?.displayName ||
    guild?.members?.cache?.get(String(userId || ""))?.user?.username ||
    runtime.client.users?.cache?.get(String(userId || ""))?.username ||
    "unknown";
  const normalizedParticipantRoster = (Array.isArray(participantRoster) ? participantRoster : [])
    .map((entry) => {
      if (typeof entry === "string") {
        return String(entry).trim();
      }
      return String(entry?.displayName || entry?.name || "").trim();
    })
    .filter(Boolean)
    .slice(0, 12);
  const normalizedMembershipEvents = (Array.isArray(recentMembershipEvents) ? recentMembershipEvents : [])
    .map((entry) => {
      const eventType = String(entry?.eventType || entry?.event || "")
        .trim()
        .toLowerCase();
      if (eventType !== "join" && eventType !== "leave") return null;
      const displayName = String(entry?.displayName || entry?.name || "").trim().slice(0, 80);
      if (!displayName) return null;
      const ageMsRaw = Number(entry?.ageMs);
      const ageMs = Number.isFinite(ageMsRaw) ? Math.max(0, Math.round(ageMsRaw)) : null;
      return {
        eventType,
        displayName,
        ageMs
      };
    })
    .filter(Boolean)
    .slice(-6);

  const memoryEnabled = Boolean(settings?.memory?.enabled);
  let promptMemorySlice = emptyVoiceMemorySlice();
  const memorySlicePromise: Promise<VoiceMemorySlice> | null =
    memoryEnabled && typeof runtime.loadPromptMemorySlice === "function"
      ? runtime
          .loadPromptMemorySlice({
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
          })
          .then((slice) => normalizeVoiceMemorySlice(slice))
          .catch(() => emptyVoiceMemorySlice())
      : null;
  if (memorySlicePromise) {
    promptMemorySlice = await resolveVoiceMemorySliceWithTimeout({
      memorySlicePromise,
      fallbackSlice: promptMemorySlice,
      maxWaitMs: VOICE_MEMORY_PREFETCH_WAIT_MS
    });
  }
  const recentWebLookupsRaw =
    typeof runtime.loadRecentLookupContext === "function"
      ? runtime.loadRecentLookupContext({
          guildId,
          channelId,
          queryText: incomingTranscript,
          limit: LOOKUP_CONTEXT_PROMPT_LIMIT,
          maxAgeHours: LOOKUP_CONTEXT_PROMPT_MAX_AGE_HOURS
        })
      : [];
  const recentWebLookups = Array.isArray(recentWebLookupsRaw)
    ? recentWebLookupsRaw
    : [];

  const voiceGenerationUsesTextModel = Boolean(settings?.voice?.generationLlm?.useTextModel);
  const voiceGenerationProvider = normalizeLlmProvider(
    voiceGenerationUsesTextModel ? settings?.llm?.provider : settings?.voice?.generationLlm?.provider
  );
  const voiceGenerationModel = String(
    (voiceGenerationUsesTextModel ? settings?.llm?.model : settings?.voice?.generationLlm?.model) ||
      defaultModelForLlmProvider(voiceGenerationProvider)
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
      maxOutputTokens: clamp(Number(settings?.llm?.maxOutputTokens) || 220, 40, 420)
    }
  };

  let webSearch = allowWebSearchToolCall
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
  const webSearchAvailableNow = Boolean(
    webSearch?.enabled &&
      webSearch?.configured &&
      !webSearch?.optedOutByUser &&
      !webSearch?.blockedByBudget &&
      webSearch?.budget?.canSearch !== false
  );
  let openArticleCandidates = buildOpenArticleCandidates({
    webSearch,
    recentWebLookups
  });
  let openedArticle = null;
  let usedWebSearchFollowup = false;
  let usedOpenArticleFollowup = false;
  const effectiveJoinWindowActive =
    Boolean(joinWindowActive) || Boolean(conversationContext?.joinWindowActive);
  const explicitJoinWindowAgeMs = Number(joinWindowAgeMs);
  const contextJoinWindowAgeMs = Number(conversationContext?.joinWindowAgeMs);
  const effectiveJoinWindowAgeMs = Number.isFinite(explicitJoinWindowAgeMs)
    ? Math.max(0, Math.round(explicitJoinWindowAgeMs))
    : Number.isFinite(contextJoinWindowAgeMs)
      ? Math.max(0, Math.round(contextJoinWindowAgeMs))
      : null;

  const voiceToneGuardrails = buildVoiceToneGuardrails();
  const systemPrompt = [
    buildSystemPrompt(settings),
    "You are speaking in live Discord voice chat.",
    ...voiceToneGuardrails,
    "Return strict JSON only matching the provided schema.",
    effectiveJoinWindowActive
      ? "Join window active: you just joined VC. You can acknowledge a direct greeting naturally, but read the room first — do not jump in on every hello, especially if people are mid-conversation."
      : null,
    directAddressed
      ? "This speaker directly addressed you. Prefer skip=false with a response unless the transcript is too unclear."
      : isEagerTurn
        ? "If responding would be an interruption or you have nothing to add, set skip=true and text to [SKIP]. Otherwise set skip=false and use natural spoken text."
        : "You are not directly addressed. Reply only if you can add clear value; otherwise set skip=true and text to [SKIP].",
    "Goodbyes do not force exit. You can say goodbye and stay in VC; set leaveVoiceChannel=true only when you intentionally choose to end your own VC session now.",
    allowSoundboardToolCall ? "Never mention soundboard control refs in normal speech." : null
  ]
    .filter(Boolean)
    .join("\n");
  const buildVoiceUserPrompt = ({
    webSearchContext = webSearch,
    allowWebSearch = allowWebSearchToolCall,
    openArticleCandidatesContext = openArticleCandidates,
    openedArticleContext = openedArticle,
    allowOpenArticle = allowOpenArticleToolCall
  } = {}) =>
    buildVoiceTurnPrompt({
      speakerName,
      transcript: incomingTranscript,
      directAddressed,
      userFacts: promptMemorySlice.userFacts,
      relevantFacts: promptMemorySlice.relevantFacts,
      isEagerTurn,
      voiceEagerness,
      conversationContext,
      sessionTiming,
      joinWindowActive: effectiveJoinWindowActive,
      joinWindowAgeMs: effectiveJoinWindowAgeMs,
      botName: getPromptBotName(settings),
      participantRoster: normalizedParticipantRoster,
      recentMembershipEvents: normalizedMembershipEvents,
      soundboardCandidates: normalizedSoundboardCandidates,
      webSearch: webSearchContext,
      recentWebLookups,
      openArticleCandidates: openArticleCandidatesContext,
      openedArticle: openedArticleContext,
      allowWebSearchToolCall: allowWebSearch,
      allowOpenArticleToolCall: allowOpenArticle,
      screenShare,
      allowScreenShareToolCall,
      allowMemoryToolCalls,
      allowSoundboardToolCall
    });

  try {
    let generation = await runtime.llm.generate({
      settings: tunedSettings,
      systemPrompt,
      userPrompt: buildVoiceUserPrompt(),
      contextMessages: normalizedContextMessages,
      jsonSchema: REPLY_OUTPUT_JSON_SCHEMA,
      trace: {
        guildId,
        channelId,
        userId,
        source: "voice_stt_pipeline_generation",
        event: sessionId ? "voice_session" : "voice_turn"
      }
    });

    let parsed = parseStructuredReplyOutput(generation.text);
    if (
      allowWebSearchToolCall &&
      webSearchAvailableNow &&
      parsed.webSearchQuery &&
      typeof runtime.runModelRequestedWebSearch === "function"
    ) {
      usedWebSearchFollowup = true;
      const normalizedQuery = String(parsed.webSearchQuery || "").trim();
      let lookupStarted = false;
      try {
        if (typeof onWebLookupStart === "function") {
          lookupStarted = true;
          runAsyncCallback(onWebLookupStart, {
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
        webSearch = await runModelRequestedWebSearchWithTimeout({
          runSearch: async () =>
            await runtime.runModelRequestedWebSearch({
              settings,
              webSearch,
              query: normalizedQuery,
              trace: {
                guildId,
                channelId,
                userId,
                source: "voice_stt_pipeline_generation",
                event: sessionId ? "voice_session_web_lookup" : "voice_turn_web_lookup"
              }
            }),
          webSearch,
          query: normalizedQuery,
          timeoutMs: lookupTimeoutMs
        });
        if (
          webSearch?.used &&
          Array.isArray(webSearch?.results) &&
          webSearch.results.length > 0 &&
          typeof runtime.rememberRecentLookupContext === "function"
        ) {
          runtime.rememberRecentLookupContext({
            guildId,
            channelId,
            userId,
            source: sessionId ? "voice_session_web_lookup" : "voice_turn_web_lookup",
            query: webSearch.query || normalizedQuery,
            provider: webSearch.providerUsed || null,
            results: webSearch.results
          });
        }
      } finally {
        if (lookupStarted && typeof onWebLookupComplete === "function") {
          runAsyncCallback(onWebLookupComplete, {
            query: normalizedQuery,
            guildId,
            channelId,
            userId
          });
        }
      }
      openArticleCandidates = buildOpenArticleCandidates({
        webSearch,
        recentWebLookups
      });
      promptMemorySlice = await resolveVoiceMemorySliceWithTimeout({
        memorySlicePromise,
        fallbackSlice: promptMemorySlice,
        maxWaitMs: VOICE_MEMORY_FOLLOWUP_WAIT_MS
      });

      generation = await runtime.llm.generate({
        settings: tunedSettings,
        systemPrompt,
        userPrompt: buildVoiceUserPrompt({
          webSearchContext: webSearch,
          allowWebSearch: false,
          openArticleCandidatesContext: openArticleCandidates
        }),
        contextMessages: normalizedContextMessages,
        jsonSchema: REPLY_OUTPUT_JSON_SCHEMA,
        trace: {
          guildId,
          channelId,
          userId,
          source: "voice_stt_pipeline_generation",
          event: sessionId ? "voice_session_lookup_followup" : "voice_turn_lookup_followup"
        }
      });
      parsed = parseStructuredReplyOutput(generation.text);
    }

    openArticleCandidates = buildOpenArticleCandidates({
      webSearch,
      recentWebLookups
    });

    if (allowOpenArticleToolCall && parsed.openArticleRef) {
      usedOpenArticleFollowup = true;
      const requestedRef = normalizeOpenArticleRef(parsed.openArticleRef);
      const resolvedOpenArticle = resolveOpenArticleCandidate({
        ref: requestedRef,
        candidates: openArticleCandidates
      });

      if (resolvedOpenArticle) {
        let openArticleError = "";
        let openArticleResult = null;
        try {
          openArticleResult = await runtime.search.readPageSummary(
            resolvedOpenArticle.url,
            resolveVoiceOpenArticleMaxChars(settings)
          );
        } catch (error) {
          openArticleError = String(error?.message || error);
        }

        const openedContent = String(openArticleResult?.summary || "").trim();
        openedArticle = {
          ref: resolvedOpenArticle.ref,
          title: String(openArticleResult?.title || resolvedOpenArticle.title || "").trim() || null,
          url: resolvedOpenArticle.url,
          domain: resolvedOpenArticle.domain,
          query: resolvedOpenArticle.query,
          extractionMethod: String(openArticleResult?.extractionMethod || "").trim() || null,
          content: openedContent,
          error:
            openArticleError ||
            (openedContent ? "" : "opened article had no usable text")
        };
      } else {
        openedArticle = {
          ref: requestedRef,
          title: null,
          url: "",
          domain: "",
          query: "",
          extractionMethod: null,
          content: "",
          error: "could not resolve that article ref from cached lookup results"
        };
      }
      promptMemorySlice = await resolveVoiceMemorySliceWithTimeout({
        memorySlicePromise,
        fallbackSlice: promptMemorySlice,
        maxWaitMs: VOICE_MEMORY_FOLLOWUP_WAIT_MS
      });

      generation = await runtime.llm.generate({
        settings: tunedSettings,
        systemPrompt,
        userPrompt: buildVoiceUserPrompt({
          webSearchContext: webSearch,
          allowWebSearch: false,
          openArticleCandidatesContext: openArticleCandidates,
          openedArticleContext: openedArticle,
          allowOpenArticle: false
        }),
        contextMessages: normalizedContextMessages,
        jsonSchema: REPLY_OUTPUT_JSON_SCHEMA,
        trace: {
          guildId,
          channelId,
          userId,
          source: "voice_stt_pipeline_generation",
          event: sessionId ? "voice_session_open_article_followup" : "voice_turn_open_article_followup"
        }
      });
      parsed = parseStructuredReplyOutput(generation.text);
    }

    let usedScreenShareOffer = false;
    if (
      allowScreenShareToolCall &&
      parsed.screenShareIntent?.action === "offer_link" &&
      typeof runtime.offerVoiceScreenShareLink === "function"
    ) {
      try {
        const offered = await runtime.offerVoiceScreenShareLink({
          settings,
          guildId,
          channelId,
          requesterUserId: String(userId),
          transcript: incomingTranscript,
          source: sessionId ? "voice_session_tool_call" : "voice_turn_tool_call"
        });
        usedScreenShareOffer = Boolean(offered?.offered);
      } catch (error) {
        runtime.store?.logAction?.({
          kind: "voice_error",
          guildId,
          channelId,
          userId,
          content: `voice_screen_share_offer_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId
          }
        });
      }
    }

    const soundboardRefs = allowSoundboardToolCall
      ? (Array.isArray(parsed.soundboardRefs) ? parsed.soundboardRefs : [])
          .map((entry) =>
            String(entry || "")
              .trim()
              .slice(0, 180)
          )
          .filter(Boolean)
          .slice(0, MAX_VOICE_SOUNDBOARD_REFS)
      : [];
    const leaveVoiceChannelRequested = Boolean(parsed.leaveVoiceChannel);
    const voiceAddressing = normalizeGeneratedVoiceAddressing(parsed.voiceAddressing, {
      directAddressed: Boolean(directAddressed)
    });
    const soundboardSafeText = String(parsed.text || generation.text || "");
    const baseText = sanitizeBotText(normalizeSkipSentinel(soundboardSafeText), 520);
    const finalText = sanitizeSoundboardSpeechLeak({
      text: baseText,
      soundboardRefs,
      soundboardCandidates: normalizedSoundboardCandidates
    });
    if ((!finalText || finalText === "[SKIP]") && soundboardRefs.length === 0 && !leaveVoiceChannelRequested) {
      return {
        text: "",
        soundboardRefs: [],
        usedWebSearchFollowup,
        usedOpenArticleFollowup,
        usedScreenShareOffer,
        voiceAddressing
      };
    }
    if (!finalText || finalText === "[SKIP]") {
      const response = {
        text: "",
        soundboardRefs,
        usedWebSearchFollowup,
        usedOpenArticleFollowup,
        usedScreenShareOffer,
        voiceAddressing
      };
      if (leaveVoiceChannelRequested) {
        return {
          ...response,
          leaveVoiceChannelRequested: true
        };
      }
      return response;
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

    const response = {
      text: finalText,
      soundboardRefs,
      usedWebSearchFollowup,
      usedOpenArticleFollowup,
      usedScreenShareOffer,
      voiceAddressing
    };
    if (leaveVoiceChannelRequested) {
      return {
        ...response,
        leaveVoiceChannelRequested: true
      };
    }
    return response;
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

function normalizeGeneratedVoiceAddressing(rawAddressing, { directAddressed = false } = {}) {
  const normalizedRaw = rawAddressing && typeof rawAddressing === "object" ? rawAddressing : null;
  const talkingToToken = String(normalizedRaw?.talkingTo || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  let talkingTo = talkingToToken || null;

  const directedConfidenceRaw = Number(normalizedRaw?.directedConfidence);
  let directedConfidence = Number.isFinite(directedConfidenceRaw) ? clamp(directedConfidenceRaw, 0, 1) : 0;

  if (directAddressed && !talkingTo) {
    talkingTo = "ME";
  }
  if (directAddressed && talkingTo === "ME") {
    directedConfidence = Math.max(directedConfidence, 0.72);
  }

  return {
    talkingTo,
    directedConfidence
  };
}

function resolveVoiceScreenShareCapability(runtime, { settings, guildId, channelId, userId }) {
  if (typeof runtime?.getVoiceScreenShareCapability !== "function") {
    return {
      supported: false,
      enabled: false,
      available: false,
      status: "disabled",
      publicUrl: "",
      reason: "screen_share_capability_unavailable"
    };
  }

  const capability = runtime.getVoiceScreenShareCapability({
    settings,
    guildId,
    channelId,
    requesterUserId: userId
  });
  const status = String(capability?.status || "disabled").trim().toLowerCase() || "disabled";
  const enabled = Boolean(capability?.enabled);
  const available = capability?.available === undefined ? enabled && status === "ready" : Boolean(capability.available);
  const rawReason = String(capability?.reason || "").trim().toLowerCase();
  const supported =
    capability?.supported === undefined
      ? rawReason !== "screen_share_manager_unavailable"
      : Boolean(capability.supported);
  return {
    supported,
    enabled,
    available,
    status,
    publicUrl: String(capability?.publicUrl || "").trim(),
    reason: available ? null : rawReason || status || "unavailable"
  };
}

function resolveVoiceWebSearchTimeoutMs({ settings, overrideMs }) {
  const explicit = Number(overrideMs);
  const configured = Number(settings?.voice?.webSearchTimeoutMs);
  const raw = Number.isFinite(explicit) ? explicit : Number.isFinite(configured) ? configured : 8000;
  return clamp(Math.floor(raw), 500, 45000);
}

function resolveVoiceOpenArticleMaxChars(settings) {
  const configured = Number(settings?.webSearch?.maxCharsPerPage);
  const atLeastDefault = Number.isFinite(configured)
    ? Math.max(Math.floor(configured), OPEN_ARTICLE_DEFAULT_MAX_CHARS)
    : OPEN_ARTICLE_DEFAULT_MAX_CHARS;
  return clamp(atLeastDefault, 2_000, 24_000);
}

function normalizeOpenArticleRef(rawRef) {
  const normalized = String(rawRef || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, OPEN_ARTICLE_REF_MAX_LEN);
  return normalized || "first";
}

function buildOpenArticleCandidates({ webSearch, recentWebLookups }) {
  const candidates = [];
  const seenUrls = new Set();
  const pushCandidate = ({
    ref,
    title,
    url,
    domain,
    query
  }) => {
    const normalizedRef = String(ref || "").trim();
    const normalizedUrl = String(url || "").trim();
    if (!normalizedRef || !normalizedUrl || seenUrls.has(normalizedUrl)) return;
    seenUrls.add(normalizedUrl);
    candidates.push({
      ref: normalizedRef,
      title: String(title || "untitled").trim() || "untitled",
      url: normalizedUrl,
      domain: String(domain || "").trim(),
      query: String(query || "").trim()
    });
  };

  const currentResults = (Array.isArray(webSearch?.results) ? webSearch.results : [])
    .slice(0, OPEN_ARTICLE_RESULTS_PER_ROW);
  for (let index = 0; index < currentResults.length; index += 1) {
    const row = currentResults[index];
    const url = String(row?.url || "").trim();
    if (!url) continue;
    pushCandidate({
      ref: `R0:${index + 1}`,
      title: row?.title,
      url,
      domain: row?.domain,
      query: webSearch?.query || ""
    });
  }

  const cachedRows = (Array.isArray(recentWebLookups) ? recentWebLookups : []).slice(0, OPEN_ARTICLE_ROW_LIMIT);
  for (let rowIndex = 0; rowIndex < cachedRows.length; rowIndex += 1) {
    const row = cachedRows[rowIndex];
    const rowResults = (Array.isArray(row?.results) ? row.results : []).slice(0, OPEN_ARTICLE_RESULTS_PER_ROW);
    for (let resultIndex = 0; resultIndex < rowResults.length; resultIndex += 1) {
      const result = rowResults[resultIndex];
      const url = String(result?.url || "").trim();
      if (!url) continue;
      pushCandidate({
        ref: `R${rowIndex + 1}:${resultIndex + 1}`,
        title: result?.title,
        url,
        domain: result?.domain,
        query: row?.query
      });
    }
  }

  if (!candidates.length) return [];
  const first = candidates[0];
  const withAliases = [first, ...candidates.slice(1)];
  if (first) {
    withAliases.unshift({
      ...first,
      ref: "first"
    });
  }
  return withAliases.slice(0, OPEN_ARTICLE_MAX_CANDIDATES);
}

function resolveOpenArticleCandidate({ ref, candidates }) {
  const normalizedRef = normalizeOpenArticleRef(ref).toLowerCase();
  const rows = Array.isArray(candidates) ? candidates : [];
  if (!rows.length) return null;

  if (normalizedRef === "first") {
    return rows.find((row) => String(row?.ref || "").toLowerCase() === "first") || rows[0];
  }

  const exact = rows.find((row) => String(row?.ref || "").toLowerCase() === normalizedRef);
  if (exact) return exact;

  if (OPEN_ARTICLE_URL_RE.test(normalizedRef)) {
    return rows.find((row) => String(row?.url || "").toLowerCase() === normalizedRef) || null;
  }

  if (OPEN_ARTICLE_INDEX_REF_RE.test(normalizedRef)) {
    const wantedIndex = Number(normalizedRef);
    if (Number.isInteger(wantedIndex) && wantedIndex > 0) {
      const indexedRows = rows.filter((row) =>
        OPEN_ARTICLE_ROW_REF_RE.test(String(row?.ref || ""))
      );
      return indexedRows[wantedIndex - 1] || null;
    }
  }

  return null;
}

function sanitizeSoundboardSpeechLeak({
  text,
  soundboardRefs,
  soundboardCandidates
}) {
  const spoken = String(text || "").trim();
  const normalizedRefs = (Array.isArray(soundboardRefs) ? soundboardRefs : [])
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .slice(0, MAX_VOICE_SOUNDBOARD_REFS);
  if (!spoken || normalizedRefs.length === 0) return spoken;

  const parsedCandidates = parseSoundboardCandidateLines(soundboardCandidates);
  const tokensToRemove = [];
  for (const normalizedRef of normalizedRefs) {
    const selectedCandidate = parsedCandidates.find(
      (candidate) => candidate.reference.toLowerCase() === normalizedRef.toLowerCase()
    );
    tokensToRemove.push(
      normalizedRef,
      normalizedRef.split("@")[0] || "",
      selectedCandidate?.reference || "",
      selectedCandidate?.reference.split("@")[0] || "",
      selectedCandidate?.name || ""
    );
  }
  const dedupedTokens = [...new Set(tokensToRemove.map((token) => String(token || "").trim()).filter(Boolean))].slice(
    0,
    MAX_SOUNDBOARD_LEAK_TOKEN_SCAN
  );

  let cleaned = spoken;
  for (const token of dedupedTokens) {
    cleaned = removeCaseInsensitivePhrase(cleaned, token);
  }

  return cleaned
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .trim();
}

function parseSoundboardCandidateLines(lines) {
  const source = Array.isArray(lines) ? lines : [];
  const parsed = [];
  for (const line of source.slice(0, SOUNDBOARD_CANDIDATE_PARSE_LIMIT)) {
    const raw = String(line || "")
      .replace(/^\s*-\s*/, "")
      .trim();
    if (!raw) continue;
    const [referencePart, namePart] = raw.split("|");
    const reference = String(referencePart || "").trim();
    if (!reference) continue;
    const name = String(namePart || "").trim();
    parsed.push({
      reference,
      name: name || ""
    });
  }
  return parsed;
}

function removeCaseInsensitivePhrase(text, phrase) {
  const source = String(text || "");
  const token = String(phrase || "").trim();
  if (!source || !token) return source;

  const escaped = escapeRegex(token);
  const pattern = SOUNDBOARD_SIMPLE_TOKEN_RE.test(token)
    ? new RegExp(`\\b${escaped}\\b`, "gi")
    : new RegExp(escaped, "gi");

  return source.replace(pattern, " ");
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
