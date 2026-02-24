import path from "node:path";
import { appConfig, ensureRuntimeEnv } from "./config.js";
import { createDashboardServer } from "./dashboard.js";
import { ClankerBot } from "./bot.js";
import { DiscoveryService } from "./discovery.js";
import { LLMService } from "./llm.js";
import { MemoryManager } from "./memory.js";
import { Store } from "./store.js";

async function main() {
  ensureRuntimeEnv();

  const dbPath = path.resolve(process.cwd(), "data", "clanker.db");
  const memoryFilePath = path.resolve(process.cwd(), "memory", "MEMORY.md");

  const store = new Store(dbPath);
  store.init();

  const llm = new LLMService({ appConfig, store });
  const discovery = new DiscoveryService({ store });
  const memory = new MemoryManager({ store, memoryFilePath });
  await memory.refreshMemoryMarkdown();

  const bot = new ClankerBot({ appConfig, store, llm, memory, discovery });
  const dashboard = createDashboardServer({ appConfig, store, bot, memory });

  await bot.start();

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
