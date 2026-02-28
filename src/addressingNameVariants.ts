const GENERIC_BOT_TOKENS = new Set([
  "bot",
  "assistant",
  "ai",
  "the",
  "mr",
  "mrs",
  "ms"
]);

const GREETING_TOKENS = new Set([
  "yo",
  "hi",
  "hey",
  "hello"
]);

const NON_NAME_CALL_TOKENS = new Set([
  "everyone",
  "everybody",
  "chat",
  "guys",
  "team",
  "all",
  "yall",
  "there",
  "here"
]);

const HARD_ANCHOR_CHARS = new Set([
  "k",
  "q",
  "x",
  "z",
  "j"
]);

const VOICE_COMMAND_ACTION_TOKENS = new Set([
  "join",
  "hop",
  "hopping",
  "rejoin",
  "get",
  "come",
  "leave",
  "disconnect",
  "watch",
  "stop"
]);

const VOICE_COMMAND_CONTEXT_TOKENS = new Set([
  "vc",
  "voice",
  "channel",
  "call",
  "chat",
  "stream"
]);

const PHONETIC_CODE = new Map([
  ["b", "1"],
  ["f", "1"],
  ["p", "1"],
  ["v", "1"],
  ["c", "2"],
  ["g", "2"],
  ["j", "2"],
  ["k", "2"],
  ["q", "2"],
  ["s", "2"],
  ["x", "2"],
  ["z", "2"],
  ["d", "3"],
  ["t", "3"],
  ["l", "4"],
  ["m", "5"],
  ["n", "5"],
  ["r", "6"]
]);

const NAME_VARIANT_MATCH_THRESHOLD = 0.78;
const STEM_MATCH_BASE_SCORE = 0.72;
const NAME_LIKE_TOKEN_SCORE_THRESHOLD = 0.56;
const NO_ANCHOR_SCORE_CAP = 0.5;
const SUPPORTING_BOT_TOKEN_BOOST = 0.18;
const GREETING_CALLOUT_BOOST = 0.26;
const QUESTION_CALLOUT_BOOST = 0.22;
const DID_HEAR_CALLOUT_BOOST = 0.22;
const AFFECTION_CALLOUT_BOOST = 0.14;
const VOICE_COMMAND_BOOST = 0.18;
const VOICE_COMMAND_MAX_SHAPE_DISTANCE = 4;
const VOICE_COMMAND_MAX_TARGET_DISTANCE = 2;

type VoiceCommandContext = {
  active: boolean,
  actionIndices: number[],
  contextIndices: number[]
};

type TokenScore = {
  baseScore: number,
  signals: string[]
};

type ScoredTokenMatch = {
  token: string,
  index: number,
  baseScore: number,
  totalScore: number,
  signals: string[]
};

export type BotNameVariantScore = {
  matched: boolean,
  score: number,
  threshold: number,
  matchedToken: string | null,
  matchedTokenIndex: number | null,
  primaryBotToken: string,
  signals: string[]
};

export function isLikelyBotNameVariantAddress(transcript = "", botName = "") {
  return scoreBotNameVariantAddress(transcript, botName).matched;
}

