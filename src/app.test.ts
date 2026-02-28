import { test } from "bun:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { isDirectExecution, main, runCli } from "./app.ts";
import { appConfig } from "./config.ts";

function withDiscordToken(value, run) {
  const prior = appConfig.discordToken;
  appConfig.discordToken = value;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      appConfig.discordToken = prior;
    });
}

test("isDirectExecution only returns true for the current module path", () => {
  const appPath = fileURLToPath(new URL("./app.ts", import.meta.url));
  assert.equal(isDirectExecution(["node", appPath]), true);
  assert.equal(isDirectExecution(["node", "/tmp/other-entry.ts"]), false);
  assert.equal(isDirectExecution(["node"]), false);
});

test("main throws immediately when DISCORD_TOKEN is missing", async () => {
  await withDiscordToken("", async () => {
    await assert.rejects(() => main(), /Missing DISCORD_TOKEN/);
  });
});

test("runCli converts startup failures into exit code 1", async () => {
  const originalExit = process.exit;
  const originalError = console.error;
  let exitCode = null;
  const errors = [];

  process.exit = (code) => {
    exitCode = Number(code);
    throw new Error("__process_exit__");
  };
  console.error = (...args) => {
    errors.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    await withDiscordToken("", async () => {
      await assert.rejects(() => runCli(), /__process_exit__/);
    });
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }

  assert.equal(exitCode, 1);
  assert.equal(errors.length > 0, true);
  assert.match(errors[0] || "", /Fatal startup error:/);
});
