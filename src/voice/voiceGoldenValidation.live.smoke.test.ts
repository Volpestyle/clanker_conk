import { test } from "bun:test";
import assert from "node:assert/strict";
import { createVoiceGoldenCaseProgressLogger, runVoiceGoldenHarness, VOICE_GOLDEN_MODES } from "./voiceGoldenHarness.ts";
import { envFlag, envNumber } from "../testHelpers.ts";

function envModes(name: string) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return [...VOICE_GOLDEN_MODES];

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is (typeof VOICE_GOLDEN_MODES)[number] => {
      return (VOICE_GOLDEN_MODES as readonly string[]).includes(value);
    });
}

function resolveLiveGoldenModes() {
  if (envFlag("LIVE_VOICE_GOLDEN_BRAIN_ONLY", false)) {
    return ["voice_agent"] as (typeof VOICE_GOLDEN_MODES)[number][];
  }
  return envModes("LIVE_VOICE_GOLDEN_MODES");
}

test("smoke: voice golden validation harness hits live APIs and reports perf", { timeout: 15 * 60_000 }, async () => {
  if (!envFlag("RUN_LIVE_VOICE_GOLDEN")) return;

  const report = await runVoiceGoldenHarness({
    mode: "live",
    modes: resolveLiveGoldenModes(),
    iterations: Math.max(1, Math.floor(envNumber("LIVE_VOICE_GOLDEN_ITERATIONS", 1))),
    actorProvider: String(process.env.LIVE_VOICE_GOLDEN_ACTOR_PROVIDER || "claude-code").trim() || "claude-code",
    actorModel: String(process.env.LIVE_VOICE_GOLDEN_ACTOR_MODEL || "sonnet").trim() || "sonnet",
    deciderProvider:
      String(process.env.LIVE_VOICE_GOLDEN_DECIDER_PROVIDER || "claude-code").trim() || "claude-code",
    deciderModel: String(process.env.LIVE_VOICE_GOLDEN_DECIDER_MODEL || "sonnet").trim() || "sonnet",
    judge: {
      enabled: !envFlag("LIVE_VOICE_GOLDEN_NO_JUDGE"),
      provider: String(process.env.LIVE_VOICE_GOLDEN_JUDGE_PROVIDER || "claude-code").trim() || "claude-code",
      model: String(process.env.LIVE_VOICE_GOLDEN_JUDGE_MODEL || "sonnet").trim() || "sonnet"
    },
    onCaseProgress: createVoiceGoldenCaseProgressLogger(),
    allowMissingCredentials: envFlag("LIVE_VOICE_GOLDEN_ALLOW_MISSING_CREDENTIALS", false),
    maxCases: Math.max(1, Math.floor(envNumber("LIVE_VOICE_GOLDEN_MAX_CASES", 3)))
  });

  const minimumPassRate = Math.max(0, Math.min(100, envNumber("LIVE_VOICE_GOLDEN_MIN_PASS_RATE", 70)));
  assert.equal(report.summary.executed > 0, true, "Live harness executed zero cases.");
  assert.equal(
    report.summary.passRate >= minimumPassRate,
    true,
    `Live harness passRate=${report.summary.passRate.toFixed(1)} below threshold=${minimumPassRate}.`
  );

  const totalStats = report.summary.stageStats.totalMs;
  assert.equal(Boolean(totalStats), true, "Expected totalMs timing stats in live report.");
});