export function scoreBotNameVariantAddress(transcript = "", botName = ""): BotNameVariantScore {
  const transcriptTokens = tokenize(transcript);
  const botTokens = tokenize(botName);
  const primaryBotToken = pickPrimaryBotToken(botTokens);
  if (!transcriptTokens.length || !primaryBotToken) {
    return emptyBotNameVariantScore(primaryBotToken);
  }

  const voiceCommandContext = resolveVoiceCommandContext(transcriptTokens);
  let bestMatch: ScoredTokenMatch | null = null;

  for (let index = 0; index < transcriptTokens.length; index += 1) {
    const token = String(transcriptTokens[index] || "").trim().toLowerCase();
    if (!token) continue;

    const tokenScore = scoreNameLikeToken(token, primaryBotToken);
    if (tokenScore.baseScore <= 0) continue;

    let totalScore = tokenScore.baseScore;
    const signals = [...tokenScore.signals];
    const match = { token, index, primaryBotToken };

    if (hasSupportingBotToken(transcriptTokens, botTokens, match)) {
      totalScore += SUPPORTING_BOT_TOKEN_BOOST;
      signals.push("supporting_bot_token");
    }

    if (isGreetingCallout(transcriptTokens, index) || isGreetingCalloutByShape(transcriptTokens, primaryBotToken)) {
      totalScore += GREETING_CALLOUT_BOOST;
      signals.push("greeting_callout");
    }
    if (isIsThatYouCallout(transcriptTokens, index) || isIsThatYouCalloutByShape(transcriptTokens, primaryBotToken)) {
      totalScore += QUESTION_CALLOUT_BOOST;
      signals.push("is_that_you_callout");
    }
    if (
      isDidIJustHearCallout(transcriptTokens, index) ||
      isDidIJustHearCalloutByShape(transcriptTokens, primaryBotToken)
    ) {
      totalScore += DID_HEAR_CALLOUT_BOOST;
      signals.push("did_i_just_hear_callout");
    }
    if (isAffectionCallout(transcriptTokens, index)) {
      totalScore += AFFECTION_CALLOUT_BOOST;
      signals.push("affection_callout");
    }

    if (
      voiceCommandContext.active &&
      tokenScore.baseScore >= NAME_LIKE_TOKEN_SCORE_THRESHOLD &&
      isVoiceCommandTargetIndex(index, voiceCommandContext)
    ) {
      totalScore += VOICE_COMMAND_BOOST;
      signals.push("voice_command_shape");
    }

    const boundedScore = clamp(totalScore, 0, 1);
    if (
      !bestMatch ||
      boundedScore > bestMatch.totalScore ||
      (boundedScore === bestMatch.totalScore && tokenScore.baseScore > bestMatch.baseScore)
    ) {
      bestMatch = {
        token,
        index,
        baseScore: tokenScore.baseScore,
        totalScore: boundedScore,
        signals
      };
    }
  }

  if (!bestMatch) {
    return emptyBotNameVariantScore(primaryBotToken);
  }

  const finalScore = roundScore(bestMatch.totalScore);
  const matched = finalScore >= NAME_VARIANT_MATCH_THRESHOLD;
  return {
    matched,
    score: finalScore,
    threshold: NAME_VARIANT_MATCH_THRESHOLD,
    matchedToken: matched ? bestMatch.token : null,
    matchedTokenIndex: matched ? bestMatch.index : null,
    primaryBotToken,
    signals: matched ? [...new Set(bestMatch.signals)] : []
  };
}

function emptyBotNameVariantScore(primaryBotToken = ""): BotNameVariantScore {
  return {
    matched: false,
    score: 0,
    threshold: NAME_VARIANT_MATCH_THRESHOLD,
    matchedToken: null,
    matchedTokenIndex: null,
    primaryBotToken: String(primaryBotToken || ""),
    signals: []
  };
}

