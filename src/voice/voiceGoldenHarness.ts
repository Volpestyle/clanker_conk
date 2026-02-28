import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { appConfig } from "../config.ts";
import { LLMService } from "../llm.ts";
import { DEFAULT_SETTINGS } from "../settings/settingsSchema.ts";
import { normalizeSettings } from "../store/settingsNormalization.ts";
import { VoiceSessionManager } from "./voiceSessionManager.ts";
import { encodePcm16MonoAsWav, transcriptSourceFromEventType } from "./voiceSessionHelpers.ts";
import { OpenAiRealtimeClient } from "./openaiRealtimeClient.ts";
import { XaiRealtimeClient } from "./xaiRealtimeClient.ts";
import { GeminiRealtimeClient } from "./geminiRealtimeClient.ts";

export const VOICE_GOLDEN_MODES = [
  "stt_pipeline",
  "voice_agent",
  "openai_realtime",
  "gemini_realtime"
] as const;

export type VoiceGoldenMode = (typeof VOICE_GOLDEN_MODES)[number];
export type VoiceGoldenRunMode = "simulated" | "live";
export type VoiceGoldenInputTransport = "audio" | "text";

type VoiceGoldenCase = {
  id: string;
  title: string;
  userText: string;
  expectedAllow: boolean;
  objective: string;
};

type VoiceGoldenJudgeConfig = {
  enabled: boolean;
  provider: string;
  model: string;
};

export type VoiceGoldenHarnessOptions = {
  mode?: VoiceGoldenRunMode;
  modes?: VoiceGoldenMode[];
  iterations?: number;
  actorProvider?: string;
  actorModel?: string;
  deciderProvider?: string;
  deciderModel?: string;
  judge?: Partial<VoiceGoldenJudgeConfig>;
  inputTransport?: VoiceGoldenInputTransport;
  timeoutMs?: number;
  allowMissingCredentials?: boolean;
  maxCases?: number;
};

type VoiceGoldenResolvedOptions = {
  mode: VoiceGoldenRunMode;
  modes: VoiceGoldenMode[];
  iterations: number;
  actorProvider: string;
  actorModel: string;
  deciderProvider: string;
  deciderModel: string;
  judge: VoiceGoldenJudgeConfig;
  inputTransport: VoiceGoldenInputTransport;
  timeoutMs: number;
  allowMissingCredentials: boolean;
  maxCases: number;
};

type StageTimings = {
  totalMs: number;
  decisionMs: number;
  connectMs: number;
  inputPrepMs: number;
  inputSendMs: number;
  actorMs: number;
  asrMs: number;
  ttsMs: number;
  outputAsrMs: number;
  responseMs: number;
};

type DecisionResult = {
  allow: boolean;
  reason: string;
  directAddressed: boolean;
  transcript: string;
  llmProvider: string;
  llmModel: string;
  llmResponse: string;
  error: string;
};

type ModeExecutionResult = {
  transcript: string;
  responseText: string;
  audioBytes: number;
  stage: Omit<StageTimings, "totalMs" | "decisionMs">;
};

type JudgeResult = {
  pass: boolean;
  score: number;
  confidence: number;
  summary: string;
  issues: string[];
  rawText: string;
};

export type VoiceGoldenCaseResult = {
  mode: VoiceGoldenMode;
  caseId: string;
  caseTitle: string;
  iteration: number;
  expectedAllow: boolean;
  decision: DecisionResult;
  transcript: string;
  responseText: string;
  audioBytes: number;
  timings: StageTimings;
  pass: boolean;
  judge: JudgeResult;
  error: string | null;
};

export type VoiceGoldenModeReport = {
  mode: VoiceGoldenMode;
  skippedReason: string | null;
  results: VoiceGoldenCaseResult[];
  aggregates: {
    executed: number;
    passed: number;
    failed: number;
    passRate: number;
    stageStats: Record<string, StageStat>;
  };
};

export type StageStat = {
  count: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
};

export type VoiceGoldenHarnessReport = {
  startedAt: string;
  finishedAt: string;
  options: VoiceGoldenResolvedOptions;
  modeReports: VoiceGoldenModeReport[];
  summary: {
    executed: number;
    passed: number;
    failed: number;
    passRate: number;
    stageStats: Record<string, StageStat>;
  };
};

type RealtimeTranscript = {
  text: string;
  eventType: string;
  source: "input" | "output" | "unknown";
};

