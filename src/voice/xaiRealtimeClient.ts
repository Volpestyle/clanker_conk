import WebSocket from "ws";

const XAI_REALTIME_URL = "wss://api.x.ai/v1/realtime";
const CONNECT_TIMEOUT_MS = 10_000;

export class XaiRealtimeClient {
  constructor({ apiKey, logger = null }) {
    this.apiKey = String(apiKey || "").trim();
    this.logger = typeof logger === "function" ? logger : null;
    this.ws = null;
    this.connectedAt = 0;
    this.lastEventAt = 0;
    this.lastError = null;
    this.sessionId = null;
    this.lastCloseCode = null;
    this.lastCloseReason = null;
  }

  async connect({
    voice = "Rex",
    instructions = "",
    region = "us-east-1",
    inputAudioFormat = "audio/pcm",
    outputAudioFormat = "audio/pcm"
  } = {}) {
    if (!this.apiKey) {
      throw new Error("Missing XAI_API_KEY for realtime voice runtime.");
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.getState();
    }

    const ws = await this.openSocket();
    this.ws = ws;
    this.connectedAt = Date.now();
    this.lastEventAt = Date.now();
    this.lastError = null;

    ws.on("message", (payload) => {
      this.lastEventAt = Date.now();
      this.handleIncoming(payload);
    });

    ws.on("error", (error) => {
      this.lastEventAt = Date.now();
      this.lastError = String(error?.message || error);
      this.log("warn", "xai_realtime_ws_error", { error: this.lastError });
    });

    ws.on("close", (code, reasonBuffer) => {
      this.lastEventAt = Date.now();
      this.lastCloseCode = Number(code) || null;
      this.lastCloseReason = reasonBuffer ? String(reasonBuffer) : null;
      this.log("info", "xai_realtime_ws_closed", {
        code: this.lastCloseCode,
        reason: this.lastCloseReason
      });
    });

    this.send({
      type: "session.update",
      session: compactObject({
        voice,
        instructions,
        input_audio_format: inputAudioFormat,
        output_audio_format: outputAudioFormat,
        region
      })
    });

    return this.getState();
  }

  async openSocket() {
    return await new Promise((resolve, reject) => {
      let settled = false;

      const ws = new WebSocket(XAI_REALTIME_URL, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`
        },
        handshakeTimeout: CONNECT_TIMEOUT_MS
      });

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        reject(new Error(`Timed out connecting to xAI realtime after ${CONNECT_TIMEOUT_MS}ms.`));
      }, CONNECT_TIMEOUT_MS + 1000);

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
        reject(new Error(`xAI realtime connection failed: ${String(error?.message || error)}`));
      });
    });
  }

  handleIncoming(payload) {
    let parsed = null;

    try {
      parsed = JSON.parse(String(payload || ""));
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object") return;

    if (parsed.type === "session.created") {
      this.sessionId = parsed.session?.id || this.sessionId;
      this.log("info", "xai_realtime_session_created", { sessionId: this.sessionId });
      return;
    }

    if (parsed.type === "error") {
      const message =
        parsed.error?.message || parsed.error?.code || parsed.message || "Unknown xAI realtime error";
      this.lastError = String(message);
      this.log("warn", "xai_realtime_error_event", { error: this.lastError });
    }
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("xAI realtime socket is not open.");
    }

    this.ws.send(JSON.stringify(payload));
  }

  async close() {
    if (!this.ws) return;
    if (this.ws.readyState === WebSocket.CLOSED) {
      this.ws = null;
      return;
    }

    await new Promise((resolve) => {
      const ws = this.ws;
      const done = () => {
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

    this.ws = null;
  }

  getState() {
    return {
      connected: Boolean(this.ws && this.ws.readyState === WebSocket.OPEN),
      connectedAt: this.connectedAt ? new Date(this.connectedAt).toISOString() : null,
      lastEventAt: this.lastEventAt ? new Date(this.lastEventAt).toISOString() : null,
      sessionId: this.sessionId,
      lastError: this.lastError,
      lastCloseCode: this.lastCloseCode,
      lastCloseReason: this.lastCloseReason
    };
  }

  log(level, event, metadata = null) {
    if (!this.logger) return;
    this.logger({ level, event, metadata });
  }
}

function compactObject(value) {
  const out = {};
  for (const [key, entry] of Object.entries(value || {})) {
    if (entry === undefined || entry === null || entry === "") continue;
    out[key] = entry;
  }
  return out;
}