function scoreNameLikeToken(token = "", primaryBotToken = ""): TokenScore {
  const normalized = String(token || "").trim().toLowerCase();
  const primary = String(primaryBotToken || "").trim().toLowerCase();
  if (!normalized || !primary) return { baseScore: 0, signals: [] };
  if (normalized.length < 4 || primary.length < 4) return { baseScore: 0, signals: [] };
  if (!/^[\p{L}\p{N}]+$/u.test(normalized)) return { baseScore: 0, signals: [] };
  if (NON_NAME_CALL_TOKENS.has(normalized)) return { baseScore: 0, signals: [] };

  const normalizedStem = stemToken(normalized);
  const primaryStem = stemToken(primary);
  if (normalized === primary || (normalizedStem && primaryStem && normalizedStem === primaryStem)) {
    return {
      baseScore: STEM_MATCH_BASE_SCORE,
      signals: ["stem_match"]
    };
  }

  const signals = [];
  const maxLen = Math.max(normalized.length, primary.length);
  const distance = levenshteinDistance(normalized, primary);
  const normalizedDistanceScore = maxLen > 0 ? clamp(1 - distance / maxLen, 0, 1) : 0;
  const prefixScore = commonPrefixLength(normalized, primary) >= 2 ? 1 : 0;
  const consonantOverlapRatio = sharedConsonantRatio(primary, normalized);
  const consonantOverlapCount = sharedConsonantCount(primary, normalized);
  const orderedConsonantOverlap = orderedConsonantOverlapRatio(primary, normalized);
  const phoneticMatch = phoneticTail(normalized) && phoneticTail(normalized) === phoneticTail(primary);
  const anchorMatched = sharesHardAnchor(primary, normalized);

  let baseScore = 0;
  baseScore += normalizedDistanceScore * 0.45;
  baseScore += consonantOverlapRatio * 0.24;
  baseScore += orderedConsonantOverlap * 0.08;
  baseScore += prefixScore * 0.07;
  if (phoneticMatch) baseScore += 0.18;
  if (anchorMatched) baseScore += 0.06;
  if (anchorMatched && consonantOverlapCount >= 3 && orderedConsonantOverlap >= 0.55) baseScore += 0.08;

  if (normalizedDistanceScore >= 0.65) signals.push("distance_high");
  if (consonantOverlapCount >= 3) signals.push("consonant_overlap");
  if (phoneticMatch) signals.push("phonetic_match");
  if (prefixScore > 0) signals.push("prefix_match");
  if (anchorMatched) signals.push("hard_anchor_match");

  if (hardAnchorChars(primary).length > 0 && !anchorMatched) {
    baseScore = Math.min(baseScore, NO_ANCHOR_SCORE_CAP);
  }

  if (normalizedDistanceScore < 0.33 && !phoneticMatch && consonantOverlapCount < 3) {
    baseScore *= 0.5;
  }

  return {
    baseScore: roundScore(clamp(baseScore, 0, 1)),
    signals
  };
}

function hasSupportingBotToken(
  transcriptTokens: string[] = [],
  botTokens: string[] = [],
  match: { index?: number, primaryBotToken?: string } | null = null
) {
  const matchedIndex = Number(match?.index);
  if (!Array.isArray(transcriptTokens) || !Array.isArray(botTokens)) return false;
  if (!Number.isFinite(matchedIndex) || matchedIndex < 0) return false;

  const primary = String(match?.primaryBotToken || "").trim().toLowerCase();
  const candidateTokens = botTokens.filter((token) => {
    const normalized = String(token || "").trim().toLowerCase();
    if (!normalized || normalized.length < 3) return false;
    if (normalized === primary) return false;
    if (GENERIC_BOT_TOKENS.has(normalized)) return false;
    return true;
  });
  if (!candidateTokens.length) return false;

  for (let index = 0; index < transcriptTokens.length; index += 1) {
    const token = String(transcriptTokens[index] || "").trim().toLowerCase();
    if (!token || !candidateTokens.includes(token)) continue;
    if (Math.abs(index - matchedIndex) <= 2) return true;
  }

  return false;
}

function resolveVoiceCommandContext(tokens: string[] = []): VoiceCommandContext {
  const actionIndices = [];
  const contextIndices = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = String(tokens[index] || "").trim().toLowerCase();
    if (!token) continue;
    if (VOICE_COMMAND_ACTION_TOKENS.has(token)) actionIndices.push(index);
    if (VOICE_COMMAND_CONTEXT_TOKENS.has(token)) contextIndices.push(index);
  }
  if (!actionIndices.length || !contextIndices.length) {
    return {
      active: false,
      actionIndices,
      contextIndices
    };
  }

  const nearestDistance = minDistanceBetweenIndexSets(actionIndices, contextIndices);
  return {
    active: nearestDistance !== null && nearestDistance <= VOICE_COMMAND_MAX_SHAPE_DISTANCE,
    actionIndices,
    contextIndices
  };
}

