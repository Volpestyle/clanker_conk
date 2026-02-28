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

export function isLikelyBotNameVariantAddress(transcript = "", botName = "") {
  const transcriptTokens = tokenize(transcript);
  const botTokens = tokenize(botName);
  const primaryBotToken = pickPrimaryBotToken(botTokens);
  if (!transcriptTokens.length || !primaryBotToken) return false;

  const match = findVariantTokenMatch(transcriptTokens, primaryBotToken);
  if (!match) return false;
  if (hasSupportingBotToken(transcriptTokens, botTokens, match)) return true;

  if (isGreetingCallout(transcriptTokens, match.index)) return true;
  if (isIsThatYouCallout(transcriptTokens, match.index)) return true;
  if (isDidIJustHearCallout(transcriptTokens, match.index)) return true;
  if (isAffectionCallout(transcriptTokens, match.index)) return true;

  if (isGreetingCalloutByShape(transcriptTokens, primaryBotToken)) return true;
  if (isIsThatYouCalloutByShape(transcriptTokens, primaryBotToken)) return true;
  if (isDidIJustHearCalloutByShape(transcriptTokens, primaryBotToken)) return true;

  return false;
}

function hasSupportingBotToken(transcriptTokens = [], botTokens = [], match = null) {
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

function findVariantTokenMatch(tokens = [], primaryBotToken = "") {
  if (!primaryBotToken) return null;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = String(tokens[index] || "");
    if (isNameLikeCallToken(token, primaryBotToken)) {
      return { token, index, primaryBotToken };
    }
  }

  return null;
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
  const normalized = String(token || "").trim().toLowerCase();
  if (!normalized) return false;
  const primary = String(primaryBotToken || "").trim().toLowerCase();
  if (!primary) return false;
  if (normalized.length < 4 || primary.length < 4) return false;
  if (!/^[\p{L}\p{N}]+$/u.test(normalized)) return false;
  if (NON_NAME_CALL_TOKENS.has(normalized)) return false;

  const normalizedStem = stemToken(normalized);
  const primaryStem = stemToken(primary);
  if (normalized === primary || (normalizedStem && primaryStem && normalizedStem === primaryStem)) {
    return true;
  }

  const normalizedTail = phoneticTail(normalized);
  const primaryTail = phoneticTail(primary);
  if (normalizedTail && primaryTail && normalizedTail === primaryTail) {
    return true;
  }

  if (levenshteinDistance(normalized, primary) <= 2) {
    return sharesHardAnchor(primary, normalized);
  }

  return sharesHardAnchor(primary, normalized) && sharedConsonantCount(primary, normalized) >= 2;
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
  const matrix = Array.from({ length: rows }, (_, row) => Array.from({ length: cols }, (_, col) => (row === 0 ? col : col === 0 ? row : 0)));

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
