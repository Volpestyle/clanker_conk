#!/usr/bin/env bun
/**
 * Renders all .mmd files in docs/diagrams/ to high-res PNGs using @mermaid-js/mermaid-cli.
 *
 * Usage:
 *   bun run diagrams            # render all .mmd files
 *   bun run diagrams -- foo.mmd # render a single file
 *
 * Requires: bunx mmdc (installed via @mermaid-js/mermaid-cli devDependency)
 */

import { readdirSync, existsSync } from "fs";
import { execSync } from "child_process";
import { resolve, basename } from "path";

const DIAGRAMS_DIR = resolve(import.meta.dirname, "../docs/diagrams");
const SCALE = 4; // 4x resolution for crisp images
const THEME = "default";
const BG_COLOR = "white";

// Allow rendering a single file via CLI arg
const targetFile = process.argv[2];

const mmdFiles = targetFile
  ? [targetFile]
  : readdirSync(DIAGRAMS_DIR).filter((f) => f.endsWith(".mmd"));

if (mmdFiles.length === 0) {
  console.log("No .mmd files found in docs/diagrams/");
  process.exit(0);
}

let failed = 0;

for (const file of mmdFiles) {
  const input = resolve(DIAGRAMS_DIR, file);
  const output = resolve(DIAGRAMS_DIR, file.replace(/\.mmd$/, ".png"));

  if (!existsSync(input)) {
    console.error(`  SKIP  ${file} (not found)`);
    failed++;
    continue;
  }

  console.log(`  RENDER  ${file} → ${basename(output)}`);
  try {
    execSync(
      `bunx mmdc -i "${input}" -o "${output}" -s ${SCALE} -t ${THEME} -b ${BG_COLOR}`,
      { stdio: "inherit" }
    );
  } catch {
    console.error(`  FAIL  ${file}`);
    failed++;
  }
}

console.log(
  `\nDone. ${mmdFiles.length - failed}/${mmdFiles.length} diagrams rendered.`
);
if (failed) process.exit(1);
