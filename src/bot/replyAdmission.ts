import { clamp } from "../utils.ts";
import { isLikelyBotNameVariantAddress } from "../addressingNameVariants.ts";
import { isBotNameAddressed } from "../voice/voiceSessionHelpers.ts";

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

export function getReplyAddressSignal(runtime, settings, message, recentMessages = []) {
  const referencedAuthorId = resolveReferencedAuthorId(message, recentMessages);
  const inferredByExactName = isBotNameAddressed({
    transcript: String(message?.content || ""),
    botName: String(settings?.botName || "")
  });
  const inferredByNameVariant = isLikelyBotNameVariantAddress(
    String(message?.content || ""),
    String(settings?.botName || "")
  );
  const direct =
    runtime.isDirectlyAddressed(settings, message) ||
    (referencedAuthorId && referencedAuthorId === runtime.botUserId) ||
    inferredByExactName ||
    inferredByNameVariant;
  return {
    direct: Boolean(direct),
    inferred: Boolean(inferredByExactName || inferredByNameVariant),
    triggered: Boolean(direct),
    reason: direct
      ? inferredByNameVariant
        ? "name_variant"
        : inferredByExactName
          ? "name_exact"
          : "direct"
      : "llm_decides"
  };
}

export function resolveReferencedAuthorId(message, recentMessages = []) {
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
