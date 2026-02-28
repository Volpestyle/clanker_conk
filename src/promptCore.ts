import { normalizeBoundedStringList } from "./settings/listNormalization.ts";

const DEFAULT_BOT_NAME = "clanker conk";
const DEFAULT_STYLE = "playful slang";

const PROMPT_CAPABILITY_HONESTY_LINE = "Never claim capabilities you do not have.";
const DEFAULT_IMPOSSIBLE_ACTION_LINE = "If asked to do something impossible, say it casually and suggest a text-only alternative.";
const DEFAULT_MEMORY_ENABLED_LINE =
  "You have persistent memory across conversations via saved durable facts and logs. Do not claim each conversation starts from zero.";
const DEFAULT_MEMORY_DISABLED_LINE =
  "Persistent memory is disabled right now. Do not claim long-term memory across separate conversations.";
const DEFAULT_SKIP_LINE = "If you should not send a message, output exactly [SKIP].";
const DEFAULT_MEDIA_PROMPT_CRAFT_GUIDANCE = [
  "Write media prompts as vivid scene descriptions, not abstract concepts.",
  "Include: subject/action, visual style or medium (photo, illustration, 3D render, pixel art, etc.), lighting/mood, camera angle or framing, and color palette when relevant.",
  "Be specific: 'a golden retriever leaping through autumn leaves, warm backlit sunset, low angle, film grain' beats 'a dog outside'.",
  "For video prompts, describe the motion arc: what starts, what changes, and how it ends.",
  "Never put text, words, or UI elements in media prompts."
].join(" ");
export const VOICE_REPLY_DECIDER_WAKE_VARIANT_HINT_DEFAULT = [
  "Treat near-phonetic or misspelled tokens that appear to target the bot name as direct address.",
  "Short callouts like \"yo <name-ish-token>\" or \"hi <name-ish-token>\" usually indicate direct address.",
  "Questions like \"is that you <name-ish-token>?\" usually indicate direct address."
].join(" ");

export const VOICE_REPLY_DECIDER_SYSTEM_PROMPT_COMPACT_DEFAULT = [
  "You decide if \"{{botName}}\" should reply right now in a live Discord voice chat.",
  "Output exactly one token: YES or NO.",
  "Interpret second-person wording (\"you\", \"your\", \"show me\") as potentially aimed at {{botName}} unless another person is explicitly targeted.",
  "When reply eagerness is low, be conservative and prefer NO unless the turn clearly warrants interruption-free contribution.",
  "At medium eagerness, balance responsiveness with restraint; only insert when it adds clear value.",
  "At high eagerness, you can be more available for follow-ups and playful tone.",
  "At near-max/absolute max eagerness (90-100), allow more hype, playful, and slightly chaotic social inserts when context allows.",
  "Prefer YES for direct wake-word mentions and likely ASR variants of the bot name.",
  "Treat near-phonetic or misspelled tokens that appear to target the bot name as direct address.",
  "Short callouts like \"yo <name-ish-token>\" or \"hi <name-ish-token>\" should usually be YES.",
  "Questions like \"is that you <name-ish-token>?\" should usually be YES.",
  "Do not use rhyme alone as evidence of direct address.",
  "Generic chatter such as prank/stank/stinky phrasing without a clear name-like callout should usually be NO.",
  "Priority rule: when Join window active is yes, treat short greetings/check-ins as targeted at the bot unless another human target is explicit.",
  "Examples of join-window short greetings/check-ins: hi, hey, hello, yo, hola, what's up, what up, salam, marhaba, ciao, bonjour, こんにちは, مرحبا.",
  "In join window, a single-token greeting/check-in should usually be YES, not filler.",
  "When Join window active is yes and the turn is a greeting/check-in, default to YES unless it is clearly aimed at another human.",
  "When conversation engagement state is engaged and current speaker matches engaged flow, lean YES for coherent follow-ups.",
  "Prefer YES for clear questions/requests that seem aimed at the bot or the current speaker flow.",
  "If this sounds like a follow-up from an engaged speaker, lean YES.",
  "Prefer NO for filler/noise, pure acknowledgements, or turns clearly aimed at another human.",
  "When uncertain and the utterance is a clear question, prefer YES.",
  "Never output anything except YES or NO."
].join("\n");

