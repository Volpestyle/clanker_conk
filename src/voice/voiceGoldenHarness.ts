import { performance } from "node:perf_hooks";
import { appConfig } from "../config.ts";
import { LLMService } from "../llm.ts";
import { ClankerBot } from "../bot.ts";
import { DEFAULT_SETTINGS } from "../settings/settingsSchema.ts";
import { normalizeSettings } from "../store/settingsNormalization.ts";
import { parseBooleanFlag } from "../normalization/valueParsers.ts";
import { WebSearchService } from "../search.ts";
import { runJsonJudge } from "../../scripts/replay/core/judge.ts";
import { summarizeNamedMetricRows, type NumericStats } from "../../scripts/replay/core/metrics.ts";
import { formatPct, stableNumber } from "../../scripts/replay/core/utils.ts";
import { VoiceSessionManager } from "./voiceSessionManager.ts";
import { VOICE_RUNTIME_MODES, parseVoiceRuntimeMode } from "./voiceModes.ts";

export const VOICE_GOLDEN_MODES = VOICE_RUNTIME_MODES;

type VoiceGoldenMode = (typeof VOICE_GOLDEN_MODES)[number];
type VoiceGoldenRunMode = "simulated" | "live";

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

type VoiceGoldenHarnessOptions = {
  mode?: VoiceGoldenRunMode;
  modes?: VoiceGoldenMode[];
  iterations?: number;
  actorProvider?: string;
  actorModel?: string;
  deciderProvider?: string;
  deciderModel?: string;
  judge?: Partial<VoiceGoldenJudgeConfig>;
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

type VoiceGoldenCaseResult = {
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

type VoiceGoldenModeReport = {
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

type StageStat = NumericStats;

type VoiceGoldenHarnessReport = {
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
  createdAt?: string;
};

class HarnessStore {
  actions: HarnessStoreAction[];

  constructor() {
    this.actions = [];
  }

  logAction(action: HarnessStoreAction) {
    this.actions.push({
      ...(action || {}),
      createdAt:
        String(action?.createdAt || "").trim() || new Date().toISOString()
    });
  }

  getSettings() {
    return {
      botName: "clanker conk"
    };
  }

  countActionsSince(kind: string, sinceIso: string) {
    const targetKind = String(kind || "").trim();
    const sinceAt = Date.parse(String(sinceIso || ""));
    if (!targetKind || !Number.isFinite(sinceAt)) return 0;

    let count = 0;
    for (const action of this.actions) {
      if (String(action?.kind || "") !== targetKind) continue;
      const createdAt = Date.parse(String(action?.createdAt || ""));
      if (!Number.isFinite(createdAt)) continue;
      if (createdAt >= sinceAt) count += 1;
    }
    return count;
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
  },
  {
    id: "fresh-fact-check",
    title: "Fresh Fact Check",
    userText: "clanker what's the latest rust stable version right now?",
    expectedAllow: true,
    objective: "Use a web lookup if needed for freshness, then answer in one short line."
  }
];

const DEFAULT_MAX_CASES = VOICE_GOLDEN_CASES.length;

function parseBool(value: unknown, fallback = false) {
  return parseBooleanFlag(value, fallback);
}

function normalizeMode(value: unknown): VoiceGoldenRunMode {
  return String(value || "simulated").trim().toLowerCase() === "live" ? "live" : "simulated";
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
  return parseVoiceRuntimeMode(value);
}

function resolveDefaults(options: VoiceGoldenHarnessOptions = {}): VoiceGoldenResolvedOptions {
  const requestedModes = normalizeVoiceModeList(options.modes);
  return {
    mode: normalizeMode(options.mode),
    modes: requestedModes.length ? requestedModes : [...VOICE_GOLDEN_MODES],
    iterations: Math.max(1, Math.floor(Number(options.iterations) || 1)),
    actorProvider: String(options.actorProvider || "anthropic").trim() || "anthropic",
    actorModel: String(options.actorModel || "claude-sonnet-4-5").trim() || "claude-sonnet-4-5",
    deciderProvider: String(options.deciderProvider || "anthropic").trim() || "anthropic",
    deciderModel: String(options.deciderModel || "claude-haiku-4-5").trim() || "claude-haiku-4-5",
    judge: {
      enabled:
        options.judge?.enabled !== undefined
          ? Boolean(options.judge.enabled)
          : true,
      provider: String(options.judge?.provider || "anthropic").trim() || "anthropic",
      model: String(options.judge?.model || "claude-haiku-4-5").trim() || "claude-haiku-4-5"
    },
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
      enabled: true,
      maxSearchesPerHour: 12
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
      realtimeReplyStrategy: "brain",
      replyEagerness: 65,
      generationLlm: {
        provider: actorProvider,
        model: actorModel
      },
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

function buildStageStats(rows: VoiceGoldenCaseResult[]): Record<string, StageStat> {
  return summarizeNamedMetricRows(rows.map((row) => ({ ...row.timings })));
}

function stablePassRate(passed: number, executed: number) {
  return formatPct(passed, executed);
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

function createLiveExecutionRuntime({
  llm,
  search,
  store
}: {
  llm: LLMService;
  search: WebSearchService;
  store: HarnessStore;
}) {
  const bot = new ClankerBot({
    appConfig: {
      ...appConfig,
      disableSimulatedTypingDelay: true
    },
    store,
    llm,
    memory: null,
    discovery: null,
    search,
    gifs: null,
    video: null
  });

  bot.client.user = {
    id: "bot-user",
    username: "clanker conk",
    tag: "clanker conk#0001"
  };

  const manager = bot.voiceSessionManager;
  manager.countHumanVoiceParticipants = () => 2;
  manager.getVoiceChannelParticipants = () => [
    { userId: "speaker-1", displayName: "alice" },
    { userId: "speaker-2", displayName: "bob" }
  ];

  return {
    bot,
    manager
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

function buildExecutionSession(mode: VoiceGoldenMode) {
  const now = Date.now();
  const session = {
    id: `voice-golden-exec-${mode}-${now}-${Math.floor(Math.random() * 1_000_000)}`,
    guildId: "voice-golden-guild",
    textChannelId: "voice-golden-text",
    voiceChannelId: "voice-golden-voice",
    mode,
    ending: false,
    botTurnOpen: false,
    startedAt: now - 12_000,
    lastActivityAt: now,
    userCaptures: new Map(),
    recentVoiceTurns: [],
    pendingDeferredTurns: [],
    soundboard: {
      playCount: 0,
      lastPlayedAt: 0
    },
    streamWatch: {
      active: false
    },
    voiceLookupBusyCount: 0,
    lastVoiceLookupBusyAnnouncementAt: 0
  } as Record<string, unknown>;

  if (mode === "openai_realtime") {
    session.realtimeClient = {
      updateInstructions() {
        return undefined;
      }
    };
  }

  return session;
}

function latestVoiceReplyFromActions({
  mode,
  actions
}: {
  mode: VoiceGoldenMode;
  actions: HarnessStoreAction[];
}) {
  if (mode === "stt_pipeline") {
    const spoken = [...actions]
      .reverse()
      .find((row) => row.kind === "voice_runtime" && row.content === "stt_pipeline_reply_spoken");
    if (spoken) {
      return String(spoken.metadata?.replyText || "").trim();
    }
    return "";
  }

  const requested = [...actions]
    .reverse()
    .find((row) => row.kind === "voice_runtime" && row.content === "realtime_reply_requested");
  if (requested) {
    return String(requested.metadata?.replyText || "").trim();
  }
  return "";
}

async function runLiveProductionCase({
  manager,
  store,
  settings,
  mode,
  caseRow,
  directAddressed
}: {
  manager: VoiceSessionManager;
  store: HarnessStore;
  settings: Record<string, unknown>;
  mode: VoiceGoldenMode;
  caseRow: VoiceGoldenCase;
  directAddressed: boolean;
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
  const session = buildExecutionSession(mode);
  const actionStart = store.actions.length;
  const responseStartedAt = performance.now();
  const originalSpeakVoiceLineWithTts = manager.speakVoiceLineWithTts.bind(manager);

  manager.speakVoiceLineWithTts = async ({ session: activeSession }) => {
    if (activeSession && typeof activeSession === "object") {
      (activeSession as { lastAudioDeltaAt?: number }).lastAudioDeltaAt = Date.now();
    }
    return true;
  };

  try {
    if (mode === "stt_pipeline") {
      await manager.runSttPipelineReply({
        session,
        settings,
        userId: "speaker-1",
        transcript: caseRow.userText,
        directAddressed
      });
    } else {
      await manager.runRealtimeBrainReply({
        session,
        settings,
        userId: "speaker-1",
        transcript: caseRow.userText,
        directAddressed,
        source: "voice_golden_production"
      });
    }
  } finally {
    manager.speakVoiceLineWithTts = originalSpeakVoiceLineWithTts;
  }

  stage.responseMs = performance.now() - responseStartedAt;
  stage.actorMs = stage.responseMs;
  const actionDelta = store.actions.slice(actionStart);
  const responseText = latestVoiceReplyFromActions({
    mode,
    actions: actionDelta
  });

  return {
    transcript: caseRow.userText,
    responseText,
    audioBytes: responseText ? Buffer.byteLength(responseText, "utf8") * 24 : 0,
    stage
  };
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

function hasProviderCredentials(provider: string) {
  const normalized = String(provider || "")
    .trim()
    .toLowerCase();
  if (normalized === "openai") return Boolean(appConfig.openaiApiKey);
  if (normalized === "anthropic") return Boolean(appConfig.anthropicApiKey);
  if (normalized === "xai") return Boolean(appConfig.xaiApiKey);
  if (normalized === "claude-code") return true;
  return false;
}

function validateHarnessCredentials(options: VoiceGoldenResolvedOptions) {
  const required = [
    ...(options.mode === "live"
      ? [
          { role: "actor", provider: options.actorProvider },
          { role: "decider", provider: options.deciderProvider }
        ]
      : []),
    ...(options.judge.enabled ? [{ role: "judge", provider: options.judge.provider }] : [])
  ];
  const missing = new Set<string>();

  for (const item of required) {
    const provider = String(item.provider || "").trim().toLowerCase();
    if (!provider) continue;
    if (hasProviderCredentials(provider)) continue;
    missing.add(`${item.role}:${provider}`);
  }

  return [...missing];
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

  return await runJsonJudge<JudgeResult>({
    llm,
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
    },
    onParsed: (parsed, rawText) => {
      const issues = Array.isArray(parsed.issues)
        ? parsed.issues.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8)
        : [];

      return {
        pass: Boolean(parsed.pass),
        score: Math.max(0, Math.min(100, Math.floor(stableNumber(parsed.score, 0)))),
        confidence: Math.max(0, Math.min(1, stableNumber(parsed.confidence, 0))),
        summary: String(parsed.summary || "").trim(),
        issues,
        rawText
      };
    },
    onParseError: (rawText) => {
      const deterministicPass =
        decision.allow === caseRow.expectedAllow &&
        (caseRow.expectedAllow ? Boolean(responseText.trim()) : !responseText.trim());
      return {
        pass: deterministicPass,
        score: deterministicPass ? 75 : 25,
        confidence: 0.2,
        summary: "judge_output_parse_failed",
        issues: ["judge returned non-JSON output"],
        rawText
      };
    }
  });
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
  executionStore,
  caseRow,
  iteration
}: {
  options: VoiceGoldenResolvedOptions;
  llm: LLMService | null;
  judgeSettings: Record<string, unknown> | null;
  mode: VoiceGoldenMode;
  settings: Record<string, unknown>;
  manager: VoiceSessionManager;
  executionStore: HarnessStore;
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
      const liveResult = await runLiveProductionCase({
        manager,
        store: executionStore,
        settings,
        mode,
        caseRow,
        directAddressed: Boolean(decisionData.directAddressed)
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

  const judgeSettings = options.judge.enabled ? buildJudgeSettings(options.judge) : null;
  const missing = validateHarnessCredentials(options);
  if (missing.length) {
    if (!options.allowMissingCredentials) {
      throw new Error(`Missing credentials: ${missing.join(", ")}`);
    }
    const modeReports = options.modes.map((mode) =>
      aggregateModeReport(mode, `missing_credentials:${missing.join(",")}`, [])
    );
    return {
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      options,
      modeReports,
      summary: {
        executed: 0,
        passed: 0,
        failed: 0,
        passRate: 0,
        stageStats: {}
      }
    };
  }
  const cases = VOICE_GOLDEN_CASES.slice(0, options.maxCases);
  const modeReports: VoiceGoldenModeReport[] = [];

  for (const mode of options.modes) {
    const settings = buildHarnessSettings({
      voiceMode: mode,
      actorProvider: options.actorProvider,
      actorModel: options.actorModel,
      deciderProvider: options.deciderProvider,
      deciderModel: options.deciderModel
    });

    let manager: VoiceSessionManager;
    let executionStore: HarnessStore;
    let llm: LLMService | null = null;

    if (options.mode === "live") {
      executionStore = new HarnessStore();
      llm = new LLMService({
        appConfig,
        store: executionStore
      });
      const search = new WebSearchService({
        appConfig,
        store: executionStore
      });
      const runtime = createLiveExecutionRuntime({
        llm,
        search,
        store: executionStore
      });
      manager = runtime.manager;
    } else {
      const runtime = createDecisionRuntime(buildSimulatedDecisionLlm());
      manager = runtime.manager;
      executionStore = runtime.store;
      if (options.judge.enabled) {
        llm = new LLMService({
          appConfig,
          store: new HarnessStore()
        });
      }
    }

    const results: VoiceGoldenCaseResult[] = [];
    for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
      for (const caseRow of cases) {
        const row = await runSingleCase({
          options,
          llm,
          judgeSettings,
          mode,
          settings,
          manager,
          executionStore,
          caseRow,
          iteration
        });
        results.push(row);
      }
    }

    modeReports.push(aggregateModeReport(mode, null, results));
    await manager.dispose("voice_golden_harness_done").catch(() => undefined);
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
