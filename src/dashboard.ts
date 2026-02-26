import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { getLlmModelCatalog } from "./pricing.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createDashboardServer({ appConfig, store, bot, memory }) {
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.use("/api", (req, res, next) => {
    if (!appConfig.dashboardToken) return next();

    const presented = req.get("x-dashboard-token") || String(req.query.token || "");
    if (presented === appConfig.dashboardToken) return next();

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

  app.get("/api/actions", (req, res) => {
    const limit = Number(req.query.limit || 200);
    res.json(store.getRecentActions(limit));
  });

  app.get("/api/stats", (_req, res) => {
    res.json({
      stats: store.getStats(),
      runtime: bot.getRuntimeState()
    });
  });

  app.get("/api/llm/models", (_req, res) => {
    const settings = store.getSettings();
    res.json(getLlmModelCatalog(settings?.llm?.pricing));
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

  const staticDir = path.resolve(__dirname, "../dashboard/dist");
  const indexPath = path.join(staticDir, "index.html");

  if (!fs.existsSync(indexPath)) {
    throw new Error("React dashboard build missing at dashboard/dist. Run `npm run build:ui`.");
  }

  app.use(express.static(staticDir));

  app.get("*", (_req, res) => {
    res.sendFile(indexPath);
  });

  const server = app.listen(appConfig.dashboardPort, () => {
    console.log(`Dashboard running on http://localhost:${appConfig.dashboardPort}`);
  });

  return { app, server };
}
