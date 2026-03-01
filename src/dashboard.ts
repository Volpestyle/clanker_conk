import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Response } from "express";
import { normalizeDashboardHost } from "./config.ts";
import { getLlmModelCatalog } from "./pricing.ts";
import { classifyApiAccessPath, isAllowedPublicApiPath, isPublicTunnelRequestHost } from "./publicIngressAccess.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STREAM_INGEST_API_PATH = "/voice/stream-ingest/frame";
const DASHBOARD_JSON_LIMIT = "7mb";
const PUBLIC_FRAME_REQUEST_WINDOW_MS = 60_000;
const PUBLIC_FRAME_REQUEST_MAX_PER_WINDOW = 1200;
const PUBLIC_FRAME_DECLARED_BYTES_MAX = 6_000_000;
const PUBLIC_SHARE_FRAME_PATH_RE = /^\/api\/voice\/share-session\/[a-z0-9_-]{16,}\/frame\/?$/i;

export function createDashboardServer({
  appConfig,
  store,
  bot,
  memory,
  publicHttpsEntrypoint = null,
  screenShareSessionManager = null
}) {
  const app = express();
  const publicFrameIngressRateLimit = new Map();
  const getStatsPayload = () => {
    const botRuntime = bot.getRuntimeState();
    return {
      stats: store.getStats(),
      runtime: {
        ...botRuntime,
        publicHttps: publicHttpsEntrypoint?.getState?.() || null,
        screenShare: screenShareSessionManager?.getRuntimeState?.() || null
      }
    };
  };

  app.use((req, res, next) => {
    if (!isPublicFrameIngressPath(req.path)) return next();

    const contentLengthHeader = String(req.get("content-length") || "").trim();
    if (contentLengthHeader) {
      const declaredBytes = Number(contentLengthHeader);
      if (Number.isFinite(declaredBytes) && declaredBytes > PUBLIC_FRAME_DECLARED_BYTES_MAX) {
        return res.status(413).json({
          accepted: false,
          reason: "payload_too_large"
        });
      }
    }

    const callerIp =
      String(req.get("cf-connecting-ip") || req.ip || req.socket?.remoteAddress || "").trim() || "unknown";
    const rateKey = `${callerIp}|${String(req.path || "")}`;
    const allowed = consumeFixedWindowRateLimit({
      buckets: publicFrameIngressRateLimit,
      key: rateKey,
      nowMs: Date.now(),
      windowMs: PUBLIC_FRAME_REQUEST_WINDOW_MS,
      maxRequests: PUBLIC_FRAME_REQUEST_MAX_PER_WINDOW
    });
    if (!allowed) {
      return res.status(429).json({
        accepted: false,
        reason: "ingest_rate_limited"
      });
    }
    return next();
  });

  // Supports max stream-watch frame payloads (4MB binary -> ~5.4MB JSON/base64 body).
  app.use(express.json({ limit: DASHBOARD_JSON_LIMIT }));
  app.use(express.urlencoded({ extended: true }));

  app.use("/api", (req, res, next) => {
    const apiAccessKind = classifyApiAccessPath(req.path);
    const isPublicApiRoute = isAllowedPublicApiPath(req.path);
    const dashboardToken = String(appConfig.dashboardToken || "").trim();
    const publicApiToken = String(appConfig.publicApiToken || "").trim();
    const presentedDashboardToken = req.get("x-dashboard-token") || req.query?.token || "";
    const presentedPublicToken = req.get("x-public-api-token") || "";
    const isDashboardAuthorized = Boolean(dashboardToken) && presentedDashboardToken === dashboardToken;
    const isPublicApiAuthorized = Boolean(publicApiToken) && presentedPublicToken === publicApiToken;
    const isPublicTunnelRequest = isRequestFromPublicTunnel(req, publicHttpsEntrypoint);
    const publicHttpsEnabled = Boolean(publicHttpsEntrypoint?.getState?.()?.enabled);

    if (isDashboardAuthorized) return next();
    if (apiAccessKind === "public_session_token") return next();
    if (apiAccessKind === "public_header_token" && isPublicApiAuthorized) return next();

    if (isPublicTunnelRequest && !isPublicApiRoute) {
      return res.status(404).json({ error: "Not found." });
    }

    if (apiAccessKind === "public_header_token") {
      if (!dashboardToken && !publicApiToken) {
        return res.status(503).json({
          accepted: false,
          reason: "dashboard_or_public_api_token_required"
        });
      }
      if (publicApiToken && !isPublicApiAuthorized) {
        return res.status(401).json({
          accepted: false,
          reason: "unauthorized_public_api_token"
        });
      }
      return res.status(401).json({
        accepted: false,
        reason: "unauthorized_dashboard_token"
      });
    }

    if (!dashboardToken) {
      if (publicHttpsEnabled) {
        return res.status(503).json({
          error: "dashboard_token_required_when_public_https_enabled"
        });
      }
      return next();
    }
    return res.status(401).json({ error: "Unauthorized. Provide x-dashboard-token." });
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/settings", (_req, res) => {
    res.json(store.getSettings());
  });

  app.put("/api/settings", async (req, res, next) => {
    try {
      const nextSettings = store.patchSettings(req.body || {});
      await bot.applyRuntimeSettings(nextSettings);
      res.json(nextSettings);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/settings/refresh", async (_req, res, next) => {
    try {
      if (!bot || typeof bot.applyRuntimeSettings !== "function") {
        return res.status(503).json({
          ok: false,
          reason: "settings_refresh_unavailable"
        });
      }

      const settings = store.getSettings();
      await bot.applyRuntimeSettings(settings);
      const runtimeState =
        typeof bot.getRuntimeState === "function"
          ? bot.getRuntimeState()
          : null;
      const activeVoiceSessions = Number(runtimeState?.voice?.activeCount) || 0;

      return res.json({
        ok: true,
        reason: "settings_refreshed",
        activeVoiceSessions
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/actions", (req, res) => {
    const limit = parseBoundedInt(req.query.limit, 200, 1, 1000);
    res.json(store.getRecentActions(limit));
  });

  app.get("/api/stats", (_req, res) => {
    res.json(getStatsPayload());
  });

  app.get("/api/public-https", (_req, res) => {
    res.json(publicHttpsEntrypoint?.getState?.() || null);
  });

  app.post("/api/voice/share-session", async (req, res, next) => {
    try {
      if (!screenShareSessionManager) {
        return res.status(503).json({
          ok: false,
          reason: "screen_share_manager_unavailable"
        });
      }

      const result = await screenShareSessionManager.createSession({
        guildId: String(req.body?.guildId || "").trim(),
        channelId: String(req.body?.channelId || "").trim(),
        requesterUserId: String(req.body?.requesterUserId || "").trim(),
        requesterDisplayName: String(req.body?.requesterDisplayName || "").trim(),
        targetUserId: String(req.body?.targetUserId || "").trim() || null,
        source: String(req.body?.source || "dashboard_api").trim() || "dashboard_api"
      });
      return res.status(result?.ok ? 200 : 400).json(result);
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/voice/share-session/:token/frame", async (req, res, next) => {
    try {
      if (!screenShareSessionManager) {
        return res.status(503).json({
          accepted: false,
          reason: "screen_share_manager_unavailable"
        });
      }
      const token = String(req.params?.token || "").trim();
      const dataBase64 = String(req.body?.dataBase64 || "").trim();
      const mimeType = String(req.body?.mimeType || "image/jpeg").trim() || "image/jpeg";
      const source = String(req.body?.source || "share_session_page").trim() || "share_session_page";
      if (!token || !dataBase64) {
        return res.status(400).json({
          accepted: false,
          reason: !token ? "share_session_token_required" : "frame_data_required"
        });
      }

      const result = await screenShareSessionManager.ingestFrameByToken({
        token,
        mimeType,
        dataBase64,
        source
      });
      const status = result?.accepted ? 200 : 400;
      return res.status(status).json(result || { accepted: false, reason: "unknown" });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/voice/share-session/:token/stop", (req, res) => {
    if (!screenShareSessionManager) {
      return res.status(503).json({
        ok: false,
        reason: "screen_share_manager_unavailable"
      });
    }
    const token = String(req.params?.token || "").trim();
    const reason = String(req.body?.reason || "stopped_by_user").trim() || "stopped_by_user";
    if (!token) {
      return res.status(400).json({
        ok: false,
        reason: "share_session_token_required"
      });
    }
    const stopped = screenShareSessionManager.stopSessionByToken({ token, reason });
    return res.json({
      ok: Boolean(stopped),
      reason: stopped ? "ok" : "share_session_not_found"
    });
  });

  app.post("/api/voice/join", async (req, res, next) => {
    try {
      if (!bot || typeof bot.requestVoiceJoinFromDashboard !== "function") {
        return res.status(503).json({
          ok: false,
          reason: "voice_join_unavailable"
        });
      }

      const result = await bot.requestVoiceJoinFromDashboard({
        guildId: String(req.body?.guildId || "").trim() || null,
        requesterUserId: String(req.body?.requesterUserId || "").trim() || null,
        textChannelId: String(req.body?.textChannelId || "").trim() || null,
        source: String(req.body?.source || "dashboard_voice_tab").trim() || "dashboard_voice_tab"
      });

      return res.json(
        result && typeof result === "object"
          ? result
          : {
              ok: false,
              reason: "voice_join_unknown"
            }
      );
    } catch (error) {
      return next(error);
    }
  });

  app.post(`/api${STREAM_INGEST_API_PATH}`, async (req, res, next) => {
    try {
      const guildId = String(req.body?.guildId || "").trim();
      const dataBase64 = String(req.body?.dataBase64 || "").trim();
      const streamerUserId = String(req.body?.streamerUserId || "").trim() || null;
      const mimeType = String(req.body?.mimeType || "image/jpeg").trim() || "image/jpeg";
      const source = String(req.body?.source || "api_stream_ingest").trim() || "api_stream_ingest";

      if (!guildId) {
        return res.status(400).json({
          accepted: false,
          reason: "guild_id_required"
        });
      }
      if (!dataBase64) {
        return res.status(400).json({
          accepted: false,
          reason: "frame_data_required"
        });
      }

      const result = await bot.ingestVoiceStreamFrame({
        guildId,
        streamerUserId,
        mimeType,
        dataBase64,
        source
      });
      return res.json(result || { accepted: false, reason: "unknown" });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/llm/models", (_req, res) => {
    const settings = store.getSettings();
    res.json(getLlmModelCatalog(settings?.llm?.pricing));
  });

  // ---- ElevenLabs voice management ----

  app.get("/api/elevenlabs/voices", async (_req, res, next) => {
    try {
      const apiKey = appConfig.elevenLabsApiKey;
      if (!apiKey) {
        return res.status(503).json({ error: "ELEVENLABS_API_KEY not configured" });
      }
      const response = await fetch("https://api.elevenlabs.io/v1/voices?show_legacy=false", {
        headers: { "xi-api-key": apiKey }
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return res.status(response.status).json({ error: `ElevenLabs API error: ${response.status}`, detail: text });
      }
      const data = await response.json();
      return res.json(data);
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/elevenlabs/voices", async (req, res, next) => {
    try {
      const apiKey = appConfig.elevenLabsApiKey;
      if (!apiKey) {
        return res.status(503).json({ error: "ELEVENLABS_API_KEY not configured" });
      }
      const { name, description, labels, removeBackgroundNoise, files } = req.body || {};
      if (!name || !files || !Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: "name and files (array of {name, dataBase64, mimeType}) are required" });
      }
      const formData = new FormData();
      formData.append("name", String(name));
      if (description) formData.append("description", String(description));
      if (labels) formData.append("labels", typeof labels === "string" ? labels : JSON.stringify(labels));
      if (removeBackgroundNoise) formData.append("remove_background_noise", "true");
      for (const file of files) {
        const buffer = Buffer.from(String(file.dataBase64 || ""), "base64");
        const blob = new Blob([buffer], { type: String(file.mimeType || "audio/mpeg") });
        formData.append("files", blob, String(file.name || "sample.mp3"));
      }
      const response = await fetch("https://api.elevenlabs.io/v1/voices/add", {
        method: "POST",
        headers: { "xi-api-key": apiKey },
        body: formData
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return res.status(response.status).json({ error: `ElevenLabs API error: ${response.status}`, detail: text });
      }
      const data = await response.json();
      return res.json(data);
    } catch (error) {
      return next(error);
    }
  });

  app.delete("/api/elevenlabs/voices/:voiceId", async (req, res, next) => {
    try {
      const apiKey = appConfig.elevenLabsApiKey;
      if (!apiKey) {
        return res.status(503).json({ error: "ELEVENLABS_API_KEY not configured" });
      }
      const voiceId = String(req.params?.voiceId || "").trim();
      if (!voiceId) {
        return res.status(400).json({ error: "voiceId is required" });
      }
      const response = await fetch(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`, {
        method: "DELETE",
        headers: { "xi-api-key": apiKey }
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return res.status(response.status).json({ error: `ElevenLabs API error: ${response.status}`, detail: text });
      }
      return res.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  // ---- Dashboard/Voice SSE live-stream ----
  const voiceSseClients = new Set<{ res: Response; blocked: boolean }>();
  const activitySseClients = new Set<{ res: Response; blocked: boolean }>();
  const writeSseEvent = (client: { res: Response; blocked: boolean }, eventName: string, payload: unknown) => {
    if (!client || client.blocked) return;
    try {
      const wirePayload = `event: ${String(eventName || "message")}\ndata: ${JSON.stringify(payload)}\n\n`;
      const wrote = client.res.write(wirePayload);
      if (wrote === false && typeof client.res.once === "function") {
        client.blocked = true;
        client.res.once("drain", () => {
          client.blocked = false;
        });
      }
    } catch {
      // caller handles client cleanup
      throw new Error("sse_write_failed");
    }
  };
  const broadcastSseEvent = (
    clients: Set<{ res: Response; blocked: boolean }>,
    eventName: string,
    payload: unknown
  ) => {
    if (!clients || clients.size === 0) return;
    for (const client of clients) {
      try {
        writeSseEvent(client, eventName, payload);
      } catch {
        clients.delete(client);
      }
    }
  };

  const previousActionListener = typeof store.onActionLogged === "function" ? store.onActionLogged : null;
  store.onActionLogged = (action) => {
    if (previousActionListener) {
      try {
        previousActionListener(action);
      } catch {
        // keep dashboard listener resilient
      }
    }

    if (activitySseClients.size > 0) {
      broadcastSseEvent(activitySseClients, "action_event", action);
      broadcastSseEvent(activitySseClients, "stats_update", getStatsPayload());
    }
    if (action?.kind?.startsWith("voice_") && voiceSseClients.size > 0) {
      broadcastSseEvent(voiceSseClients, "voice_event", action);
    }
  };

  app.get("/api/activity/events", (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const client = { res, blocked: false };
    activitySseClients.add(client);

    const sendSnapshot = () => {
      writeSseEvent(client, "activity_snapshot", {
        actions: store.getRecentActions(220),
        stats: getStatsPayload()
      });
    };
    const sendStats = () => {
      writeSseEvent(client, "stats_update", getStatsPayload());
    };

    try {
      sendSnapshot();
    } catch {
      activitySseClients.delete(client);
      return res.end();
    }

    const statsInterval = setInterval(() => {
      try {
        sendStats();
      } catch {
        activitySseClients.delete(client);
      }
    }, 3_000);

    const heartbeat = setInterval(() => {
      try {
        res.write(": heartbeat\n\n");
      } catch {
        // swallowed; close handler will clean up
      }
    }, 15_000);

    _req.on("close", () => {
      clearInterval(statsInterval);
      clearInterval(heartbeat);
      activitySseClients.delete(client);
    });
  });

  app.get("/api/voice/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const sendState = () => {
      try {
        const voiceState = bot.getRuntimeState()?.voice || { activeCount: 0, sessions: [] };
        res.write(`event: voice_state\ndata: ${JSON.stringify(voiceState)}\n\n`);
      } catch { /* swallow */ }
    };

    sendState();
    const stateInterval = setInterval(sendState, 3_000);
    const heartbeat = setInterval(() => {
      try { res.write(": heartbeat\n\n"); } catch { /* swallow */ }
    }, 15_000);

    const client = { res, blocked: false };
    voiceSseClients.add(client);

    req.on("close", () => {
      clearInterval(stateInterval);
      clearInterval(heartbeat);
      voiceSseClients.delete(client);
    });
  });

  app.get("/api/voice/history/sessions", (_req, res, next) => {
    try {
      const limit = Number(_req.query.limit) || 3;
      res.json(store.getRecentVoiceSessions(limit));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/voice/history/sessions/:sessionId/events", (_req, res, next) => {
    try {
      const sessionId = String(_req.params.sessionId || "");
      res.json(store.getVoiceSessionEvents(sessionId));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/memory", async (_req, res, next) => {
    try {
      const markdown = await memory.readMemoryMarkdown();
      res.json({ markdown });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/memory/refresh", async (_req, res, next) => {
    try {
      await memory.refreshMemoryMarkdown();
      const markdown = await memory.readMemoryMarkdown();
      res.json({ ok: true, markdown });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/memory/search", async (req, res, next) => {
    try {
      const queryText = String(req.query.q || "").trim();
      const guildId = String(req.query.guildId || "").trim();
      const channelId = String(req.query.channelId || "").trim() || null;
      const limit = Number(req.query.limit || 10);
      if (!queryText || !guildId) {
        return res.json({ results: [], queryText, guildId, channelId, limit: 0 });
      }

      const settings = store.getSettings();
      const results = await memory.searchDurableFacts({
        guildId,
        channelId,
        queryText,
        settings,
        trace: {
          guildId,
          channelId,
          source: "dashboard_memory_search"
        },
        limit
      });
      return res.json({
        queryText,
        guildId,
        channelId,
        limit,
        results
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/guilds", (_req, res) => {
    try {
      const guilds = bot.getGuilds();
      res.json(guilds.map((g) => ({ id: g.id, name: g.name })));
    } catch {
      res.json([]);
    }
  });

  app.post("/api/memory/simulate-slice", async (req, res, next) => {
    try {
      const userId = String(req.body?.userId || "").trim() || null;
      const guildId = String(req.body?.guildId || "").trim();
      const channelId = String(req.body?.channelId || "").trim() || null;
      const queryText = String(req.body?.queryText || "").trim();

      if (!guildId || !queryText) {
        return res.status(400).json({ error: "guildId and queryText are required" });
      }

      const settings = store.getSettings();
      const result = await memory.buildPromptMemorySlice({
        userId,
        guildId,
        channelId,
        queryText,
        settings,
        trace: { guildId, channelId, source: "dashboard_simulate_slice" }
      });

      return res.json({
        userFacts: result.userFacts || [],
        relevantFacts: result.relevantFacts || [],
        relevantMessages: result.relevantMessages || []
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/automations", (req, res) => {
    const guildId = String(req.query.guildId || "").trim();
    const channelId = String(req.query.channelId || "").trim() || null;
    const statusParam = String(req.query.status || "active,paused").trim();
    const query = String(req.query.q || "").trim();
    const limit = parseBoundedInt(req.query.limit, 30, 1, 120);

    if (!guildId) {
      return res.status(400).json({ error: "guildId is required" });
    }

    const statuses = statusParam
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    const rows = store.listAutomations({
      guildId,
      channelId,
      statuses,
      query,
      limit
    });
    return res.json({
      guildId,
      channelId,
      statuses,
      query,
      limit,
      rows
    });
  });

  app.get("/api/automations/runs", (req, res) => {
    const guildId = String(req.query.guildId || "").trim();
    const automationId = Number(req.query.automationId);
    const limit = parseBoundedInt(req.query.limit, 30, 1, 120);

    if (!guildId || !Number.isInteger(automationId) || automationId <= 0) {
      return res.status(400).json({ error: "guildId and automationId are required" });
    }

    const rows = store.getAutomationRuns({
      guildId,
      automationId,
      limit
    });
    return res.json({
      guildId,
      automationId,
      limit,
      rows
    });
  });

  app.use((req, res, next) => {
    const isApiRoute = req.path === "/api" || req.path.startsWith("/api/");
    if (isApiRoute) return next();
    if (!isRequestFromPublicTunnel(req, publicHttpsEntrypoint)) return next();
    if (req.path.startsWith("/share/")) return next();
    return res.status(404).send("Not found.");
  });

  app.get("/share/:token", (req, res) => {
    if (!screenShareSessionManager) {
      return res.status(503).send("Screen share link unavailable.");
    }
    const rendered = screenShareSessionManager.renderSharePage(String(req.params?.token || "").trim());
    return res.status(rendered?.statusCode || 200).send(String(rendered?.html || ""));
  });

  const staticDir = path.resolve(__dirname, "../dashboard/dist");
  const indexPath = path.join(staticDir, "index.html");

  if (!fs.existsSync(indexPath)) {
    throw new Error("React dashboard build missing at dashboard/dist. Run `bun run build:ui`.");
  }

  app.use(express.static(staticDir));

  app.get("*", (_req, res) => {
    res.sendFile(indexPath);
  });

  const dashboardHost = normalizeDashboardHost(appConfig.dashboardHost);
  const server = app.listen(appConfig.dashboardPort, dashboardHost, () => {
    console.log(`Dashboard running on http://${dashboardHost}:${appConfig.dashboardPort}`);
  });

  return { app, server };
}

function parseBoundedInt(value, fallback, min, max) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function isRequestFromPublicTunnel(req, publicHttpsEntrypoint) {
  const requestHost = String(req.get("x-forwarded-host") || req.get("host") || "").trim();
  if (!requestHost) return false;
  const publicState = publicHttpsEntrypoint?.getState?.() || null;
  return isPublicTunnelRequestHost(requestHost, publicState);
}

function isPublicFrameIngressPath(rawPath) {
  const normalizedPath = String(rawPath || "").trim();
  if (!normalizedPath) return false;
  if (normalizedPath === `/api${STREAM_INGEST_API_PATH}` || normalizedPath === `/api${STREAM_INGEST_API_PATH}/`) {
    return true;
  }
  return PUBLIC_SHARE_FRAME_PATH_RE.test(normalizedPath);
}

function consumeFixedWindowRateLimit({ buckets, key, nowMs, windowMs, maxRequests }) {
  if (!buckets || !key) return false;
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const windowSpan = Math.max(1, Number(windowMs) || 1);
  const maxInWindow = Math.max(1, Number(maxRequests) || 1);

  let bucket = buckets.get(key) || null;
  if (!bucket || now - Number(bucket.windowStartedAt || 0) >= windowSpan) {
    bucket = {
      windowStartedAt: now,
      count: 0,
      lastSeenAt: now
    };
    buckets.set(key, bucket);
  }

  if (Number(bucket.count || 0) >= maxInWindow) {
    bucket.lastSeenAt = now;
    pruneRateLimitBuckets(buckets, now, windowSpan);
    return false;
  }

  bucket.count = Number(bucket.count || 0) + 1;
  bucket.lastSeenAt = now;
  pruneRateLimitBuckets(buckets, now, windowSpan);
  return true;
}

function pruneRateLimitBuckets(buckets, nowMs, windowMs) {
  if (!buckets || buckets.size <= 2500) return;
  const staleBefore = nowMs - windowMs * 3;
  for (const [key, bucket] of buckets.entries()) {
    if (Number(bucket?.lastSeenAt || 0) < staleBefore) {
      buckets.delete(key);
    }
    if (buckets.size <= 1500) break;
  }
}