export const VOICE_REPLY_DECIDER_SYSTEM_PROMPT_FULL_DEFAULT = [
  "You classify whether \"{{botName}}\" should reply now in Discord voice chat.",
  "Output exactly one token: YES or NO.",
  "Interpret second-person wording (\"you\", \"your\", \"show me\") as potentially aimed at {{botName}} unless another person is explicitly targeted.",
  "If directly addressed, strongly prefer YES unless transcript is too unclear to answer.",
  "When reply eagerness is low, default toward NO unless there is a clear, high-value contribution that improves the moment.",
  "Use a stricter bar for non-direct turns when engagement is weak or the crowd is active; moderate eagerness can tolerate more context-following follow-ups.",
  "At higher eagerness, permit playful follow-ups that add energy or social glue, while avoiding hard disruption.",
  "At near-max/absolute max eagerness (90-100), tolerate significantly more hype or chaotic chatter if it fits the room.",
  "If not directly addressed, use reply eagerness and flow; prefer NO if interruptive or low value.",
  "In small conversations, prefer YES for clear questions and active back-and-forth.",
  "Treat likely ASR wake-word variants of the bot name as direct address when context supports it.",
  "Short callouts like \"yo <name-ish-token>\" or \"hi <name-ish-token>\" should usually be YES.",
  "Questions like \"is that you <name-ish-token>?\" should usually be YES.",
  "Priority rule: when Join window active is yes, treat short greetings/check-ins as aimed at the bot unless another human target is explicit.",
  "Examples of join-window short greetings/check-ins: hi, hey, hello, yo, hola, what's up, what up, salam, marhaba, ciao, bonjour, こんにちは, مرحبا.",
  "In join window, a single-token greeting/check-in should usually be YES, not filler.",
  "When Join window active is yes and the turn is a greeting/check-in, default to YES unless it is clearly aimed at another human.",
  "When conversation engagement state is engaged and current speaker matches engaged flow, lean YES for coherent follow-ups.",
  "Do not treat rhyme-only similarity as wake-word evidence.",
  "Generic prank/stank/stinky chatter without a clear name-like callout should usually be NO.",
  "Never output anything except YES or NO."
].join("\n");

export const VOICE_REPLY_DECIDER_SYSTEM_PROMPT_STRICT_DEFAULT = [
  "Binary classifier.",
  "Output exactly one token: YES or NO.",
  "No punctuation. No explanation."
].join("\n");

export function getPromptBotName(settings, fallback = DEFAULT_BOT_NAME) {
  const configured = String(settings?.botName || "").trim();
  return configured || String(fallback || DEFAULT_BOT_NAME);
}

export function getPromptStyle(settings, fallback = DEFAULT_STYLE) {
  const configured = String(settings?.persona?.flavor || "").trim();
  return configured || String(fallback || DEFAULT_STYLE);
}

export function getPromptCapabilityHonestyLine(settings, fallback = PROMPT_CAPABILITY_HONESTY_LINE) {
  const configured = String(settings?.prompt?.capabilityHonestyLine || "").trim();
  return configured || String(fallback || PROMPT_CAPABILITY_HONESTY_LINE);
}

export function getPromptImpossibleActionLine(settings, fallback = DEFAULT_IMPOSSIBLE_ACTION_LINE) {
  const configured = String(settings?.prompt?.impossibleActionLine || "").trim();
  return configured || String(fallback || DEFAULT_IMPOSSIBLE_ACTION_LINE);
}

export function getPromptMemoryEnabledLine(settings, fallback = DEFAULT_MEMORY_ENABLED_LINE) {
  const configured = String(settings?.prompt?.memoryEnabledLine || "").trim();
  return configured || String(fallback || DEFAULT_MEMORY_ENABLED_LINE);
}

export function getPromptMemoryDisabledLine(settings, fallback = DEFAULT_MEMORY_DISABLED_LINE) {
  const configured = String(settings?.prompt?.memoryDisabledLine || "").trim();
  return configured || String(fallback || DEFAULT_MEMORY_DISABLED_LINE);
}

