#!/usr/bin/env bun
import { runVoiceGoldenHarness, printVoiceGoldenHarnessReport, VOICE_GOLDEN_MODES } from "../src/voice/voiceGoldenHarness.ts";
import { writeJsonReport } from "./replay/core/output.ts";

type CliArgs = {
  mode: "simulated" | "live";
  modes: string;
  iterations: number;
  actorProvider: string;
  actorModel: string;
  deciderProvider: string;
  deciderModel: string;
  judge: boolean;
  judgeProvider: string;
  judgeModel: string;
  inputTransport: "audio" | "text";
  timeoutMs: number;
  allowMissingCredentials: boolean;
  maxCases: number;
  outJsonPath: string;
};

const DEFAULT_ARGS: CliArgs = {
  mode: "simulated",
  modes: VOICE_GOLDEN_MODES.join(","),
  iterations: 1,
  actorProvider: "openai",
  actorModel: "gpt-5-mini",
  deciderProvider: "openai",
  deciderModel: "gpt-5-nano",
  judge: false,
  judgeProvider: "openai",
  judgeModel: "gpt-5-mini",
  inputTransport: "audio",
  timeoutMs: 45_000,
  allowMissingCredentials: false,
  maxCases: 6,
  outJsonPath: ""
};

function parseArgs(argv: string[]): CliArgs {
  const out = { ...DEFAULT_ARGS };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "").trim();
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = String(argv[index + 1] || "").trim();
    const hasValue = next && !next.startsWith("--");
    if (hasValue) index += 1;

    switch (name) {
      case "mode":
        out.mode = hasValue && next === "live" ? "live" : "simulated";
        break;
      case "modes":
        if (hasValue) out.modes = next;
        break;
      case "iterations":
        if (hasValue) out.iterations = Math.max(1, Math.floor(Number(next) || 1));
        break;
      case "actor-provider":
        if (hasValue) out.actorProvider = next;
        break;
      case "actor-model":
        if (hasValue) out.actorModel = next;
        break;
      case "decider-provider":
        if (hasValue) out.deciderProvider = next;
        break;
      case "decider-model":
        if (hasValue) out.deciderModel = next;
        break;
      case "judge":
        out.judge = true;
        break;
      case "no-judge":
        out.judge = false;
        break;
      case "judge-provider":
        if (hasValue) out.judgeProvider = next;
        break;
      case "judge-model":
        if (hasValue) out.judgeModel = next;
        break;
      case "input-transport":
        if (hasValue) out.inputTransport = next === "text" ? "text" : "audio";
        break;
      case "timeout-ms":
        if (hasValue) out.timeoutMs = Math.max(5_000, Math.floor(Number(next) || 45_000));
        break;
      case "allow-missing-credentials":
        out.allowMissingCredentials = true;
        break;
      case "max-cases":
        if (hasValue) out.maxCases = Math.max(1, Math.floor(Number(next) || 6));
        break;
      case "out-json":
        if (hasValue) out.outJsonPath = next;
        break;
      default:
        break;
    }
  }

  if (out.mode === "live" && !argv.includes("--no-judge") && !argv.includes("--judge")) {
    out.judge = true;
  }

  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const modes = args.modes
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const report = await runVoiceGoldenHarness({
    mode: args.mode,
    modes: modes as (typeof VOICE_GOLDEN_MODES)[number][],
    iterations: args.iterations,
    actorProvider: args.actorProvider,
    actorModel: args.actorModel,
    deciderProvider: args.deciderProvider,
    deciderModel: args.deciderModel,
    judge: {
      enabled: args.judge,
      provider: args.judgeProvider,
      model: args.judgeModel
    },
    inputTransport: args.inputTransport,
    timeoutMs: args.timeoutMs,
    allowMissingCredentials: args.allowMissingCredentials,
    maxCases: args.maxCases
  });

  printVoiceGoldenHarnessReport(report);

  if (args.outJsonPath) {
    await writeJsonReport(args.outJsonPath, report);
  }

  if (report.summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("voice golden harness failed:", error);
  process.exit(1);
});