function isVoiceCommandTargetIndex(index = -1, context: VoiceCommandContext) {
  if (!context?.active) return false;
  const actionDistance = minDistanceToIndices(index, context.actionIndices);
  const contextDistance = minDistanceToIndices(index, context.contextIndices);
  if (actionDistance === null || contextDistance === null) return false;
  return actionDistance <= VOICE_COMMAND_MAX_TARGET_DISTANCE || contextDistance <= VOICE_COMMAND_MAX_TARGET_DISTANCE;
}

function minDistanceToIndices(index = -1, indices: number[] = []) {
  if (!Number.isInteger(index) || index < 0) return null;
  if (!Array.isArray(indices) || !indices.length) return null;
  let best = Number.POSITIVE_INFINITY;
  for (const candidate of indices) {
    const normalized = Number(candidate);
    if (!Number.isInteger(normalized) || normalized < 0) continue;
    best = Math.min(best, Math.abs(index - normalized));
  }
  return Number.isFinite(best) ? best : null;
}

function minDistanceBetweenIndexSets(left: number[] = [], right: number[] = []) {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || !right.length) return null;
  let best = Number.POSITIVE_INFINITY;
  for (const leftIndex of left) {
    for (const rightIndex of right) {
      best = Math.min(best, Math.abs(leftIndex - rightIndex));
    }
  }
  return Number.isFinite(best) ? best : null;
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

function pickPrimaryBotToken(tokens = []) {
  if (!Array.isArray(tokens) || !tokens.length) return "";
  const filtered = tokens.filter((token) => token.length >= 3 && !GENERIC_BOT_TOKENS.has(token));
  const candidates = filtered.length ? filtered : tokens.filter((token) => token.length >= 3);
  if (!candidates.length) return "";
  return [...candidates].sort((a, b) => b.length - a.length)[0] || "";
}

function stemToken(token = "") {
  const normalized = String(token || "").trim().toLowerCase();
  if (!normalized) return "";
  return normalized.replace(/(?:ers|er|es|s|a)$/u, "");
}

function phoneticTail(token = "") {
  const normalized = String(token || "").trim().toLowerCase();
  if (!normalized) return "";
  let previousCode = "";
  let digits = "";
  for (const char of normalized) {
    const code = PHONETIC_CODE.get(char) || "";
    if (!code) continue;
    if (code === previousCode) continue;
    digits += code;
    previousCode = code;
  }
  return digits;
}

function isGreetingCallout(tokens = [], index = -1) {
  if (index !== 1) return false;
  if (tokens.length < 2 || tokens.length > 4) return false;
  return GREETING_TOKENS.has(String(tokens[0] || ""));
}

function isIsThatYouCallout(tokens = [], index = -1) {
  if (index !== 3) return false;
  if (tokens.length < 4 || tokens.length > 6) return false;
  if (tokens[0] !== "is" || tokens[1] !== "that") return false;
  const pronoun = String(tokens[2] || "");
  return pronoun === "u" || pronoun === "you";
}

function isDidIJustHearCallout(tokens = [], index = -1) {
  if (index !== 5) return false;
  if (tokens.length < 6 || tokens.length > 8) return false;
  if (tokens[0] !== "did" || tokens[1] !== "i" || tokens[2] !== "just" || tokens[3] !== "hear") return false;
  return tokens[4] === "a" || tokens[4] === "an";
}

function isAffectionCallout(tokens = [], index = -1) {
  if (index < 0) return false;
  const loveIndex = tokens.indexOf("love");
  if (loveIndex === -1) return false;
  if (tokens.length > 12) return false;
  return index > loveIndex;
}

function isGreetingCalloutByShape(tokens = [], primaryBotToken = "") {
  if (!tokens.length) return false;
  if (!GREETING_TOKENS.has(String(tokens[0] || ""))) return false;
  const candidate = resolveTrailingNameLikeToken(tokens, 1, primaryBotToken);
  return Boolean(candidate);
}

