import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";
import WebSocket from "ws";

const CONNECT_TIMEOUT_MS = 10_000;
const MAX_OUTBOUND_EVENT_HISTORY = 8;
const MAX_EVENT_PREVIEW_CHARS = 280;
const MAX_HANDSHAKE_BODY_PREVIEW_CHARS = 600;
const MAX_CONNECT_ERROR_MESSAGE_CHARS = 1800;
const MAX_HANDSHAKE_CAPTURE_WAIT_MS = 1_500;
const SENSITIVE_HEADER_RE =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-goog-api-key)$/i;

export type RealtimeConnectErrorDiagnostics = {
  source: "unexpected_response" | "socket_error" | "timeout";
  url: string | null;
  statusCode: number | null;
  statusMessage: string | null;
  headers: Record<string, string> | null;
  bodyPreview: string | null;
};

type RealtimeConnectError = Error & {
  diagnostics?: RealtimeConnectErrorDiagnostics;
};

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

export function summarizeRealtimeSocketUrl(rawUrl) {
  const source = String(rawUrl || "").trim();
  if (!source) return null;
  try {
    const parsed = new URL(source);
    const queryKeys = [...new Set([...parsed.searchParams.keys()].map((key) => String(key || "").trim()).filter(Boolean))];
    const query = queryKeys.length
      ? `?${queryKeys.map((key) => `${encodeURIComponent(key)}=[redacted]`).join("&")}`
      : "";
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${query}`;
  } catch {
    const compact = source.replace(/\s+/g, " ").trim();
    return compact.length > 240 ? `${compact.slice(0, 240)}...` : compact;
  }
}

function toSingleHeaderValue(value) {
  if (Array.isArray(value)) {
    const rows = value.map((entry) => String(entry || "").trim()).filter(Boolean);
    if (!rows.length) return null;
    return rows.join(", ");
  }
  const single = String(value || "").trim();
  return single || null;
}

export function sanitizeHandshakeHeaders(headers: IncomingHttpHeaders = {}) {
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers || {})) {
    const name = String(rawName || "").trim().toLowerCase();
    if (!name) continue;
    const singleValue = toSingleHeaderValue(rawValue);
    if (!singleValue) continue;
    if (SENSITIVE_HEADER_RE.test(name)) {
      out[name] = "[redacted]";
      continue;
    }
    const compact = singleValue.replace(/\s+/g, " ").trim();
    out[name] = compact.length > 320 ? `${compact.slice(0, 320)}...` : compact;
  }
  return Object.keys(out).length ? out : null;
}

function normalizeBodyPreview(value) {
  const compact = String(value || "").replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return compact.length > MAX_HANDSHAKE_BODY_PREVIEW_CHARS
    ? `${compact.slice(0, MAX_HANDSHAKE_BODY_PREVIEW_CHARS)}...`
    : compact;
}

function createRealtimeConnectError({
  connectErrorPrefix,
  diagnostics,
  baseMessage = ""
}: {
  connectErrorPrefix: string;
  diagnostics: RealtimeConnectErrorDiagnostics;
  baseMessage?: string;
}): RealtimeConnectError {
  const details: string[] = [];
  const normalizedBase = String(baseMessage || "").replace(/\s+/g, " ").trim();
  if (normalizedBase) {
    details.push(normalizedBase);
  } else if (diagnostics.source === "timeout") {
    details.push("socket connect timed out");
  } else if (diagnostics.source === "unexpected_response") {
    const statusCode = Number.isFinite(Number(diagnostics.statusCode)) ? Number(diagnostics.statusCode) : null;
    const statusMessage = String(diagnostics.statusMessage || "").trim();
    const statusSummary = statusCode
      ? statusMessage
        ? `unexpected handshake response HTTP ${statusCode} ${statusMessage}`
        : `unexpected handshake response HTTP ${statusCode}`
      : "unexpected handshake response";
    details.push(statusSummary);
  } else {
    details.push("socket error during websocket connect");
  }

  if (diagnostics.url) {
    details.push(`url=${diagnostics.url}`);
  }
  if (diagnostics.headers) {
    details.push(`headers=${safeJsonPreview(diagnostics.headers, 620)}`);
  }
  if (diagnostics.bodyPreview) {
    details.push(`body=${diagnostics.bodyPreview}`);
  }

  let message = `${connectErrorPrefix}: ${details.join("; ")}`.trim();
  if (message.length > MAX_CONNECT_ERROR_MESSAGE_CHARS) {
    message = `${message.slice(0, MAX_CONNECT_ERROR_MESSAGE_CHARS)}...`;
  }

  const error: RealtimeConnectError = new Error(message);
  error.name = "RealtimeSocketConnectError";
  error.diagnostics = diagnostics;
  return error;
}

export function getRealtimeConnectErrorDiagnostics(error): RealtimeConnectErrorDiagnostics | null {
  if (!error || typeof error !== "object") return null;
  const candidate = (error as RealtimeConnectError).diagnostics;
  if (!candidate || typeof candidate !== "object") return null;
  const source = String(candidate.source || "").trim();
  if (
    source !== "unexpected_response" &&
    source !== "socket_error" &&
    source !== "timeout"
  ) {
    return null;
  }
  return {
    source,
    url: candidate.url ? String(candidate.url) : null,
    statusCode: Number.isFinite(Number(candidate.statusCode)) ? Number(candidate.statusCode) : null,
    statusMessage: candidate.statusMessage ? String(candidate.statusMessage) : null,
    headers:
      candidate.headers && typeof candidate.headers === "object"
        ? Object.fromEntries(
            Object.entries(candidate.headers).map(([key, value]) => [String(key), String(value)])
          )
        : null,
    bodyPreview: candidate.bodyPreview ? String(candidate.bodyPreview) : null
  };
}

async function readHandshakeBodyPreview(response: IncomingMessage) {
  return await new Promise<string>((resolve) => {
    let settled = false;
    let body = "";

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(waitTimer);
      response.removeListener("data", onData);
      resolve(body);
    };

    const onData = (chunk: Buffer | string) => {
      if (body.length >= MAX_HANDSHAKE_BODY_PREVIEW_CHARS) return;
      body += String(chunk || "");
      if (body.length >= MAX_HANDSHAKE_BODY_PREVIEW_CHARS) {
        body = body.slice(0, MAX_HANDSHAKE_BODY_PREVIEW_CHARS);
      }
    };

    const waitTimer = setTimeout(() => {
      finish();
    }, MAX_HANDSHAKE_CAPTURE_WAIT_MS);

    response.setEncoding("utf8");
    response.on("data", onData);
    response.once("end", finish);
    response.once("close", finish);
    response.once("error", finish);
  });
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

function recordOutboundEvent(client, {
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
    const summarizedUrl = summarizeRealtimeSocketUrl(url);

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
      reject(
        createRealtimeConnectError({
          connectErrorPrefix,
          diagnostics: {
            source: "timeout",
            url: summarizedUrl,
            statusCode: null,
            statusMessage: null,
            headers: null,
            bodyPreview: null
          },
          baseMessage: timeoutMessage
        })
      );
    }, timeoutMs + 1000);

    ws.once("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(ws);
    });

    ws.once("unexpected-response", (request: ClientRequest, response: IncomingMessage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void readHandshakeBodyPreview(response)
        .then((body) => {
          reject(
            createRealtimeConnectError({
              connectErrorPrefix,
              diagnostics: {
                source: "unexpected_response",
                url: summarizedUrl,
                statusCode: Number(response?.statusCode) || null,
                statusMessage: String(response?.statusMessage || "").trim() || null,
                headers: sanitizeHandshakeHeaders(response?.headers || {}),
                bodyPreview: normalizeBodyPreview(body)
              }
            })
          );
        })
        .finally(() => {
          try {
            response.destroy();
          } catch {
            // ignore
          }
          try {
            request.destroy();
          } catch {
            // ignore
          }
          try {
            ws.terminate();
          } catch {
            // ignore
          }
        });
    });

    // Keep this listener attached for the socket lifetime so follow-up
    // handshake/teardown errors cannot surface as unhandled "error" events.
    ws.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(
        createRealtimeConnectError({
          connectErrorPrefix,
          diagnostics: {
            source: "socket_error",
            url: summarizedUrl,
            statusCode: null,
            statusMessage: null,
            headers: null,
            bodyPreview: null
          },
          baseMessage: String(error?.message || error)
        })
      );
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
