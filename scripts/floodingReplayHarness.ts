#!/usr/bin/env bun
import { runFloodingReplayHarness } from "./replay/scenarios/flooding.ts";

runFloodingReplayHarness(process.argv.slice(2)).catch((error) => {
  console.error("flooding replay harness failed:", error);
  process.exit(1);
});
