import WebSocket from "ws";

export const CONNECT_TIMEOUT_MS = 10_000;
export const MAX_OUTBOUND_EVENT_HISTORY = 8;
export const MAX_EVENT_PREVIEW_CHARS = 280;

export function compactObject(value) {
  const out = {};
  for (const [key, entry] of Object.entries(value || {})) {
    if (entry === undefined || entry === null || entry === "") continue;
    out[key] = entry;
  }
  return out;
}

export function extractAudioBase64(event) {
  const direct = event?.delta || event?.audio || event?.chunk;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  const nested =
    event?.audio?.delta ||
    event?.audio?.chunk ||
    event?.data?.audio ||
    event?.data?.delta ||
    event?.response?.audio?.delta ||
    null;

  if (typeof nested === "string" && nested.trim()) {
    return nested.trim();
  }

  return null;
}

export function safeJsonPreview(value, maxChars = MAX_EVENT_PREVIEW_CHARS) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= maxChars) return serialized;
    return `${serialized.slice(0, maxChars)}...`;
  } catch {
    return "[unserializable_payload]";
  }
}

export function markRealtimeConnected(client, ws) {
  client.ws = ws;
  client.connectedAt = Date.now();
  client.lastEventAt = Date.now();
  client.lastError = null;
}

export function handleRealtimeSocketError(client, error, { logEvent }) {
  client.lastEventAt = Date.now();
  client.lastError = String(error?.message || error);
  client.log("warn", logEvent, { error: client.lastError });
  client.emit("socket_error", {
    message: client.lastError
  });
}

export function handleRealtimeSocketClose(client, code, reasonBuffer, { logEvent, onClose = null }) {
  client.lastEventAt = Date.now();
  client.lastCloseCode = Number(code) || null;
  client.lastCloseReason = reasonBuffer ? String(reasonBuffer) : null;
  if (typeof onClose === "function") {
    onClose();
  }
  client.log("info", logEvent, {
    code: client.lastCloseCode,
    reason: client.lastCloseReason
  });
  client.emit("socket_closed", {
    code: client.lastCloseCode,
    reason: client.lastCloseReason
  });
}

export function recordOutboundEvent(client, {
  payload,
  eventType,
  summarizeOutboundPayload,
  skipHistoryEventType = null
}) {
  const summarizedPayload = summarizeOutboundPayload(payload);
  const event = compactObject({
    type: eventType,
    at: client.lastOutboundEventAt ? new Date(client.lastOutboundEventAt).toISOString() : null,
    payload: summarizedPayload
  });
  client.lastOutboundEvent = event;
  if (skipHistoryEventType && eventType === skipHistoryEventType) return;
  client.recentOutboundEvents.push(event);
  if (client.recentOutboundEvents.length > MAX_OUTBOUND_EVENT_HISTORY) {
    client.recentOutboundEvents = client.recentOutboundEvents.slice(-MAX_OUTBOUND_EVENT_HISTORY);
  }
}

export function sendRealtimePayload(client, {
  payload,
  eventType = null,
  summarizeOutboundPayload,
  skipHistoryEventType = null,
  skipLogEventType = null,
  logEvent,
  socketNotOpenMessage
}) {
  if (!client.ws || client.ws.readyState !== WebSocket.OPEN) {
    throw new Error(socketNotOpenMessage);
  }

  const resolvedEventType = String(eventType || payload?.type || "unknown");
  client.lastOutboundEventType = resolvedEventType;
  client.lastOutboundEventAt = Date.now();
  recordOutboundEvent(client, {
    payload,
    eventType: resolvedEventType,
    summarizeOutboundPayload,
    skipHistoryEventType
  });

  if (!skipLogEventType || resolvedEventType !== skipLogEventType) {
    client.log("info", logEvent, {
      ...(client.lastOutboundEvent || { type: resolvedEventType })
    });
  }

  client.ws.send(JSON.stringify(payload));
}

export async function openRealtimeSocket({
  url,
  headers,
  timeoutMs = CONNECT_TIMEOUT_MS,
  timeoutMessage,
  connectErrorPrefix
}) {
  return await new Promise<WebSocket>((resolve, reject) => {
    let settled = false;

    const ws = new WebSocket(String(url), {
      headers: headers || {},
      handshakeTimeout: timeoutMs
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      reject(new Error(timeoutMessage));
    }, timeoutMs + 1000);

    ws.once("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(ws);
    });

    ws.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`${connectErrorPrefix}: ${String(error?.message || error)}`));
    });
  });
}

export async function closeRealtimeSocket(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;

  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      ws.removeAllListeners("close");
      resolve(undefined);
    };

    ws.once("close", done);
    try {
      ws.close(1000, "session_ended");
    } catch {
      done();
    }

    setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      done();
    }, 1500);
  });
}

export function buildCommonRealtimeState(client) {
  return {
    connected: Boolean(client.ws && client.ws.readyState === WebSocket.OPEN),
    connectedAt: client.connectedAt ? new Date(client.connectedAt).toISOString() : null,
    lastEventAt: client.lastEventAt ? new Date(client.lastEventAt).toISOString() : null,
    sessionId: client.sessionId || null,
    lastError: client.lastError || null,
    lastCloseCode: client.lastCloseCode,
    lastCloseReason: client.lastCloseReason,
    lastOutboundEventType: client.lastOutboundEventType || null,
    lastOutboundEventAt: client.lastOutboundEventAt ? new Date(client.lastOutboundEventAt).toISOString() : null,
    lastOutboundEvent: client.lastOutboundEvent || null,
    recentOutboundEvents: Array.isArray(client.recentOutboundEvents) ? client.recentOutboundEvents.slice(-4) : []
  };
}
