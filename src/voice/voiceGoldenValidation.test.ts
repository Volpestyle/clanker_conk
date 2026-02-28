import { test } from "bun:test";
import assert from "node:assert/strict";
import { runVoiceGoldenHarness, VOICE_GOLDEN_MODES } from "./voiceGoldenHarness.ts";

test("voice golden validation harness passes simulated suite across all modes", { timeout: 30_000 }, async () => {
  const report = await runVoiceGoldenHarness({
    mode: "simulated",
    modes: [...VOICE_GOLDEN_MODES],
    iterations: 1,
    judge: {
      enabled: false
    },
    maxCases: 6
  });

  assert.equal(report.modeReports.length, VOICE_GOLDEN_MODES.length);
  assert.equal(report.summary.executed > 0, true);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.passRate, 100);

  for (const modeReport of report.modeReports) {
    assert.equal(modeReport.skippedReason, null);
    assert.equal(modeReport.aggregates.executed > 0, true);
    assert.equal(modeReport.aggregates.failed, 0);
  }
});
