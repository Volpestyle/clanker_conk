import { defaultModelForLlmProvider, normalizeLlmProvider } from "./llm/llmHelpers.ts";
import { clamp } from "./utils.ts";

const DIRECT_ADDRESS_JSON_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["confidence", "addressed", "reason"],
  properties: {
    confidence: { type: "number", minimum: 0, maximum: 1 },
    addressed: { type: "boolean" },
    reason: { type: "string", maxLength: 120 }
  }
});

export const DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD = 0.62;
const EN_GENERIC_NAME_TOKENS = new Set(["bot", "assistant", "ai", "the"]);

type LlmTrace = {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string | null;
  event?: string | null;
  reason?: string | null;
  messageId?: string | null;
};

type LlmGeneratePayload = {
  settings: Record<string, unknown>;
  systemPrompt: string;
  userPrompt: string;
  contextMessages?: Array<Record<string, unknown>>;
  jsonSchema?: string;
  trace?: LlmTrace;
};

type LlmGenerateResult = {
  text?: string;
  provider?: string;
  model?: string;
};

type LlmRuntime = {
  generate?: (payload: LlmGeneratePayload) => Promise<LlmGenerateResult>;
} | null;

type ParsedAddressConfidence = {
  parsed: boolean;
  confidence: number;
  addressed: boolean;
  reason: string;
};

export type DirectAddressConfidenceResult = {
  confidence: number;
  threshold: number;
  addressed: boolean;
  reason: string;
  source: "llm" | "fallback";
  llmProvider: string | null;
  llmModel: string | null;
  llmResponse: string | null;
  error: string | null;
};

type ScoreDirectAddressConfidenceArgs = {
  llm?: LlmRuntime;
  settings?: Record<string, unknown> | null;
  transcript?: string;
  botName?: string;
  mode?: "text" | "voice";
  speakerName?: string;
  participantNames?: string[];
  threshold?: number;
  fallbackConfidence?: number;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  trace?: LlmTrace;
};

export async function scoreDirectAddressConfidence({
  llm = null,
  settings = null,
  transcript = "",
  botName = "",
  mode = "text",
  speakerName = "",
  participantNames = [],
  threshold = DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD,
  fallbackConfidence = 0,
  provider = "",
  model = "",
  reasoningEffort = "minimal",
  trace = {}
}: ScoreDirectAddressConfidenceArgs = {}): Promise<DirectAddressConfidenceResult> {
  const normalizedThreshold = clamp(Number(threshold) || DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD, 0.4, 0.95);
  const normalizedFallback = clamp(Number(fallbackConfidence) || 0, 0, 1);
  const normalizedTranscript = String(transcript || "").trim();
  const normalizedBotName = String(botName || "").trim() || "the bot";
  const normalizedMode = mode === "voice" ? "voice" : "text";

  const fallbackResult = buildFallbackResult({
    confidence: normalizedFallback,
    threshold: normalizedThreshold,
    reason: "llm_unavailable"
  });
  if (!normalizedTranscript) {
    return {
      ...fallbackResult,
      reason: "empty_transcript"
    };
  }
  if (!llm || typeof llm.generate !== "function") {
    return fallbackResult;
  }

  const llmConfig = resolveAddressingModelConfig({
    settings,
    mode: normalizedMode,
    provider,
    model
  });
  const baseLlmSettings = readRecord(settings?.llm);
  const generationSettings = {
    ...(settings && typeof settings === "object" ? settings : {}),
    llm: {
      ...baseLlmSettings,
      provider: llmConfig.provider,
      model: llmConfig.model,
      temperature: 0,
      maxOutputTokens: 80,
      reasoningEffort: String(reasoningEffort || "minimal").trim().toLowerCase() || "minimal"
    }
  };

  const participants = (Array.isArray(participantNames) ? participantNames : [])
    .map((name) => String(name || "").trim())
    .filter(Boolean)
    .slice(0, 12);
  const speaker = String(speakerName || "").trim();
  const userPrompt = [
    `Mode: ${normalizedMode}`,
    `Bot name: ${normalizedBotName}`,
    speaker ? `Speaker: ${speaker}` : "",
    participants.length ? `Participants: ${participants.join(", ")}` : "Participants: none provided",
    `Transcript: "${normalizedTranscript}"`
  ]
    .filter(Boolean)
    .join("\n");

  const systemPrompt = [
    `Classify whether the speaker is addressing ${normalizedBotName} right now.`,
    "Return strict JSON only with keys: confidence (0..1), addressed (boolean), reason (short snake_case or kebab-case).",
    "confidence means probability the utterance is directed at the bot, not just a rhyme/soundalike token.",
    "Treat clear direct questions/requests to the bot as high confidence.",
    "If the utterance is clearly aimed at another named participant, confidence should be low.",
    "Do not use rhyme-only similarity as direct-address evidence."
  ].join("\n");

  try {
    const generation = await llm.generate({
      settings: generationSettings,
      systemPrompt,
      userPrompt,
      contextMessages: [],
      jsonSchema: DIRECT_ADDRESS_JSON_SCHEMA,
      trace: {
        guildId: trace.guildId || null,
        channelId: trace.channelId || null,
        userId: trace.userId || null,
        source: trace.source || "direct_address_confidence",
        event: trace.event || `${normalizedMode}_classification`,
        reason: trace.reason || null,
        messageId: trace.messageId || null
      }
    });
    const raw = String(generation?.text || "").trim();
    const parsed = parseAddressConfidence(raw, normalizedThreshold);
    if (!parsed.parsed) {
      return {
        ...buildFallbackResult({
          confidence: normalizedFallback,
          threshold: normalizedThreshold,
          reason: "llm_contract_violation"
        }),
        llmProvider: generation?.provider ? String(generation.provider) : null,
        llmModel: generation?.model ? String(generation.model) : llmConfig.model,
        llmResponse: raw || null
      };
    }

    const resolvedConfidence = clamp(
      Math.max(parsed.confidence, normalizedFallback),
      0,
      1
    );
    const addressed = parsed.addressed || resolvedConfidence >= normalizedThreshold;
    return {
      confidence: resolvedConfidence,
      threshold: normalizedThreshold,
      addressed,
      reason: parsed.reason || (addressed ? "llm_direct_address" : "llm_not_direct_address"),
      source: "llm",
      llmProvider: generation?.provider ? String(generation.provider) : llmConfig.provider,
      llmModel: generation?.model ? String(generation.model) : llmConfig.model,
      llmResponse: raw || null,
      error: null
    };
  } catch (error) {
    return {
      ...buildFallbackResult({
        confidence: normalizedFallback,
        threshold: normalizedThreshold,
        reason: "llm_error"
      }),
      error: String(error?.message || error)
    };
  }
}

