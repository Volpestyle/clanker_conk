const RESPONSE_TRIGGER_ACTION_KINDS = new Set([
  "sent_reply",
  "sent_message",
  "reply_skipped"
]);

export function shouldTrackResponseTriggerKind(kind) {
  const normalizedKind = String(kind || "").trim();
  if (!normalizedKind) return false;
  return RESPONSE_TRIGGER_ACTION_KINDS.has(normalizedKind);
}

export function normalizeResponseTriggerMessageIds(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];

  const out = [];
  const pushId = (value) => {
    const normalized = String(value || "").trim();
    if (!normalized) return;
    if (out.includes(normalized)) return;
    out.push(normalized);
  };

  pushId(metadata.triggerMessageId);

  if (Array.isArray(metadata.triggerMessageIds)) {
    for (const value of metadata.triggerMessageIds) {
      pushId(value);
    }
  }

  return out;
}