type RealtimeClientLike = {
  connect: (args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  off: (event: string, handler: (...args: unknown[]) => void) => void;
  appendInputAudioPcm: (audioBuffer: Buffer) => void;
  commitInputAudioBuffer: () => void;
  createAudioResponse: () => void;
  requestTextUtterance: (promptText: string) => void;
};

type DecisionLlmTrace = {
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  source: string | null;
  event: string | null;
  reason: string | null;
  messageId: string | null;
};

type DecisionLlmGeneratePayload = {
  settings: Record<string, unknown>;
  systemPrompt: string;
  userPrompt: string;
  contextMessages?: unknown[];
  trace?: DecisionLlmTrace;
  jsonSchema?: string;
};

type DecisionLlmGenerateResult = {
  text?: string;
  provider?: string;
  model?: string;
};

type DecisionLlm = {
  generate: (payload: DecisionLlmGeneratePayload) => Promise<DecisionLlmGenerateResult>;
};

type HarnessStoreAction = {
  kind?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  usdCost?: number;
};

class HarnessStore {
  actions: HarnessStoreAction[];

  constructor() {
    this.actions = [];
  }

  logAction(action: HarnessStoreAction) {
    this.actions.push(action || {});
  }

  getSettings() {
    return {
      botName: "clanker conk"
    };
  }
}

const VOICE_GOLDEN_CASES: VoiceGoldenCase[] = [
  {
    id: "direct-question",
    title: "Direct Question",
    userText: "clanker can you explain in one sentence why rust ownership matters?",
    expectedAllow: true,
    objective: "Reply with a short, relevant explanation tied to Rust ownership."
  },
  {
    id: "merged-name",
    title: "Merged Name",
    userText: "clankerconk are you there right now?",
    expectedAllow: true,
    objective: "Acknowledge the direct callout and respond briefly."
  },
  {
    id: "wake-ping",
    title: "Wake Ping",
    userText: "yo clanker",
    expectedAllow: true,
    objective: "Give a short natural acknowledgement suitable for live voice."
  },
  {
    id: "low-signal-lol",
    title: "Low Signal Fragment",
    userText: "lol",
    expectedAllow: false,
    objective: "Do not respond because this is low-signal unaddressed chatter."
  },
  {
    id: "low-signal-comment",
    title: "Low Signal Comment",
    userText: "ha!",
    expectedAllow: false,
    objective: "Do not respond because this is unaddressed side chatter."
  },
  {
    id: "unaddressed-clear-question",
    title: "Unaddressed Clear Question",
    userText: "what's the fastest way to reduce build times in this project?",
    expectedAllow: true,
    objective: "Provide a concise practical suggestion even without explicit bot naming."
  }
];

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_CASES = VOICE_GOLDEN_CASES.length;

function parseBool(value: unknown, fallback = false) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeMode(value: unknown): VoiceGoldenRunMode {
  return String(value || "simulated").trim().toLowerCase() === "live" ? "live" : "simulated";
}

function normalizeInputTransport(value: unknown): VoiceGoldenInputTransport {
  return String(value || "audio").trim().toLowerCase() === "text" ? "text" : "audio";
}

function normalizeVoiceModeList(values: unknown): VoiceGoldenMode[] {
  if (Array.isArray(values)) {
    return values
      .map((value) => normalizeVoiceMode(value))
      .filter((value): value is VoiceGoldenMode => Boolean(value));
  }
  if (typeof values === "string") {
    return values
      .split(",")
      .map((value) => normalizeVoiceMode(value))
      .filter((value): value is VoiceGoldenMode => Boolean(value));
  }
  return [...VOICE_GOLDEN_MODES];
}

function normalizeVoiceMode(value: unknown): VoiceGoldenMode | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "stt_pipeline") return "stt_pipeline";
  if (normalized === "voice_agent") return "voice_agent";
  if (normalized === "openai_realtime") return "openai_realtime";
  if (normalized === "gemini_realtime") return "gemini_realtime";
  return null;
}

function resolveDefaults(options: VoiceGoldenHarnessOptions = {}): VoiceGoldenResolvedOptions {
  const requestedModes = normalizeVoiceModeList(options.modes);
  return {
    mode: normalizeMode(options.mode),
    modes: requestedModes.length ? requestedModes : [...VOICE_GOLDEN_MODES],
    iterations: Math.max(1, Math.floor(Number(options.iterations) || 1)),
    actorProvider: String(options.actorProvider || "openai").trim() || "openai",
    actorModel: String(options.actorModel || "gpt-5-mini").trim() || "gpt-5-mini",
    deciderProvider: String(options.deciderProvider || "openai").trim() || "openai",
    deciderModel: String(options.deciderModel || "gpt-5-nano").trim() || "gpt-5-nano",
    judge: {
      enabled:
        options.judge?.enabled !== undefined
          ? Boolean(options.judge.enabled)
          : normalizeMode(options.mode) === "live",
      provider: String(options.judge?.provider || "openai").trim() || "openai",
      model: String(options.judge?.model || "gpt-5-mini").trim() || "gpt-5-mini"
    },
    inputTransport: normalizeInputTransport(options.inputTransport),
    timeoutMs: Math.max(5000, Math.floor(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS)),
    allowMissingCredentials: parseBool(options.allowMissingCredentials, false),
    maxCases: Math.max(1, Math.min(VOICE_GOLDEN_CASES.length, Math.floor(Number(options.maxCases) || DEFAULT_MAX_CASES)))
  };
}

function buildHarnessSettings({
  voiceMode,
  actorProvider,
  actorModel,
  deciderProvider,
  deciderModel
}: {
  voiceMode: VoiceGoldenMode;
  actorProvider: string;
  actorModel: string;
  deciderProvider: string;
  deciderModel: string;
}) {
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    botName: "clanker conk",
    memory: {
      enabled: false
    },
    webSearch: {
      enabled: false
    },
    llm: {
      provider: actorProvider,
      model: actorModel,
      temperature: 0.25,
      maxOutputTokens: 160
    },
    voice: {
      enabled: true,
      mode: voiceMode,
      replyEagerness: 65,
      replyDecisionLlm: {
        enabled: true,
        provider: deciderProvider,
        model: deciderModel,
        maxAttempts: 2
      },
      xai: {
        voice: "Rex",
        audioFormat: "audio/pcm",
        sampleRateHz: 24000,
        region: "us-east-1"
      },
      openaiRealtime: {
        model: "gpt-realtime",
        voice: "alloy",
        inputAudioFormat: "pcm16",
        outputAudioFormat: "pcm16",
        inputTranscriptionModel: "gpt-4o-mini-transcribe"
      },
      geminiRealtime: {
        model: "gemini-2.5-flash-native-audio-preview-12-2025",
        voice: "Aoede",
        apiBaseUrl: "https://generativelanguage.googleapis.com",
        inputSampleRateHz: 24000,
        outputSampleRateHz: 24000
      },
      sttPipeline: {
        transcriptionModel: "gpt-4o-mini-transcribe",
        ttsModel: "gpt-4o-mini-tts",
        ttsVoice: "alloy",
        ttsSpeed: 1
      }
    }
  });
}

function buildJudgeSettings(judge: VoiceGoldenJudgeConfig) {
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    memory: {
      enabled: false
    },
    llm: {
      provider: judge.provider,
      model: judge.model,
      temperature: 0,
      maxOutputTokens: 260
    }
  });
}

function parseJsonObjectFromText(rawText: string) {
  const value = String(rawText || "").trim();
  if (!value) return null;
  try {
    const direct = JSON.parse(value);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      return direct as Record<string, unknown>;
    }
  } catch {
    // fall through
  }

  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  try {
    const sliced = JSON.parse(value.slice(firstBrace, lastBrace + 1));
    if (sliced && typeof sliced === "object" && !Array.isArray(sliced)) {
      return sliced as Record<string, unknown>;
    }
  } catch {
    // ignore
  }

  return null;
}

function stableNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function uniqueLines(values: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = String(value || "").replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function pickBestTranscript(values: string[]) {
  const normalized = uniqueLines(values);
  if (!normalized.length) return "";
  return normalized.sort((a, b) => b.length - a.length)[0] || "";
}

function quantile(values: number[], q: number) {
  const sorted = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] || 0;
}

function buildStageStats(rows: VoiceGoldenCaseResult[]): Record<string, StageStat> {
  const stageBuckets = new Map<string, number[]>();
  for (const row of rows) {
    const entries = Object.entries(row.timings);
    for (const [key, value] of entries) {
      if (!Number.isFinite(value) || value <= 0) continue;
      if (!stageBuckets.has(key)) stageBuckets.set(key, []);
      stageBuckets.get(key)?.push(value);
    }
  }

  const out: Record<string, StageStat> = {};
  for (const [stage, values] of stageBuckets.entries()) {
    const total = values.reduce((sum, value) => sum + value, 0);
    out[stage] = {
      count: values.length,
      minMs: Math.min(...values),
      maxMs: Math.max(...values),
      avgMs: total / values.length,
      p50Ms: quantile(values, 0.5),
      p95Ms: quantile(values, 0.95)
    };
  }

  return out;
}

function stablePassRate(passed: number, executed: number) {
  if (executed <= 0) return 0;
  return (100 * passed) / executed;
}

function hashString(value: string) {
  let hash = 0;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function simulatedDelayMs(key: string, baseMs: number, spreadMs: number) {
  const hash = hashString(key);
  return baseMs + (hash % Math.max(1, spreadMs));
}

async function sleepMs(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.floor(ms))));
}

function buildSimulatedDecisionLlm(): DecisionLlm {
  return {
    async generate(payload) {
      const prompt = String(payload?.userPrompt || "").toLowerCase();
      const transcriptMatch = prompt.match(/transcript:\s*"([^"]+)"/u);
      const transcript = String(transcriptMatch?.[1] || "").trim().toLowerCase();
      if (!transcript) return { text: "NO", provider: "simulated", model: "rule-decider" };
      if (transcript.includes("clanker")) return { text: "YES", provider: "simulated", model: "rule-decider" };
      if (/[?]/.test(transcript) && transcript.length > 6) {
        return { text: "YES", provider: "simulated", model: "rule-decider" };
      }
      const lowSignal = transcript.split(/\s+/u).filter(Boolean).length <= 2;
      return {
        text: lowSignal ? "NO" : "YES",
        provider: "simulated",
        model: "rule-decider"
      };
    }
  };
}

function createDecisionRuntime(llm: DecisionLlm) {
  const store = new HarnessStore();
  const manager = new VoiceSessionManager({
    client: {
      on() {},
      off() {},
      guilds: { cache: new Map() },
      users: { cache: new Map() },
      user: { id: "bot-user", username: "clanker conk" }
    },
    store,
    appConfig,
    llm,
    memory: null
  });
  manager.countHumanVoiceParticipants = () => 2;
  manager.getVoiceChannelParticipants = () => [{ displayName: "alice" }, { displayName: "bob" }];
  return {
    manager,
    store
  };
}

function createDecisionSession(mode: VoiceGoldenMode) {
  return {
    id: `voice-golden-${mode}`,
    guildId: "voice-golden-guild",
    textChannelId: "voice-golden-text",
    voiceChannelId: "voice-golden-voice",
    mode,
    botTurnOpen: false,
    startedAt: Date.now() - 12_000,
    recentVoiceTurns: []
  };
}

async function evaluateDecision({
  manager,
  settings,
  mode,
  transcript
}: {
  manager: VoiceSessionManager;
  settings: Record<string, unknown>;
  mode: VoiceGoldenMode;
  transcript: string;
}) {
  const startedAt = performance.now();
  const decision = await manager.evaluateVoiceReplyDecision({
    session: createDecisionSession(mode),
    userId: "speaker-1",
    settings,
    transcript,
    source: mode === "stt_pipeline" ? "stt_pipeline" : "realtime"
  });
  const decisionMs = performance.now() - startedAt;

  return {
    decisionMs,
    decision: {
      allow: Boolean(decision.allow),
      reason: String(decision.reason || ""),
      directAddressed: Boolean(decision.directAddressed),
      transcript: String(decision.transcript || transcript || "").trim(),
      llmProvider: String(decision.llmProvider || ""),
      llmModel: String(decision.llmModel || ""),
      llmResponse: String(decision.llmResponse || ""),
      error: String(decision.error || "")
    }
  };
}