export function hasBotNameCue({
  transcript = "",
  botName = ""
}: {
  transcript?: string;
  botName?: string;
}) {
  const primary = pickPrimaryBotToken(tokenize(botName));
  if (!primary) return false;
  const transcriptTokens = tokenize(transcript);
  if (!transcriptTokens.length) return false;
  for (const token of transcriptTokens) {
    if (isLikelyNameCueToken(token, primary)) return true;
  }
  return false;
}

function resolveAddressingModelConfig({
  settings = null,
  mode = "text",
  provider = "",
  model = ""
}: {
  settings?: Record<string, unknown> | null;
  mode?: "text" | "voice";
  provider?: string;
  model?: string;
}) {
  const voiceSettings = readRecord(settings?.voice);
  const voiceReplyDecision = readRecord(voiceSettings.replyDecisionLlm);
  const llmSettings = readRecord(settings?.llm);
  const defaultProvider =
    mode === "voice" && Object.keys(voiceReplyDecision).length > 0
      ? normalizeLlmProvider(
          voiceReplyDecision.provider,
          String(llmSettings.provider || "anthropic")
        )
      : normalizeLlmProvider(
          provider || llmSettings.provider,
          "anthropic"
        );

  const preferredModel =
    String(model || "").trim() ||
    (
      mode === "voice" && Object.keys(voiceReplyDecision).length > 0
        ? String(voiceReplyDecision.model || "").trim()
        : ""
    ) ||
    String(llmSettings.model || "").trim();
  const resolvedModel = preferredModel || defaultModelForLlmProvider(defaultProvider);
  return {
    provider: defaultProvider,
    model: resolvedModel.slice(0, 120) || defaultModelForLlmProvider(defaultProvider)
  };
}

function buildFallbackResult({
  confidence = 0,
  threshold = DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD,
  reason = "fallback"
}: {
  confidence?: number;
  threshold?: number;
  reason?: string;
}): DirectAddressConfidenceResult {
  const normalizedConfidence = clamp(Number(confidence) || 0, 0, 1);
  const normalizedThreshold = clamp(Number(threshold) || DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD, 0.4, 0.95);
  return {
    confidence: normalizedConfidence,
    threshold: normalizedThreshold,
    addressed: normalizedConfidence >= normalizedThreshold,
    reason: String(reason || "fallback").trim().toLowerCase() || "fallback",
    source: "fallback",
    llmProvider: null,
    llmModel: null,
    llmResponse: null,
    error: null
  };
}

