import {
  getMemorySettings,
  getVoiceConversationPolicy,
  getVoiceRuntimeConfig,
  getVoiceSoundboardSettings,
  getVoiceTranscriptionSettings
} from "../settings/agentStack.ts";
import {
  buildVoiceToneGuardrails,
  buildHardLimitsSection,
  DEFAULT_PROMPT_VOICE_GUIDANCE,
  getPromptBotName,
  getPromptCapabilityHonestyLine,
  getPromptImpossibleActionLine,
  getPromptMemoryDisabledLine,
  getPromptMemoryEnabledLine,
  getPromptStyle,
  getPromptVoiceGuidance
} from "../prompts/promptCore.ts";
import { providerSupports } from "./voiceModes.ts";
import {
  formatSoundboardCandidateLine,
  isRealtimeMode,
  shouldAllowVoiceNsfwHumor,
  SOUNDBOARD_MAX_CANDIDATES
} from "./voiceSessionHelpers.ts";

type VoiceConfigSettings = Record<string, unknown> | null;

type VoiceConfigSessionLike = {
  ending?: boolean;
  mode?: string;
  settingsSnapshot?: VoiceConfigSettings;
} | null;

type RealtimeReplyStrategy = "brain" | "native";

function resolveConfigSettings(session: VoiceConfigSessionLike, settings: VoiceConfigSettings) {
  return settings || session?.settingsSnapshot || null;
}

export function resolveRealtimeReplyStrategy({
  session,
  settings = null
}: {
  session?: VoiceConfigSessionLike;
  settings?: VoiceConfigSettings;
}): RealtimeReplyStrategy {
  if (!session || !isRealtimeMode(session.mode || "")) return "brain";
  const resolvedSettings = resolveConfigSettings(session, settings);
  const replyPath = String(getVoiceConversationPolicy(resolvedSettings).replyPath || "")
    .trim()
    .toLowerCase();
  if (replyPath === "native") return "native";
  return "brain";
}

export function shouldUseNativeRealtimeReply({
  session,
  settings = null
}: {
  session?: VoiceConfigSessionLike;
  settings?: VoiceConfigSettings;
}) {
  return resolveRealtimeReplyStrategy({ session, settings }) === "native";
}

export function shouldUsePerUserTranscription({
  session = null,
  settings = null,
  hasOpenAiApiKey = false
}: {
  session?: VoiceConfigSessionLike;
  settings?: VoiceConfigSettings;
  hasOpenAiApiKey?: boolean;
} = {}) {
  if (!session || session.ending) return false;
  if (!providerSupports(session.mode || "", "perUserAsr")) return false;
  if (!hasOpenAiApiKey) return false;
  const resolvedSettings = resolveConfigSettings(session, settings);
  const voiceConversation = getVoiceConversationPolicy(resolvedSettings);
  const voiceRuntime = getVoiceRuntimeConfig(resolvedSettings);
  if (voiceConversation.textOnlyMode) return false;
  const transcriptionMethod = String(
    voiceRuntime.openaiRealtime?.transcriptionMethod || "realtime_bridge"
  )
    .trim()
    .toLowerCase();
  if (resolveRealtimeReplyStrategy({ session, settings: resolvedSettings }) !== "brain") {
    return false;
  }
  if (transcriptionMethod !== "realtime_bridge") {
    return false;
  }
  if (!voiceRuntime.openaiRealtime?.usePerUserAsrBridge) {
    return false;
  }
  return true;
}

export function shouldUseSharedTranscription({
  session = null,
  settings = null,
  hasOpenAiApiKey = false
}: {
  session?: VoiceConfigSessionLike;
  settings?: VoiceConfigSettings;
  hasOpenAiApiKey?: boolean;
} = {}) {
  if (!session || session.ending) return false;
  if (!providerSupports(session.mode || "", "sharedAsr")) return false;
  if (!hasOpenAiApiKey) return false;
  const resolvedSettings = resolveConfigSettings(session, settings);
  const voiceConversation = getVoiceConversationPolicy(resolvedSettings);
  const voiceRuntime = getVoiceRuntimeConfig(resolvedSettings);
  if (voiceConversation.textOnlyMode) return false;
  const transcriptionMethod = String(
    voiceRuntime.openaiRealtime?.transcriptionMethod || "realtime_bridge"
  )
    .trim()
    .toLowerCase();
  if (resolveRealtimeReplyStrategy({ session, settings: resolvedSettings }) !== "brain") {
    return false;
  }
  if (transcriptionMethod !== "realtime_bridge") {
    return false;
  }
  if (voiceRuntime.openaiRealtime?.usePerUserAsrBridge) {
    return false;
  }
  return true;
}

