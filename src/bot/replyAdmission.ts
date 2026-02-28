import { clamp } from "../utils.ts";
import { isBotNameAddressed } from "../voice/voiceSessionHelpers.ts";
import {
  DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD,
  hasBotNameCue
} from "../directAddressConfidence.ts";

export type ReplyAddressSignal = {
  direct: boolean;
  inferred: boolean;
  triggered: boolean;
  reason: string;
  confidence: number;
  threshold: number;
  confidenceSource: "llm" | "fallback" | "direct" | "exact_name";
};

type ReplyAddressRuntime = {
  botUserId?: string;
  isDirectlyAddressed: (settings, message) => boolean;
  scoreDirectAddressConfidence?: (payload: {
    settings,
    message,
    recentMessages,
    fallbackConfidence: number,
    threshold: number
  }) => Promise<{
    confidence?: number;
    addressed?: boolean;
    threshold?: number;
    source?: "llm" | "fallback";
    reason?: string;
  } | null>;
};

export function hasBotMessageInRecentWindow({
  botUserId,
  recentMessages,
  windowSize = 5,
  triggerMessageId = null
}) {
  const normalizedBotUserId = String(botUserId || "").trim();
  if (!normalizedBotUserId) return false;
  if (!Array.isArray(recentMessages) || !recentMessages.length) return false;

  const excludedMessageId = String(triggerMessageId || "").trim();
  const candidateMessages = excludedMessageId
    ? recentMessages.filter((row) => String(row?.message_id || "").trim() !== excludedMessageId)
    : recentMessages;

  const cappedWindow = clamp(Math.floor(windowSize), 1, 50);
  return candidateMessages
    .slice(0, cappedWindow)
    .some((row) => String(row?.author_id || "").trim() === normalizedBotUserId);
}

export function hasStartupFollowupAfterMessage({
  botUserId,
  messages,
  messageIndex,
  triggerMessageId,
  windowSize = 5
}) {
  const normalizedBotUserId = String(botUserId || "").trim();
  if (!normalizedBotUserId) return false;
  if (!Array.isArray(messages) || !messages.length) return false;
  if (!Number.isInteger(messageIndex) || messageIndex < 0 || messageIndex >= messages.length) return false;

  const triggerId = String(triggerMessageId || "").trim();
  const startIndex = messageIndex + 1;

  if (triggerId) {
    for (let index = startIndex; index < messages.length; index += 1) {
      const candidate = messages[index];
      if (String(candidate?.author?.id || "").trim() !== normalizedBotUserId) continue;

      const referencedId = String(
        candidate?.reference?.messageId || candidate?.referencedMessage?.id || ""
      ).trim();
      if (referencedId && referencedId === triggerId) {
        return true;
      }
    }
  }

  const cappedWindow = clamp(Math.floor(windowSize), 1, 50);
  const endIndex = Math.min(messages.length, startIndex + cappedWindow);
  for (let index = startIndex; index < endIndex; index += 1) {
    if (String(messages[index]?.author?.id || "").trim() === normalizedBotUserId) {
      return true;
    }
  }

  return false;
}

export function shouldAttemptReplyDecision({
  botUserId,
  settings,
  recentMessages,
  addressSignal,
  forceRespond = false,
  triggerMessageId = null,
  windowSize = 5
}) {
  if (forceRespond || addressSignal?.triggered) return true;
  if (!settings?.permissions?.allowInitiativeReplies) return false;
  return hasBotMessageInRecentWindow({
    botUserId,
    recentMessages,
    windowSize,
    triggerMessageId
  });
}

export function shouldForceRespondForAddressSignal(addressSignal: Partial<ReplyAddressSignal> | null = null) {
  if (!addressSignal || typeof addressSignal !== "object") return false;
  if (!addressSignal.triggered) return false;
  const reason = String(addressSignal.reason || "")
    .trim()
    .toLowerCase();
  return reason !== "name_variant" && reason !== "llm_direct_address";
}

export async function getReplyAddressSignal(
  runtime: ReplyAddressRuntime,
  settings,
  message,
  recentMessages = []
) {
  const referencedAuthorId = resolveReferencedAuthorId(message, recentMessages);
  const directByPlatform =
    runtime.isDirectlyAddressed(settings, message) ||
    Boolean(referencedAuthorId && referencedAuthorId === runtime.botUserId);
  const inferredByExactName = isBotNameAddressed({
    transcript: String(message?.content || ""),
    botName: String(settings?.botName || "")
  });
  const fallbackConfidence = inferredByExactName ? 0.95 : 0;
  const threshold = DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD;
  const shouldCallAddressingLlm =
    !directByPlatform &&
    !inferredByExactName &&
    hasBotNameCue({
      transcript: String(message?.content || ""),
      botName: String(settings?.botName || "")
    });

  const llmScore = shouldCallAddressingLlm && typeof runtime.scoreDirectAddressConfidence === "function"
    ? await runtime.scoreDirectAddressConfidence({
        settings,
        message,
        recentMessages,
        fallbackConfidence,
        threshold
      })
    : null;
  const scoredThreshold = clamp(Number(llmScore?.threshold) || threshold, 0.4, 0.95);
  const scoredConfidence = clamp(
    Math.max(
      Number(llmScore?.confidence) || 0,
      fallbackConfidence
    ),
    0,
    1
  );
  const inferredByLlm = Boolean(
    llmScore && (
      llmScore.addressed === true ||
      scoredConfidence >= scoredThreshold
    )
  );
  const direct = Boolean(directByPlatform || inferredByExactName || inferredByLlm);
  const reason = direct
    ? directByPlatform
      ? "direct"
      : inferredByExactName
        ? "name_exact"
        : "llm_direct_address"
    : "llm_decides";
  const confidence = directByPlatform
    ? 1
    : inferredByExactName
      ? Math.max(scoredConfidence, 0.95)
      : scoredConfidence;

  return {
    direct: Boolean(direct),
    inferred: Boolean(inferredByExactName || inferredByLlm),
    triggered: Boolean(direct),
    reason,
    confidence,
    threshold: scoredThreshold,
    confidenceSource: directByPlatform
      ? "direct"
      : inferredByExactName
        ? "exact_name"
        : llmScore?.source === "llm"
          ? "llm"
          : "fallback"
  };
}

function resolveReferencedAuthorId(message, recentMessages = []) {
  const referenceId = String(message.reference?.messageId || "").trim();
  if (!referenceId) return null;

  const fromRecent = recentMessages.find((row) => String(row.message_id) === referenceId)?.author_id;
  if (fromRecent) return String(fromRecent);

  const fromResolved =
    message.reference?.resolved?.author?.id ||
    message.reference?.resolvedMessage?.author?.id ||
    message.referencedMessage?.author?.id;

  return fromResolved ? String(fromResolved) : null;
}