function parseAddressConfidence(raw = "", threshold = DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD): ParsedAddressConfidence {
  const normalized = String(raw || "").trim();
  if (!normalized) {
    return {
      parsed: false,
      confidence: 0,
      addressed: false,
      reason: ""
    };
  }
  const unwrapped = normalized.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  try {
    const parsed = JSON.parse(unwrapped);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        parsed: false,
        confidence: 0,
        addressed: false,
        reason: ""
      };
    }

    const row = readRecord(parsed);
    const confidenceValue = firstNumber([
      row.confidence,
      row.score,
      row.probability
    ]);
    const boolValue = firstBoolean([
      row.addressed,
      row.directAddressed,
      row.direct
    ]);
    const decision = String(row.decision || row.answer || "").trim().toUpperCase();
    const addressedFromDecision = decision === "YES" ? true : decision === "NO" ? false : null;
    const resolvedConfidence = clamp(
      Number.isFinite(confidenceValue)
        ? Number(confidenceValue)
        : boolValue === true || addressedFromDecision === true
          ? 1
          : boolValue === false || addressedFromDecision === false
            ? 0
            : 0,
      0,
      1
    );
    const addressed =
      boolValue !== null
        ? boolValue
        : addressedFromDecision !== null
          ? addressedFromDecision
          : resolvedConfidence >= clamp(Number(threshold) || DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD, 0.4, 0.95);
    return {
      parsed: Number.isFinite(confidenceValue) || boolValue !== null || addressedFromDecision !== null,
      confidence: resolvedConfidence,
      addressed,
      reason: normalizeReason(row.reason)
    };
  } catch {
    return {
      parsed: false,
      confidence: 0,
      addressed: false,
      reason: ""
    };
  }
}

function normalizeReason(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 120);
}

function readRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = entry;
  }
  return out;
}

function firstNumber(values: unknown[]) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return Number.NaN;
}

function tokenize(value = "") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "");
  const matches = normalized.match(/[\p{L}\p{N}]+/gu);
  return Array.isArray(matches) ? matches : [];
}

function pickPrimaryBotToken(tokens: string[] = []) {
  if (!Array.isArray(tokens) || !tokens.length) return "";
  const filtered = tokens.filter((token) => token.length >= 4 && !EN_GENERIC_NAME_TOKENS.has(token));
  const candidates = filtered.length ? filtered : tokens.filter((token) => token.length >= 4);
  if (!candidates.length) return "";
  return [...candidates].sort((left, right) => right.length - left.length)[0] || "";
}

function isLikelyNameCueToken(token = "", primary = "") {
  const normalizedToken = String(token || "").trim().toLowerCase();
  const normalizedPrimary = String(primary || "").trim().toLowerCase();
  if (!normalizedToken || !normalizedPrimary) return false;
  if (normalizedToken.length < 4 || normalizedPrimary.length < 4) return false;
  if (normalizedToken === normalizedPrimary) return true;

  const tokenPrefix = normalizedToken.slice(0, 3);
  const primaryPrefix = normalizedPrimary.slice(0, 3);
  if (tokenPrefix === primaryPrefix) return true;
  const shortTokenPrefix = normalizedToken.slice(0, 2);
  const shortPrimaryPrefix = normalizedPrimary.slice(0, 2);
  if (
    shortTokenPrefix.length === 2 &&
    shortTokenPrefix === shortPrimaryPrefix &&
    sharedConsonantCount(normalizedToken, normalizedPrimary) >= 2
  ) {
    return true;
  }
  if (sharedConsonantCount(normalizedToken, normalizedPrimary) >= 3) {
    return true;
  }

  const distance = levenshteinDistance(normalizedToken, normalizedPrimary);
  const maxLen = Math.max(normalizedToken.length, normalizedPrimary.length);
  const normalizedSimilarity = maxLen > 0 ? 1 - distance / maxLen : 0;
  if (normalizedSimilarity >= 0.58 && sharedConsonantCount(normalizedToken, normalizedPrimary) >= 2) {
    return true;
  }

  return false;
}

function sharedConsonantCount(left = "", right = "") {
  const leftSet = new Set(consonants(left));
  const rightSet = new Set(consonants(right));
  let count = 0;
  for (const char of leftSet) {
    if (rightSet.has(char)) count += 1;
  }
  return count;
}

function consonants(value = "") {
  const letters = String(value || "").toLowerCase().replace(/[^a-z]/g, "");
  const out = [];
  for (const char of letters) {
    if ("aeiou".includes(char)) continue;
    out.push(char);
  }
  return out;
}

function levenshteinDistance(left = "", right = "") {
  const a = String(left || "");
  const b = String(right || "");
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from(
    { length: rows },
    (_, row) => Array.from({ length: cols }, (_, col) => (row === 0 ? col : col === 0 ? row : 0))
  );

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = a[row - 1] === b[col - 1] ? 0 : 1;
      const deletion = matrix[row - 1][col] + 1;
      const insertion = matrix[row][col - 1] + 1;
      const substitution = matrix[row - 1][col - 1] + cost;
      matrix[row][col] = Math.min(deletion, insertion, substitution);
    }
  }

  return matrix[rows - 1][cols - 1];
}

function firstBoolean(values: unknown[]) {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "true" || normalized === "yes" || normalized === "1") return true;
    if (normalized === "false" || normalized === "no" || normalized === "0") return false;
  }
  return null;
}