export function shouldUseRealtimeTranscriptBridge({
  session = null,
  settings = null
}: {
  session?: VoiceConfigSessionLike;
  settings?: VoiceConfigSettings;
} = {}) {
  if (!session || session.ending) return false;
  if (!isRealtimeMode(session.mode || "")) return false;
  const resolvedSettings = resolveConfigSettings(session, settings);
  const voiceConversation = getVoiceConversationPolicy(resolvedSettings);
  const replyPath = String(voiceConversation.replyPath || "")
    .trim()
    .toLowerCase();
  if (replyPath === "bridge") {
    const ttsMode = String(voiceConversation.ttsMode || "").trim().toLowerCase();
    if (ttsMode === "api") return false;
    return true;
  }
  if (replyPath === "brain" || replyPath === "native") return false;
  return false;
}

export function isAsrActive({
  session = null,
  settings = null
}: {
  session?: VoiceConfigSessionLike;
  settings?: VoiceConfigSettings;
} = {}) {
  const resolvedSettings = resolveConfigSettings(session, settings);
  if (!getVoiceTranscriptionSettings(resolvedSettings).enabled) return false;
  if (getVoiceConversationPolicy(resolvedSettings).textOnlyMode) return false;
  return true;
}

export function buildVoiceInstructions(
  settings: VoiceConfigSettings,
  {
    soundboardCandidates = []
  }: {
    soundboardCandidates?: Array<{
      soundId?: string | null;
      sourceGuildId?: string | null;
      reference?: string | null;
      name?: string | null;
      origin?: "preferred" | "guild_catalog";
    }>;
  } = {}
) {
  const botName = getPromptBotName(settings);
  const style = getPromptStyle(settings);
  const allowNsfwHumor = shouldAllowVoiceNsfwHumor(settings);
  const memoryEnabled = Boolean(getMemorySettings(settings).enabled);
  const soundboardEnabled = Boolean(getVoiceSoundboardSettings(settings).enabled);
  const soundboardCandidateLines = (Array.isArray(soundboardCandidates) ? soundboardCandidates : [])
    .map((entry) => formatSoundboardCandidateLine(entry))
    .filter(Boolean)
    .slice(0, SOUNDBOARD_MAX_CANDIDATES);
  const voiceToneGuardrails = buildVoiceToneGuardrails();
  const voiceGuidance = getPromptVoiceGuidance(settings, DEFAULT_PROMPT_VOICE_GUIDANCE);
  const lines = [
    `You are ${botName}, a real-feeling regular in a Discord server, speaking in live voice chat.`,
    `Stay in-character as ${botName}. Style: ${style}.`,
    ...voiceGuidance,
    ...voiceToneGuardrails,
    allowNsfwHumor
      ? "Adult/NSFW humor is allowed for consenting adults, but never include minors, coercion, or targeted harassment."
      : "Keep humor non-sexual by default unless users explicitly request a safe toned-down joke.",
    getPromptCapabilityHonestyLine(settings),
    memoryEnabled
      ? getPromptMemoryEnabledLine(
        settings,
        "You have persistent memory across conversations via saved durable facts. Do not claim each conversation starts from zero."
      )
      : getPromptMemoryDisabledLine(settings),
    getPromptImpossibleActionLine(settings),
    ...buildHardLimitsSection(settings, { maxItems: 12 }),
    "You do not need to respond to filler words, background noise, or things that don't warrant a reply."
  ];

  if (soundboardEnabled && soundboardCandidateLines.length) {
    lines.push("Soundboard control is enabled.");
    lines.push("Available sound refs:");
    lines.push(soundboardCandidateLines.join("\n"));
    lines.push(
      "If you want soundboard effects, insert one or more directives where they should fire: [[SOUNDBOARD:<sound_ref>]] using exact refs from the list."
    );
    lines.push("If no sound should play, omit that directive.");
    lines.push("Never mention or explain the directive in normal speech.");
  }

  return lines.join("\n");
}