async function withTempWavFromPcm<T>(pcmBuffer: Buffer, sampleRateHz: number, run: (filePath: string) => Promise<T>) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-golden-"));
  const wavPath = path.join(tempDir, "sample.wav");
  try {
    await fs.writeFile(wavPath, encodePcm16MonoAsWav(pcmBuffer, sampleRateHz));
    return await run(wavPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function synthesizeInputAudio({
  llm,
  text,
  settings,
  traceSource
}: {
  llm: LLMService;
  text: string;
  settings: Record<string, unknown>;
  traceSource: string;
}) {
  return await llm.synthesizeSpeech({
    text,
    model:
      String((settings as { voice?: { sttPipeline?: { ttsModel?: string } } })?.voice?.sttPipeline?.ttsModel || "gpt-4o-mini-tts") ||
      "gpt-4o-mini-tts",
    voice:
      String((settings as { voice?: { sttPipeline?: { ttsVoice?: string } } })?.voice?.sttPipeline?.ttsVoice || "alloy") || "alloy",
    speed: Number((settings as { voice?: { sttPipeline?: { ttsSpeed?: number } } })?.voice?.sttPipeline?.ttsSpeed) || 1,
    responseFormat: "pcm",
    trace: {
      guildId: "voice-golden-guild",
      channelId: "voice-golden-text",
      userId: "speaker-1",
      source: traceSource
    }
  });
}

async function runLiveSttPipelineCase({
  llm,
  manager,
  settings,
  caseRow
}: {
  llm: LLMService;
  manager: VoiceSessionManager;
  settings: Record<string, unknown>;
  caseRow: VoiceGoldenCase;
}): Promise<ModeExecutionResult> {
  const stage = {
    connectMs: 0,
    inputPrepMs: 0,
    inputSendMs: 0,
    actorMs: 0,
    asrMs: 0,
    ttsMs: 0,
    outputAsrMs: 0,
    responseMs: 0
  };

  const inputPrepStarted = performance.now();
  const inputAudio = await synthesizeInputAudio({
    llm,
    text: caseRow.userText,
    settings,
    traceSource: "voice_golden_stt_input_tts"
  });
  stage.inputPrepMs = performance.now() - inputPrepStarted;

  const asrStarted = performance.now();
  const transcript = await withTempWavFromPcm(inputAudio.audioBuffer, 24_000, async (filePath) => {
    return await llm.transcribeAudio({
      filePath,
      model:
        String(
          (settings as { voice?: { sttPipeline?: { transcriptionModel?: string } } })?.voice?.sttPipeline
            ?.transcriptionModel || "gpt-4o-mini-transcribe"
        ) || "gpt-4o-mini-transcribe",
      trace: {
        guildId: "voice-golden-guild",
        channelId: "voice-golden-text",
        userId: "speaker-1",
        source: "voice_golden_stt_input_asr"
      }
    });
  });
  stage.asrMs = performance.now() - asrStarted;

  const actorStarted = performance.now();
  const generation = await llm.generate({
    settings,
    systemPrompt: manager.buildVoiceInstructions(settings),
    userPrompt: [
      `Speaker transcript: "${String(transcript || caseRow.userText).replace(/\s+/g, " ").trim()}"`,
      "Reply with one short natural spoken response (max 20 words).",
      "If this should be skipped, output exactly [SKIP].",
      "No markdown."
    ].join("\n"),
    trace: {
      guildId: "voice-golden-guild",
      channelId: "voice-golden-text",
      userId: "speaker-1",
      source: "voice_golden_stt_actor",
      event: "stt_actor_generation",
      reason: null,
      messageId: null
    }
  });
  stage.actorMs = performance.now() - actorStarted;

  const responseText = String(generation.text || "")
    .replace(/\s+/g, " ")
    .trim();

  let audioBytes = 0;
  if (responseText && responseText !== "[SKIP]") {
    const ttsStarted = performance.now();
    const tts = await llm.synthesizeSpeech({
      text: responseText,
      model:
        String((settings as { voice?: { sttPipeline?: { ttsModel?: string } } })?.voice?.sttPipeline?.ttsModel || "gpt-4o-mini-tts") ||
        "gpt-4o-mini-tts",
      voice:
        String((settings as { voice?: { sttPipeline?: { ttsVoice?: string } } })?.voice?.sttPipeline?.ttsVoice || "alloy") || "alloy",
      speed: Number((settings as { voice?: { sttPipeline?: { ttsSpeed?: number } } })?.voice?.sttPipeline?.ttsSpeed) || 1,
      responseFormat: "pcm",
      trace: {
        guildId: "voice-golden-guild",
        channelId: "voice-golden-text",
        userId: "bot-user",
        source: "voice_golden_stt_output_tts"
      }
    });
    stage.ttsMs = performance.now() - ttsStarted;
    audioBytes = tts.audioBuffer.length;
  }

  return {
    transcript: String(transcript || "").trim(),
    responseText: responseText === "[SKIP]" ? "" : responseText,
    audioBytes,
    stage
  };
}

function createRealtimeClient({
  mode,
  logger,
  settings
}: {
  mode: VoiceGoldenMode;
  logger: (payload: { level: string; event: string; metadata: Record<string, unknown> | null }) => void;
  settings: Record<string, unknown>;
}): RealtimeClientLike {
  if (mode === "voice_agent") {
    return new XaiRealtimeClient({
      apiKey: appConfig.xaiApiKey,
      logger
    });
  }
  if (mode === "openai_realtime") {
    return new OpenAiRealtimeClient({
      apiKey: appConfig.openaiApiKey,
      logger
    });
  }
  return new GeminiRealtimeClient({
    apiKey: appConfig.geminiApiKey,
    baseUrl:
      String(
        (settings as { voice?: { geminiRealtime?: { apiBaseUrl?: string } } })?.voice?.geminiRealtime?.apiBaseUrl ||
          "https://generativelanguage.googleapis.com"
      ) || "https://generativelanguage.googleapis.com",
    logger
  });
}

async function connectRealtimeClient({
  mode,
  client,
  settings,
  manager
}: {
  mode: VoiceGoldenMode;
  client: RealtimeClientLike;
  settings: Record<string, unknown>;
  manager: VoiceSessionManager;
}) {
  const instructions = manager.buildVoiceInstructions(settings);
  if (mode === "voice_agent") {
    await client.connect({
      voice: String((settings as { voice?: { xai?: { voice?: string } } })?.voice?.xai?.voice || "Rex") || "Rex",
      region:
        String((settings as { voice?: { xai?: { region?: string } } })?.voice?.xai?.region || "us-east-1") || "us-east-1",
      inputAudioFormat:
        String((settings as { voice?: { xai?: { audioFormat?: string } } })?.voice?.xai?.audioFormat || "audio/pcm") ||
        "audio/pcm",
      outputAudioFormat:
        String((settings as { voice?: { xai?: { audioFormat?: string } } })?.voice?.xai?.audioFormat || "audio/pcm") ||
        "audio/pcm",
      inputSampleRateHz: Number((settings as { voice?: { xai?: { sampleRateHz?: number } } })?.voice?.xai?.sampleRateHz) || 24_000,
      outputSampleRateHz: Number((settings as { voice?: { xai?: { sampleRateHz?: number } } })?.voice?.xai?.sampleRateHz) || 24_000,
      instructions
    });
    return;
  }

  if (mode === "openai_realtime") {
    await client.connect({
      model:
        String((settings as { voice?: { openaiRealtime?: { model?: string } } })?.voice?.openaiRealtime?.model || "gpt-realtime") ||
        "gpt-realtime",
      voice:
        String((settings as { voice?: { openaiRealtime?: { voice?: string } } })?.voice?.openaiRealtime?.voice || "alloy") ||
        "alloy",
      inputAudioFormat:
        String(
          (settings as { voice?: { openaiRealtime?: { inputAudioFormat?: string } } })?.voice?.openaiRealtime
            ?.inputAudioFormat || "pcm16"
        ) || "pcm16",
      outputAudioFormat:
        String(
          (settings as { voice?: { openaiRealtime?: { outputAudioFormat?: string } } })?.voice?.openaiRealtime
            ?.outputAudioFormat || "pcm16"
        ) || "pcm16",
      inputTranscriptionModel:
        String(
          (settings as { voice?: { openaiRealtime?: { inputTranscriptionModel?: string } } })?.voice?.openaiRealtime
            ?.inputTranscriptionModel || "gpt-4o-mini-transcribe"
        ) || "gpt-4o-mini-transcribe",
      instructions
    });
    return;
  }

  await client.connect({
    model:
      String(
        (settings as { voice?: { geminiRealtime?: { model?: string } } })?.voice?.geminiRealtime?.model ||
          "gemini-2.5-flash-native-audio-preview-12-2025"
      ) || "gemini-2.5-flash-native-audio-preview-12-2025",
    voice:
      String((settings as { voice?: { geminiRealtime?: { voice?: string } } })?.voice?.geminiRealtime?.voice || "Aoede") ||
      "Aoede",
    inputSampleRateHz:
      Number((settings as { voice?: { geminiRealtime?: { inputSampleRateHz?: number } } })?.voice?.geminiRealtime?.inputSampleRateHz) ||
      24_000,
    outputSampleRateHz:
      Number((settings as { voice?: { geminiRealtime?: { outputSampleRateHz?: number } } })?.voice?.geminiRealtime?.outputSampleRateHz) ||
      24_000,
    instructions
  });
}

async function waitForRealtimeResponse({
  client,
  timeoutMs,
  outputSampleRateHz,
  llm
}: {
  client: RealtimeClientLike;
  timeoutMs: number;
  outputSampleRateHz: number;
  llm: LLMService | null;
}) {
  const transcripts: RealtimeTranscript[] = [];
  const outputAudioChunks: Buffer[] = [];
  let responseDonePayload: Record<string, unknown> | null = null;
  let errorText = "";

  const onTranscript = (row: { text?: string; eventType?: string }) => {
    const text = String(row?.text || "").replace(/\s+/g, " ").trim();
    if (!text) return;
    const eventType = String(row?.eventType || "").trim();
    const source = transcriptSourceFromEventType(eventType);
    transcripts.push({
      text,
      eventType,
      source: source === "input" || source === "output" ? source : "unknown"
    });
  };

  const onAudio = (chunkBase64: string) => {
    const normalized = String(chunkBase64 || "").trim();
    if (!normalized) return;
    try {
      outputAudioChunks.push(Buffer.from(normalized, "base64"));
    } catch {
      // ignore malformed base64 chunks
    }
  };

  const onError = (event: { message?: string }) => {
    errorText = String(event?.message || "").trim();
  };

  const onDone = (event: Record<string, unknown>) => {
    responseDonePayload = event || null;
  };

  client.on("transcript", onTranscript);
  client.on("audio_delta", onAudio);
  client.on("error_event", onError);
  client.on("response_done", onDone);

  const startedAt = performance.now();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for realtime response after ${timeoutMs}ms.`));
      }, timeoutMs);

      const poll = () => {
        if (responseDonePayload) {
          clearTimeout(timer);
          resolve();
          return;
        }
        setTimeout(poll, 60);
      };
      poll();
    });
  } finally {
    client.off("transcript", onTranscript);
    client.off("audio_delta", onAudio);
    client.off("error_event", onError);
    client.off("response_done", onDone);
  }

  const responseMs = performance.now() - startedAt;
  const outputTranscriptRows = transcripts
    .filter((row) => row.source === "output")
    .map((row) => row.text);
  const outputText = pickBestTranscript(outputTranscriptRows);
  const transcript = outputText || pickBestTranscript(transcripts.map((row) => row.text));

  let outputAsrMs = 0;
  let fallbackOutputTranscript = outputText;
  const outputAudioBytes = outputAudioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (!fallbackOutputTranscript && outputAudioBytes > 0 && llm?.isAsrReady?.()) {
    const mergedAudio = Buffer.concat(outputAudioChunks);
    const outputAsrStarted = performance.now();
    fallbackOutputTranscript = await withTempWavFromPcm(mergedAudio, outputSampleRateHz, async (filePath) => {
      return await llm.transcribeAudio({
        filePath,
        model: "gpt-4o-mini-transcribe",
        trace: {
          guildId: "voice-golden-guild",
          channelId: "voice-golden-text",
          userId: "bot-user",
          source: "voice_golden_realtime_output_asr"
        }
      });
    }).catch(() => "");
    outputAsrMs = performance.now() - outputAsrStarted;
  }

  return {
    transcript: String(fallbackOutputTranscript || transcript || "").trim(),
    audioBytes: outputAudioBytes,
    responseMs,
    outputAsrMs,
    responseDonePayload,
    errorText
  };
}

async function runLiveRealtimeCase({
  llm,
  manager,
  settings,
  mode,
  caseRow,
  inputTransport,
  timeoutMs
}: {
  llm: LLMService;
  manager: VoiceSessionManager;
  settings: Record<string, unknown>;
  mode: VoiceGoldenMode;
  caseRow: VoiceGoldenCase;
  inputTransport: VoiceGoldenInputTransport;
  timeoutMs: number;
}): Promise<ModeExecutionResult> {
  assert.notEqual(mode, "stt_pipeline");

  const stage = {
    connectMs: 0,
    inputPrepMs: 0,
    inputSendMs: 0,
    actorMs: 0,
    asrMs: 0,
    ttsMs: 0,
    outputAsrMs: 0,
    responseMs: 0
  };

  const client = createRealtimeClient({
    mode,
    settings,
    logger: ({ level, event, metadata }) => {
      void level;
      void event;
      void metadata;
    }
  });

  const connectStarted = performance.now();
  await connectRealtimeClient({
    mode,
    client,
    settings,
    manager
  });
  stage.connectMs = performance.now() - connectStarted;

  try {
    let inputAudioBuffer = Buffer.alloc(0);
    if (inputTransport === "audio") {
      const inputPrepStarted = performance.now();
      const inputAudio = await synthesizeInputAudio({
        llm,
        text: caseRow.userText,
        settings,
        traceSource: `voice_golden_${mode}_input_tts`
      });
      inputAudioBuffer = inputAudio.audioBuffer;
      stage.inputPrepMs = performance.now() - inputPrepStarted;
    }

    const sendStarted = performance.now();
    if (inputTransport === "audio") {
      client.appendInputAudioPcm(inputAudioBuffer);
      client.commitInputAudioBuffer();
      client.createAudioResponse();
    } else {
      client.requestTextUtterance(caseRow.userText);
    }
    stage.inputSendMs = performance.now() - sendStarted;

    const outputSampleRateHz =
      mode === "voice_agent"
        ? Number((settings as { voice?: { xai?: { sampleRateHz?: number } } })?.voice?.xai?.sampleRateHz) || 24_000
        : mode === "openai_realtime"
          ? 24_000
          : Number((settings as { voice?: { geminiRealtime?: { outputSampleRateHz?: number } } })?.voice?.geminiRealtime?.outputSampleRateHz) ||
            24_000;

    const realtimeResult = await waitForRealtimeResponse({
      client,
      timeoutMs,
      outputSampleRateHz,
      llm
    });

    stage.responseMs = realtimeResult.responseMs;
    stage.outputAsrMs = realtimeResult.outputAsrMs;
    if (realtimeResult.errorText) {
      throw new Error(realtimeResult.errorText);
    }

    return {
      transcript: "",
      responseText: realtimeResult.transcript,
      audioBytes: realtimeResult.audioBytes,
      stage
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function runSimulatedCase({
  mode,
  caseRow,
  decisionAllow,
  iteration
}: {
  mode: VoiceGoldenMode;
  caseRow: VoiceGoldenCase;
  decisionAllow: boolean;
  iteration: number;
}): Promise<ModeExecutionResult> {
  const idSeed = `${mode}:${caseRow.id}:${iteration}`;

  const connectMs = mode === "stt_pipeline" ? 0 : simulatedDelayMs(`${idSeed}:connect`, 18, 10);
  const inputPrepMs = simulatedDelayMs(`${idSeed}:inputPrep`, mode === "stt_pipeline" ? 45 : 32, 25);
  const inputSendMs = mode === "stt_pipeline" ? 0 : simulatedDelayMs(`${idSeed}:inputSend`, 8, 6);
  const asrMs = mode === "stt_pipeline" ? simulatedDelayMs(`${idSeed}:asr`, 55, 24) : 0;
  const actorMs = decisionAllow ? simulatedDelayMs(`${idSeed}:actor`, 70, 35) : 0;
  const ttsMs = decisionAllow ? simulatedDelayMs(`${idSeed}:tts`, 48, 18) : 0;
  const responseMs = mode === "stt_pipeline" ? 0 : decisionAllow ? simulatedDelayMs(`${idSeed}:response`, 180, 70) : 0;

  await sleepMs(connectMs + inputPrepMs + inputSendMs + asrMs + actorMs + ttsMs + responseMs);

  const transcript = caseRow.userText;
  const responseText =
    decisionAllow
      ? `simulated reply (${mode}): ${caseRow.objective.slice(0, 90)}`
      : "";

  return {
    transcript,
    responseText,
    audioBytes: responseText ? Buffer.byteLength(responseText, "utf8") * 24 : 0,
    stage: {
      connectMs,
      inputPrepMs,
      inputSendMs,
      actorMs,
      asrMs,
      ttsMs,
      outputAsrMs: 0,
      responseMs
    }
  };
}

function validateModeCredentials({
  mode,
  options
}: {
  mode: VoiceGoldenMode;
  options: VoiceGoldenResolvedOptions;
}) {
  const missing: string[] = [];
  if (mode === "stt_pipeline") {
    if (!appConfig.openaiApiKey) missing.push("OPENAI_API_KEY");
  }
  if (mode === "openai_realtime") {
    if (!appConfig.openaiApiKey) missing.push("OPENAI_API_KEY");
  }
  if (mode === "voice_agent") {
    if (!appConfig.xaiApiKey) missing.push("XAI_API_KEY");
    if (options.inputTransport === "audio" && !appConfig.openaiApiKey) {
      missing.push("OPENAI_API_KEY(audio_input)");
    }
  }
  if (mode === "gemini_realtime") {
    if (!appConfig.geminiApiKey) missing.push("GOOGLE_API_KEY");
    if (options.inputTransport === "audio" && !appConfig.openaiApiKey) {
      missing.push("OPENAI_API_KEY(audio_input)");
    }
  }

  return missing;
}

async function runJudge({
  llm,
  judgeSettings,
  mode,
  runMode,
  caseRow,
  decision,
  responseText,
  timings,
  error
}: {
  llm: LLMService;
  judgeSettings: Record<string, unknown>;
  mode: VoiceGoldenMode;
  runMode: VoiceGoldenRunMode;
  caseRow: VoiceGoldenCase;
  decision: DecisionResult;
  responseText: string;
  timings: StageTimings;
  error: string | null;
}): Promise<JudgeResult> {
  const systemPrompt = [
    "You are a strict evaluator for voice chat validation tests.",
    "Return strict JSON only.",
    "Score whether the observed behavior matches expected admission and response quality."
  ].join("\n");

  const userPrompt = [
    `Run mode: ${runMode}`,
    `Voice mode: ${mode}`,
    `Case: ${caseRow.id} (${caseRow.title})`,
    `User utterance: ${caseRow.userText}`,
    `Expectation shouldAllow: ${caseRow.expectedAllow ? "true" : "false"}`,
    `Case objective: ${caseRow.objective}`,
    `Observed decision.allow: ${decision.allow ? "true" : "false"}`,
    `Observed decision.reason: ${decision.reason}`,
    `Observed response text: ${responseText || "(empty)"}`,
    `Observed error: ${error || "(none)"}`,
    `Timings totalMs=${timings.totalMs.toFixed(1)} decisionMs=${timings.decisionMs.toFixed(1)} responseMs=${timings.responseMs.toFixed(1)}`,
    "Scoring rules:",
    "1) A failing admission expectation is a hard fail.",
    "2) If shouldAllow=true, response should be non-empty and reasonably aligned with objective.",
    "3) If shouldAllow=false, empty response is expected.",
    'Output schema: {"pass":true|false,"score":0..100,"confidence":0..1,"summary":"...","issues":["..."]}'
  ].join("\n");

  const generation = await llm.generate({
    settings: judgeSettings,
    systemPrompt,
    userPrompt,
    trace: {
      guildId: "voice-golden-guild",
      channelId: "voice-golden-text",
      userId: "judge",
      source: "voice_golden_judge",
      event: "judge_case",
      reason: null,
      messageId: null
    }
  });

  const parsed = parseJsonObjectFromText(String(generation.text || ""));
  if (!parsed) {
    const deterministicPass =
      decision.allow === caseRow.expectedAllow &&
      (caseRow.expectedAllow ? Boolean(responseText.trim()) : !responseText.trim());
    return {
      pass: deterministicPass,
      score: deterministicPass ? 75 : 25,
      confidence: 0.2,
      summary: "judge_output_parse_failed",
      issues: ["judge returned non-JSON output"],
      rawText: String(generation.text || "")
    };
  }

  const issues = Array.isArray(parsed.issues)
    ? parsed.issues.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8)
    : [];

  return {
    pass: Boolean(parsed.pass),
    score: Math.max(0, Math.min(100, Math.floor(stableNumber(parsed.score, 0)))),
    confidence: Math.max(0, Math.min(1, stableNumber(parsed.confidence, 0))),
    summary: String(parsed.summary || "").trim(),
    issues,
    rawText: String(generation.text || "")
  };
}

function buildDeterministicJudge({
  caseRow,
  decision,
  responseText,
  error
}: {
  caseRow: VoiceGoldenCase;
  decision: DecisionResult;
  responseText: string;
  error: string | null;
}): JudgeResult {
  const admissionMatches = decision.allow === caseRow.expectedAllow;
  const responseMatches = caseRow.expectedAllow ? Boolean(responseText.trim()) : !responseText.trim();
  const pass = admissionMatches && responseMatches && !error;
  const issues: string[] = [];
  if (!admissionMatches) issues.push("admission_mismatch");
  if (!responseMatches) issues.push("response_mismatch");
  if (error) issues.push("runtime_error");

  return {
    pass,
    score: pass ? 100 : 20,
    confidence: 1,
    summary: pass ? "deterministic_pass" : "deterministic_fail",
    issues,
    rawText: ""
  };
}

function buildEmptyTimings(decisionMs = 0): StageTimings {
  return {
    totalMs: decisionMs,
    decisionMs,
    connectMs: 0,
    inputPrepMs: 0,
    inputSendMs: 0,
    actorMs: 0,
    asrMs: 0,
    ttsMs: 0,
    outputAsrMs: 0,
    responseMs: 0
  };
}

async function runSingleCase({
  options,
  llm,
  judgeSettings,
  mode,
  settings,
  manager,
  caseRow,
  iteration
}: {
  options: VoiceGoldenResolvedOptions;
  llm: LLMService | null;
  judgeSettings: Record<string, unknown> | null;
  mode: VoiceGoldenMode;
  settings: Record<string, unknown>;
  manager: VoiceSessionManager;
  caseRow: VoiceGoldenCase;
  iteration: number;
}): Promise<VoiceGoldenCaseResult> {
  const startedAt = performance.now();

  let errorText: string | null = null;
  let transcript = "";
  let responseText = "";
  let audioBytes = 0;
  let decisionData: DecisionResult = {
    allow: false,
    reason: "",
    directAddressed: false,
    transcript: "",
    llmProvider: "",
    llmModel: "",
    llmResponse: "",
    error: ""
  };
  let timings = buildEmptyTimings(0);

  try {
    const decisionResult = await evaluateDecision({
      manager,
      settings,
      mode,
      transcript: caseRow.userText
    });
    decisionData = decisionResult.decision;
    timings = buildEmptyTimings(decisionResult.decisionMs);

    if (!decisionData.allow) {
      transcript = decisionData.transcript || caseRow.userText;
    } else if (options.mode === "simulated") {
      const simulated = await runSimulatedCase({
        mode,
        caseRow,
        decisionAllow: true,
        iteration
      });
      transcript = simulated.transcript;
      responseText = simulated.responseText;
      audioBytes = simulated.audioBytes;
      timings = {
        totalMs: 0,
        decisionMs: decisionResult.decisionMs,
        ...simulated.stage
      };
    } else {
      if (!llm) {
        throw new Error("Live mode requires an initialized LLM service.");
      }
      const liveResult =
        mode === "stt_pipeline"
          ? await runLiveSttPipelineCase({
              llm,
              manager,
              settings,
              caseRow
            })
          : await runLiveRealtimeCase({
              llm,
              manager,
              settings,
              mode,
              caseRow,
              inputTransport: options.inputTransport,
              timeoutMs: options.timeoutMs
            });

      transcript = liveResult.transcript || decisionData.transcript || caseRow.userText;
      responseText = liveResult.responseText;
      audioBytes = liveResult.audioBytes;
      timings = {
        totalMs: 0,
        decisionMs: decisionResult.decisionMs,
        ...liveResult.stage
      };
    }
  } catch (error) {
    errorText = String((error as Error)?.message || error || "unknown_error");
  }

  timings.totalMs = Math.max(0, performance.now() - startedAt);

  let judge: JudgeResult;
  if (options.judge.enabled && llm && judgeSettings) {
    try {
      judge = await runJudge({
        llm,
        judgeSettings,
        mode,
        runMode: options.mode,
        caseRow,
        decision: decisionData,
        responseText,
        timings,
        error: errorText
      });
    } catch (error) {
      judge = {
        pass: false,
        score: 0,
        confidence: 0,
        summary: "judge_error",
        issues: [String((error as Error)?.message || error || "unknown judge error")],
        rawText: ""
      };
    }
  } else {
    judge = buildDeterministicJudge({
      caseRow,
      decision: decisionData,
      responseText,
      error: errorText
    });
  }

  return {
    mode,
    caseId: caseRow.id,
    caseTitle: caseRow.title,
    iteration,
    expectedAllow: caseRow.expectedAllow,
    decision: decisionData,
    transcript,
    responseText,
    audioBytes,
    timings,
    pass: Boolean(judge.pass) && !errorText,
    judge,
    error: errorText
  };
}

function aggregateModeReport(mode: VoiceGoldenMode, skippedReason: string | null, results: VoiceGoldenCaseResult[]): VoiceGoldenModeReport {
  const executed = results.length;
  const passed = results.filter((row) => row.pass).length;
  const failed = executed - passed;

  return {
    mode,
    skippedReason,
    results,
    aggregates: {
      executed,
      passed,
      failed,
      passRate: stablePassRate(passed, executed),
      stageStats: buildStageStats(results)
    }
  };
}

export async function runVoiceGoldenHarness(inputOptions: VoiceGoldenHarnessOptions = {}): Promise<VoiceGoldenHarnessReport> {
  const options = resolveDefaults(inputOptions);
  const startedAtIso = new Date().toISOString();

  const llm = options.mode === "live" || options.judge.enabled
    ? new LLMService({
        appConfig,
        store: new HarnessStore()
      })
    : null;

  const judgeSettings = options.judge.enabled ? buildJudgeSettings(options.judge) : null;

  const cases = VOICE_GOLDEN_CASES.slice(0, options.maxCases);
  const modeReports: VoiceGoldenModeReport[] = [];

  for (const mode of options.modes) {
    if (options.mode === "live") {
      const missing = validateModeCredentials({ mode, options });
      if (missing.length) {
        if (options.allowMissingCredentials) {
          modeReports.push(aggregateModeReport(mode, `missing_credentials:${missing.join(",")}`, []));
          continue;
        }
        throw new Error(`Missing credentials for mode \"${mode}\": ${missing.join(", ")}`);
      }
    }

    const settings = buildHarnessSettings({
      voiceMode: mode,
      actorProvider: options.actorProvider,
      actorModel: options.actorModel,
      deciderProvider: options.deciderProvider,
      deciderModel: options.deciderModel
    });

    const decisionRuntime = createDecisionRuntime(
      options.mode === "live" && llm
        ? llm
        : buildSimulatedDecisionLlm()
    );

    const results: VoiceGoldenCaseResult[] = [];
    for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
      for (const caseRow of cases) {
        const row = await runSingleCase({
          options,
          llm,
          judgeSettings,
          mode,
          settings,
          manager: decisionRuntime.manager,
          caseRow,
          iteration
        });
        results.push(row);
      }
    }

    modeReports.push(aggregateModeReport(mode, null, results));
    await decisionRuntime.manager.dispose("voice_golden_harness_done").catch(() => undefined);
  }

  const allResults = modeReports.flatMap((report) => report.results);
  const passed = allResults.filter((row) => row.pass).length;
  const executed = allResults.length;
  const failed = executed - passed;

  return {
    startedAt: startedAtIso,
    finishedAt: new Date().toISOString(),
    options,
    modeReports,
    summary: {
      executed,
      passed,
      failed,
      passRate: stablePassRate(passed, executed),
      stageStats: buildStageStats(allResults)
    }
  };
}

