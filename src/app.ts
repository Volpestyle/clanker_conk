import path from "node:path";
import { appConfig, ensureRuntimeEnv } from "./config.ts";
import { createDashboardServer } from "./dashboard.ts";
import { ClankerBot } from "./bot.ts";
import { DiscoveryService } from "./discovery.ts";
import { GifService } from "./gif.ts";
import { LLMService } from "./llm.ts";
import { MemoryManager } from "./memory.ts";
import { WebSearchService } from "./search.ts";
import { Store } from "./store.ts";
import { VideoContextService } from "./video.ts";
import { PublicHttpsEntrypoint } from "./publicHttpsEntrypoint.ts";
import { ScreenShareSessionManager } from "./screenShareSessionManager.ts";

async function main() {
  ensureRuntimeEnv();

  const dbPath = path.resolve(process.cwd(), "data", "clanker.db");
  const memoryFilePath = path.resolve(process.cwd(), "memory", "MEMORY.md");

  const store = new Store(dbPath);
  store.init();

  const llm = new LLMService({ appConfig, store });
  const discovery = new DiscoveryService({ store });
  const gifs = new GifService({ appConfig, store });
  const search = new WebSearchService({ appConfig, store });
  const video = new VideoContextService({ store, llm });
  const memory = new MemoryManager({ store, llm, memoryFilePath });
  await memory.refreshMemoryMarkdown();

  const bot = new ClankerBot({ appConfig, store, llm, memory, discovery, search, gifs, video });
  const publicHttpsEntrypoint = new PublicHttpsEntrypoint({ appConfig, store });
  const screenShareSessionManager = new ScreenShareSessionManager({
    appConfig,
    store,
    bot,
    publicHttpsEntrypoint
  });
  bot.attachScreenShareSessionManager(screenShareSessionManager);
  const dashboard = createDashboardServer({
    appConfig,
    store,
    bot,
    memory,
    publicHttpsEntrypoint,
    screenShareSessionManager
  });

  await bot.start();
  await publicHttpsEntrypoint.start();

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;

    console.log(`Shutting down (${signal})...`);

    try {
      await bot.stop();
    } catch {
      // ignore
    }

    try {
      await publicHttpsEntrypoint.stop();
    } catch {
      // ignore
    }

    await new Promise((resolve) => dashboard.server.close(resolve));
    store.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
