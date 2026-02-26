import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function main() {
  const srcDir = path.resolve(process.cwd(), "src");
  const entries = await fs.readdir(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts")) continue;
    if (entry.name === "app.ts") continue;

    const modulePath = path.join(srcDir, entry.name);
    await import(pathToFileURL(modulePath).href);
  }
}

main().catch((error) => {
  console.error("Backend module parse check failed:", error);
  process.exit(1);
});