export function printVoiceGoldenHarnessReport(report: VoiceGoldenHarnessReport) {
  console.log("Voice Golden Validation Harness");
  console.log(`startedAt=${report.startedAt}`);
  console.log(`finishedAt=${report.finishedAt}`);
  console.log(`mode=${report.options.mode}`);
  console.log(`modes=[${report.options.modes.join(", ")}]`);
  console.log(`iterations=${report.options.iterations}`);
  console.log(`judge=${report.options.judge.enabled ? "on" : "off"}`);
  console.log(`inputTransport=${report.options.inputTransport}`);
  console.log("");

  for (const modeReport of report.modeReports) {
    if (modeReport.skippedReason) {
      console.log(`mode=${modeReport.mode} skipped (${modeReport.skippedReason})`);
      continue;
    }

    console.log(
      `mode=${modeReport.mode} executed=${modeReport.aggregates.executed} pass=${modeReport.aggregates.passed} fail=${modeReport.aggregates.failed} passRate=${modeReport.aggregates.passRate.toFixed(1)}%`
    );
    const totalMs = modeReport.aggregates.stageStats.totalMs;
    const decisionMs = modeReport.aggregates.stageStats.decisionMs;
    const responseMs = modeReport.aggregates.stageStats.responseMs;
    if (totalMs) {
      console.log(
        `  totalMs p50=${totalMs.p50Ms.toFixed(1)} p95=${totalMs.p95Ms.toFixed(1)} avg=${totalMs.avgMs.toFixed(1)}`
      );
    }
    if (decisionMs) {
      console.log(
        `  decisionMs p50=${decisionMs.p50Ms.toFixed(1)} p95=${decisionMs.p95Ms.toFixed(1)} avg=${decisionMs.avgMs.toFixed(1)}`
      );
    }
    if (responseMs) {
      console.log(
        `  responseMs p50=${responseMs.p50Ms.toFixed(1)} p95=${responseMs.p95Ms.toFixed(1)} avg=${responseMs.avgMs.toFixed(1)}`
      );
    }

    const failedRows = modeReport.results.filter((row) => !row.pass).slice(0, 6);
    for (const row of failedRows) {
      console.log(
        `  fail case=${row.caseId} iter=${row.iteration} reason=${row.decision.reason || row.error || row.judge.summary}`
      );
      if (row.judge.issues.length) {
        console.log(`    issues=${row.judge.issues.join(" | ")}`);
      }
    }
  }

  console.log("");
  console.log(
    `summary executed=${report.summary.executed} pass=${report.summary.passed} fail=${report.summary.failed} passRate=${report.summary.passRate.toFixed(1)}%`
  );
}