function isIsThatYouCalloutByShape(tokens = [], primaryBotToken = "") {
  if (tokens.length < 4 || tokens.length > 8) return false;
  if (tokens[0] !== "is" || tokens[1] !== "that") return false;
  const pronoun = String(tokens[2] || "");
  if (pronoun !== "u" && pronoun !== "you") return false;
  const candidate = resolveTrailingNameLikeToken(tokens, 3, primaryBotToken);
  return Boolean(candidate);
}

function isDidIJustHearCalloutByShape(tokens = [], primaryBotToken = "") {
  if (tokens.length < 6 || tokens.length > 10) return false;
  if (tokens[0] !== "did" || tokens[1] !== "i" || tokens[2] !== "just" || tokens[3] !== "hear") return false;
  const article = String(tokens[4] || "");
  if (article !== "a" && article !== "an") return false;
  const candidate = resolveTrailingNameLikeToken(tokens, 5, primaryBotToken);
  return Boolean(candidate);
}

function resolveTrailingNameLikeToken(tokens = [], startIndex = 0, primaryBotToken = "") {
  for (let index = Math.max(0, startIndex); index < tokens.length; index += 1) {
    const token = String(tokens[index] || "");
    if (!isNameLikeCallToken(token, primaryBotToken)) continue;
    return token;
  }
  return "";
}

function isNameLikeCallToken(token = "", primaryBotToken = "") {
  return scoreNameLikeToken(token, primaryBotToken).baseScore >= NAME_LIKE_TOKEN_SCORE_THRESHOLD;
}

function commonPrefixLength(left = "", right = "") {
  const a = String(left || "");
  const b = String(right || "");
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) {
    index += 1;
  }
  return index;
}

function sharesHardAnchor(primary = "", candidate = "") {
  const primaryAnchors = hardAnchorChars(primary);
  if (!primaryAnchors.length) return true;
  const candidateSet = new Set(candidate.split(""));
  return primaryAnchors.some((char) => candidateSet.has(char));
}

function hardAnchorChars(value = "") {
  const chars = [];
  for (const char of String(value || "").toLowerCase()) {
    if (!HARD_ANCHOR_CHARS.has(char)) continue;
    if (chars.includes(char)) continue;
    chars.push(char);
  }
  return chars;
}

function sharedConsonantRatio(left = "", right = "") {
  const leftConsonants = [...new Set(consonants(left))];
  if (!leftConsonants.length) return 0;
  const shared = sharedConsonantCount(left, right);
  return clamp(shared / leftConsonants.length, 0, 1);
}

function orderedConsonantOverlapRatio(left = "", right = "") {
  const leftConsonants = consonants(left);
  const rightConsonants = consonants(right);
  if (!leftConsonants.length || !rightConsonants.length) return 0;
  const overlap = longestCommonSubsequenceLength(leftConsonants, rightConsonants);
  return clamp(overlap / leftConsonants.length, 0, 1);
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
  const result = [];
  for (const char of letters) {
    if ("aeiou".includes(char)) continue;
    result.push(char);
  }
  return result;
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

function longestCommonSubsequenceLength(left = [], right = []) {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const matrix = Array.from(
    { length: rows },
    () => Array.from({ length: cols }, () => 0)
  );

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      if (left[row - 1] === right[col - 1]) {
        matrix[row][col] = matrix[row - 1][col - 1] + 1;
      } else {
        matrix[row][col] = Math.max(matrix[row - 1][col], matrix[row][col - 1]);
      }
    }
  }

  return matrix[rows - 1][cols - 1];
}

function clamp(value = 0, min = 0, max = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  if (numeric < min) return min;
  if (numeric > max) return max;
  return numeric;
}

function roundScore(value = 0) {
  const numeric = clamp(value, 0, 1);
  return Math.round(numeric * 1000) / 1000;
}
