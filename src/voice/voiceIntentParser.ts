import { hasBotKeyword } from "../utils.ts";

const JOIN_PATTERNS = [
  /\b(?:join|hop\s*in|jump\s*in|get\s*in|pull\s*up|come\s*to|enter)\b[\w\s]{0,32}\b(?:v\s*\.?\s*c|vs|voice(?:\s*(?:chat|channel))?|call)\b/i,
  /\b(?:v\s*\.?\s*c|vs|voice(?:\s*(?:chat|channel))?|call)\b[\w\s]{0,24}\b(?:join|hop\s*in|jump\s*in|come\s*in)\b/i,
  /\b(?:bother|annoy|terrorize)\b[\w\s]{0,32}\b(?:v\s*\.?\s*c|vs|voice(?:\s*(?:chat|channel))?|call)\b/i
];

const LEAVE_PATTERNS = [
  /\b(?:leave|dip|bounce|exit|get\s*out|disconnect|hang\s*up|stop)\b[\w\s]{0,32}\b(?:v\s*\.?\s*c|vs|voice(?:\s*(?:chat|channel))?|call)\b/i,
  /\b(?:v\s*\.?\s*c|vs|voice(?:\s*(?:chat|channel))?|call)\b[\w\s]{0,24}\b(?:off|stop|leave|quit)\b/i
];

const STATUS_PATTERNS = [
  /\b(?:voice\s*status|v\s*\.?\s*c\s*status|vs\s*status)\b/i,
  /\b(?:are\s*you\s*in\s*(?:v\s*\.?\s*c|vs|voice)|where\s*are\s*you\s*in\s*voice)\b/i,
  /\b(?:status)\b[\w\s]{0,20}\b(?:v\s*\.?\s*c|vs|voice(?:\s*(?:chat|channel))?|call)\b/i
];

const DIRECT_MENTION_RE = /<@!?\d+>/;
const INTENT_CONFIDENCE = {
  joinMentioned: 0.92,
  joinUnmentioned: 0.78,
  leaveMentioned: 0.9,
  leaveUnmentioned: 0.82,
  statusMentioned: 0.88,
  statusUnmentioned: 0.8
};

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[`*_~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

export function detectVoiceIntent({
  content,
  botName,
  directlyAddressed = false
}) {
  const normalized = normalizeText(content);
  const hasDirectMention = DIRECT_MENTION_RE.test(normalized);
  const hasKeywordMention = hasBotKeyword(normalized);
  const hasNameMention = botName
    ? normalized.includes(String(botName).toLowerCase().trim())
    : false;
  const mentionSatisfied = Boolean(directlyAddressed || hasDirectMention || hasKeywordMention || hasNameMention);

  const joinMatched = matchesAny(normalized, JOIN_PATTERNS);
  const leaveMatched = matchesAny(normalized, LEAVE_PATTERNS);
  const statusMatched = matchesAny(normalized, STATUS_PATTERNS);

  let intent = null;
  let confidence = 0;

  if (joinMatched) {
    intent = "join";
    confidence = mentionSatisfied ? INTENT_CONFIDENCE.joinMentioned : INTENT_CONFIDENCE.joinUnmentioned;
  } else if (leaveMatched) {
    intent = "leave";
    confidence = mentionSatisfied ? INTENT_CONFIDENCE.leaveMentioned : INTENT_CONFIDENCE.leaveUnmentioned;
  } else if (statusMatched) {
    intent = "status";
    confidence = mentionSatisfied ? INTENT_CONFIDENCE.statusMentioned : INTENT_CONFIDENCE.statusUnmentioned;
  }

  return {
    intent,
    confidence,
    mentionSatisfied,
    normalizedText: normalized
  };
}