export function getPromptSkipLine(settings, fallback = DEFAULT_SKIP_LINE) {
  const configured = String(settings?.prompt?.skipLine || "").trim();
  return configured || String(fallback || DEFAULT_SKIP_LINE);
}

export function getPromptTextGuidance(settings, fallback = []) {
  return normalizePromptLineList(settings?.prompt?.textGuidance, fallback);
}

export function getPromptVoiceGuidance(settings, fallback = []) {
  return normalizePromptLineList(settings?.prompt?.voiceGuidance, fallback);
}

export function getPromptVoiceOperationalGuidance(settings, fallback = []) {
  return normalizePromptLineList(settings?.prompt?.voiceOperationalGuidance, fallback);
}

export function getMediaPromptCraftGuidance(settings, fallback = DEFAULT_MEDIA_PROMPT_CRAFT_GUIDANCE) {
  const configured = String(settings?.prompt?.mediaPromptCraftGuidance || "").trim();
  return configured || String(fallback || DEFAULT_MEDIA_PROMPT_CRAFT_GUIDANCE);
}

function getPromptHardLimits(settings, { maxItems = null } = {}) {
  const source = Array.isArray(settings?.persona?.hardLimits) ? settings.persona.hardLimits : [];
  const limits = source
    .map((line) => String(line || "").trim())
    .filter(Boolean);
  if (!Number.isFinite(Number(maxItems))) return limits;
  const count = Math.max(0, Math.floor(Number(maxItems)));
  return limits.slice(0, count);
}

export function buildHardLimitsSection(settings, { maxItems = null } = {}) {
  return [
    "Hard limitations:",
    ...getPromptHardLimits(settings, { maxItems }).map((line) => `- ${line}`)
  ];
}

function normalizeVoiceParticipantRoster(participantRoster, maxItems = 12) {
  const limit = Number.isFinite(Number(maxItems)) ? Math.max(0, Math.floor(Number(maxItems))) : 12;
  return (Array.isArray(participantRoster) ? participantRoster : [])
    .map((entry) => {
      if (typeof entry === "string") return String(entry).trim();
      return String(entry?.displayName || entry?.name || "").trim();
    })
    .filter(Boolean)
    .slice(0, limit);
}

export function buildVoiceSelfContextLines({
  voiceEnabled = false,
  inVoiceChannel = false,
  participantRoster = []
} = {}) {
  if (!voiceEnabled) {
    return ["Voice mode is disabled right now."];
  }

  const lines = [
    "Voice mode is enabled right now.",
    "Do not claim you are text-only or unable to join voice channels."
  ];
  if (!inVoiceChannel) {
    lines.push("You are currently not in VC.");
    return lines;
  }

  lines.push("You are currently in VC right now.");
  const participants = normalizeVoiceParticipantRoster(participantRoster, 12);
  if (participants.length) {
    lines.push(`Humans currently in channel: ${participants.join(", ")}.`);
  }
  lines.push("You do have member-list context for this VC; do not claim you can't see who is in channel.");
  lines.push("Continuity rule: while in VC, do not claim you are outside VC.");
  return lines;
}

export function buildVoiceToneGuardrails() {
  return [
    "Match your normal text-chat persona in voice: same attitude, slang level, and casual cadence.",
    "Keep turns tight: one clear idea, usually one short sentence.",
    "Use a second short sentence only when needed for clarity or when asked for detail.",
    "In voice, avoid chat-only shorthand acronyms (for example lmao, fr, ngl); use natural spoken phrasing instead.",
    "Avoid assistant-like preambles, disclaimers, and over-explaining.",
    "Avoid bullet lists and rigid formatting unless someone explicitly asks for structured steps."
  ];
}

function normalizePromptLineList(source, fallback = []) {
  const list = Array.isArray(source) ? source : Array.isArray(fallback) ? fallback : [];
  return normalizeBoundedStringList(list, {
    maxItems: Number.MAX_SAFE_INTEGER,
    maxLen: Number.MAX_SAFE_INTEGER
  });
}
