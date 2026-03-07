/**
 * Archived live classifier harness.
 *
 * This is kept as a historical prompt-only lab. Active shared-coverage suites:
 * - tests/live/voiceAdmission.live.test.ts
 * - tests/live/replyGeneration.live.test.ts
 *
 * Live classifier tests — calls an LLM for real to validate prompt strategy.
 *
 * Providers (set CLASSIFIER_PROVIDER env):
 *   "anthropic" (default) — uses Anthropic API directly (requires ANTHROPIC_API_KEY)
 *   "claude-code"         — uses the `claude` CLI (free with Claude Code subscription)
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... bun test tests/live/archive/voiceClassifier.live.archived.ts
 *   CLASSIFIER_PROVIDER=claude-code bun test tests/live/archive/voiceClassifier.live.archived.ts
 *
 * Optional: LABEL_FILTER=music to run a subset.
 */
import { beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { parseBooleanFlag } from "../../src/normalization/valueParsers.ts";
import { buildClassifierPrompt } from "../../src/voice/voiceReplyDecision.ts";
import {
  runClaudeCli,
  buildClaudeCodeTextCliArgs
} from "../../src/llm/llmClaudeCode.ts";

const CLASSIFIER_PROVIDER = (process.env.CLASSIFIER_PROVIDER || "anthropic").trim().toLowerCase();
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.CLASSIFIER_MODEL || "claude-haiku-4-5";

let client: Anthropic | null = null;
const LABEL_FILTER = (process.env.LABEL_FILTER || "").trim().toLowerCase();
const LIVE_DEBUG = parseBooleanFlag(process.env.VOICE_CLASSIFIER_DEBUG, false);

beforeAll(() => {
  if (CLASSIFIER_PROVIDER === "anthropic") {
    if (!ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is required when using anthropic provider");
    }
    client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  } else if (CLASSIFIER_PROVIDER === "claude-code") {
    delete process.env.CLAUDECODE;
  }
});

type ClassifierScenario = {
  label: string;
  inputKind?: "transcript" | "event";
  botName?: string;
  eagerness?: number;
  participants: string[];
  speaker?: string;
  transcript: string;
  recentAssistantReply?: boolean;
  msSinceAssistantReply?: number | null;
  msSinceDirectAddress?: number | null;
  musicActive?: boolean;
  musicWakeLatched?: boolean;
  msUntilMusicWakeLatchExpiry?: number | null;
  timeline?: string[];
  expected: "YES" | "NO";
};

type ScenarioGroup = {
  label: string;
  scenarios: ClassifierScenario[];
};

type ScenarioOverrides = Partial<Omit<ClassifierScenario, "label" | "transcript" | "expected">>;

function turns(...entries: string[]): string[] {
  return entries;
}

/**
 * Shorthand builder — infers defaults from context:
 * - participantCount derived from participants array
 * - speaker defaults to first participant
 * - For events: transcript defaults to "[{speaker} joined the voice channel]"
 */
function scenario(
  label: string,
  transcript: string,
  expected: "YES" | "NO",
  overrides?: ScenarioOverrides
): ClassifierScenario {
  const participants = overrides?.participants ?? ["vuhlp"];
  const isEvent = overrides?.inputKind === "event";
  const speaker = overrides?.speaker ?? (isEvent ? "YOU" : participants[0]);
  return {
    label,
    transcript: transcript || (isEvent ? `[${speaker} joined the voice channel]` : ""),
    expected,
    participants,
    speaker,
    ...overrides,
  };
}

function eventScenario(
  label: string,
  expected: "YES" | "NO",
  overrides?: ScenarioOverrides
): ClassifierScenario {
  return scenario(label, "", expected, {
    inputKind: "event",
    ...overrides,
  });
}

function group(label: string, scenarios: ClassifierScenario[]): ScenarioGroup {
  return { label, scenarios };
}

/**
 * Generate scenarios across eagerness levels, splitting at a threshold.
 * Levels at or above `threshold` expect YES; below expect NO.
 */
function eagernessSweep(
  labelTemplate: string,
  base: Omit<ClassifierScenario, "label" | "eagerness" | "expected">,
  threshold: number,
  levels = [10, 20, 30, 50, 70, 90]
): ClassifierScenario[] {
  return levels.map((e) => ({
    ...base,
    label: labelTemplate.replace("{e}", String(e)),
    eagerness: e,
    expected: (e >= threshold ? "YES" : "NO") as "YES" | "NO",
  }));
}

function parseDecision(raw: string): "YES" | "NO" {
  const normalized = String(raw || "")
    .replace(/[`*_~]/g, "")
    .trim()
    .toUpperCase();

  if (/^(YES|ALLOW)\b/u.test(normalized)) return "YES";
  if (/^(NO|DENY)\b/u.test(normalized)) return "NO";

  throw new Error(`Classifier returned unexpected output: "${raw}"`);
}

function matchesLabelFilter(label: string): boolean {
  return !LABEL_FILTER || label.toLowerCase().includes(LABEL_FILTER);
}

function logLiveClassifierDebug({
  label,
  stage,
  systemPrompt = null,
  userPrompt = null,
  raw = null,
  decision = null
}: {
  label: string;
  stage: "prompt" | "result";
  systemPrompt?: string | null;
  userPrompt?: string | null;
  raw?: string | null;
  decision?: "YES" | "NO" | null;
}) {
  if (!LIVE_DEBUG) return;
  const lines = [`[voiceClassifier.live] ${label} stage=${stage}`];
  if (systemPrompt) {
    lines.push("System prompt:");
    lines.push(systemPrompt);
  }
  if (userPrompt) {
    lines.push("User prompt:");
    lines.push(userPrompt);
  }
  if (raw != null) {
    lines.push(`Raw output: ${raw}`);
  }
  if (decision != null) {
    lines.push(`Parsed decision: ${decision}`);
  }
  console.error(lines.join("\n"));
}

async function runClassifier(scenario: ClassifierScenario): Promise<{ decision: "YES" | "NO"; raw: string }> {
  const { systemPrompt, userPrompt } = buildClassifierPrompt({
    botName: scenario.botName || "clanker conk",
    inputKind: scenario.inputKind || "transcript",
    replyEagerness: scenario.eagerness ?? 50,
    participantCount: scenario.participants.length,
    participantList: scenario.participants,
    speakerName: scenario.speaker ?? scenario.participants[0],
    transcript: scenario.transcript,
    musicActive: scenario.musicActive,
    musicWakeLatched: scenario.musicWakeLatched,
    msUntilMusicWakeLatchExpiry: scenario.msUntilMusicWakeLatchExpiry,
    conversationContext: {
      recentAssistantReply: scenario.recentAssistantReply,
      msSinceAssistantReply: scenario.msSinceAssistantReply,
      msSinceDirectAddress: scenario.msSinceDirectAddress
    },
    recentHistory: scenario.timeline?.length ? scenario.timeline.join("\n") : undefined
  });
  logLiveClassifierDebug({
    label: scenario.label,
    stage: "prompt",
    systemPrompt,
    userPrompt
  });

  let raw: string;

  if (CLASSIFIER_PROVIDER === "claude-code") {
    const args = buildClaudeCodeTextCliArgs({
      model: MODEL,
      systemPrompt,
      prompt: userPrompt
    });
    const { stdout } = await runClaudeCli({
      args,
      input: "",
      timeoutMs: 30_000,
      maxBufferBytes: 1024 * 1024
    });
    raw = String(stdout || "").trim();
  } else {
    const result = await client!.messages.create({
      model: MODEL,
      max_tokens: 4,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }]
    });
    raw = result.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
  }
  const decision = parseDecision(raw);
  logLiveClassifierDebug({
    label: scenario.label,
    stage: "result",
    raw,
    decision
  });
  return { decision, raw };
}

const scenarioGroups: ScenarioGroup[] = [
  group("join events", [
    ...eagernessSweep(
      "event: bot joins a 1:1 room @ eagerness {e}",
      {
        inputKind: "event",
        timeline: turns("[vuhlp joined the voice channel]"),
      },
      10,
      [10, 25, 50]
    ),
    ...eagernessSweep(
      "event: bot joins a busy call @ eagerness {e}",
      {
        inputKind: "event",
        participants: ["vuhlp", "jake"],
        timeline: turns("vuhlp: i got mad aura", "jake: yea thats wild", "vuhlp: I wish I had some ice cream"),
      },
      25,
      [10, 25, 50]
    ),
    ...eagernessSweep(
      "event: another person joins busy room mid-conversation @ eagerness {e}",
      {
        inputKind: "event",
        participants: ["alice", "bob", "carol"],
        speaker: "carol",
        timeline: turns('alice: "we should order food"', 'bob: "yeah maybe tacos"'),
      },
      50,
      [10, 25, 50]
    ),
  ]),

  group("clear engagement", [
    ...eagernessSweep(
      "fuzzy matching name @ eagerness {e}",
      {
        transcript: "Hi Clayton",
        participants: ["poopy", "jake"],
        recentAssistantReply: true,
        msSinceAssistantReply: 4000,
        timeline: turns('poopy: "Whos that?"'),
      },
      10,
      [10, 25, 50]
    ),
    ...eagernessSweep(
      "fuzzy matching name pt 2 @ eagerness {e}",
      {
        transcript: "Oh my god its clunky",
        participants: ["poopy", "jake"],
        recentAssistantReply: true,
        msSinceAssistantReply: 4000,
        timeline: turns('poopy: "Oh my"'),
      },
      10,
      [10, 25, 50]
    ),


    ...eagernessSweep(
      "direct follow up to bot after vague reply @ eagerness {e}",
      {
        participants: ["poopy", "jake"],
        transcript: "you always talkin bout chaos man",
        recentAssistantReply: true,
        msSinceAssistantReply: 7000,
        timeline: turns('poopy: "How you doing big bro?', 'YOU: "Im just vibing in the chaos right now"'),
      },
      25,
      [10, 25, 50],
    ),

    // Garbled wake-word variants belong in the runtime admission tests so they
    // exercise upstream name-cue handling before the classifier prompt is built.
    ...eagernessSweep(
      "1:1 question to the bot @ eagerness {e}",
      {
        transcript: "What's the weather like in New York?",
        participants: ["vuhlp", "jake"],
        recentAssistantReply: true,
        msSinceAssistantReply: 10000,
        timeline: turns('YOU: "hey what\'s good"', 'vuhlp: "not much"', 'YOU: "cool cool"'),
      },
      25,
      [10, 25, 50]
    ),
    ...eagernessSweep(
      "recent direct address, same speaker clarifies @ eagerness {e}",
      {
        transcript: "wait so Peru is Lima right?",
        participants: ["vuhlp", "jake"],
        speaker: "vuhlp",
        recentAssistantReply: false,
        msSinceDirectAddress: 4000,
        timeline: turns(
          'vuhlp: "clanker conk what\'s the capital of Peru?"',
          'jake: "pretty sure it\'s Lima"',
        ),
      },
      25,
      [10, 25, 50]
    ),
    ...eagernessSweep(
      "web search request, no recent assistant reply @ eagerness {e}",
      {
        participants: ["michael", "test"],
        transcript: "Can you look up Nintendo DS prices?",
        recentAssistantReply: false,
      },
      10,
      [10, 25, 50],
    ),
  ]),

  group("contextual engagement", [
    ...eagernessSweep(
      "multi-human subtle question to bot in conversation @ eagerness {e}",
      {
        transcript: "yea idk, dooo AI's like pizza?",
        participants: ["alice", "bob", "carol"],
        recentAssistantReply: true,
        msSinceAssistantReply: 15000,
        msSinceDirectAddress: 15000,
        timeline: turns('alice: "so what should we do for dinner?"', 'bob: "do AIs like pizza?"'),
      },
      25,
      [10, 25, 50]
    ),
    ...eagernessSweep(
      "being naturally helpful in conversation @ eagerness {e}",
      {
        transcript: "How far is it?",
        participants: ["alice", "bob", "carol"],
        recentAssistantReply: true,
        msSinceAssistantReply: 15000,
        msSinceDirectAddress: 15000,
        timeline: turns(
          'alice: "I wish I knew how far away Dallas was from Chicago"',
          'bob: "Yeah, me too"',
        ),
      },
      50,
      [10, 25, 50, 75]
    ),
    ...eagernessSweep(
      "NOT being annoyingly helpful in conversation @ eagerness {e}",
      {
        transcript: "How many are there?",
        participants: ["alice", "bob", "carol"],
        recentAssistantReply: true,
        msSinceAssistantReply: 15000,
        msSinceDirectAddress: 15000,
        timeline: turns(
          'alice: "How do I win Super mario?"',
          'bob: "you get all the stars."',
        ),
      },
      75,
      [10, 25, 50, 75]
    ),
    ...eagernessSweep(
      "playing music in conversation @ eagerness {e}",
      {
        transcript: "Clank play Sicko Mode",
        participants: ["alice", "bob", "carol"],
        speaker: "bob",
        recentAssistantReply: true,
        msSinceAssistantReply: 15000,
        msSinceDirectAddress: 15000,
        timeline: turns('alice: "Tis the season to be jolly"', 'carol: "How many tictacs can u lick lack?"'),
      },
      10,
      [10, 50]
    ),
  ]),

  group("stays quiet", [
    ...eagernessSweep(
      "multi-human side conversation between humans @ eagerness {e}",
      {
        participants: ["alice", "bob", "carol"],
        transcript: "did you see the game last night?",
        timeline: turns("Alice: omg that game was crazy last night", "Bob: yeah it was insane", "Carol: Holy shit"),
      },
      80,
      [10, 25, 50, 75, 80]
    ),
    ...eagernessSweep(
      "stale direct address after the room moved on @ eagerness {e}",
      {
        transcript: "nah, tacos are cheaper",
        participants: ["alice", "bob", "carol"],
        speaker: "carol",
        recentAssistantReply: false,
        msSinceDirectAddress: 45000,
        timeline: turns(
          'alice: "clanker conk what should I order?"',
          'bob: "bro just get tacos"',
          'carol: "yeah tacos are cheaper"',
        ),
      },
      50,
      [25, 50, 75]
    ),
    ...eagernessSweep(
      "filler laughter @ eagerness {e}",
      {
        transcript: "Haha, yea some Braydon like that suppose",
        participants: ["vuhlp", "jake"],
        timeline: turns(
          'jake: "and then he just fell off the chair"',
          'vuhlp: "no way dude"',
          'jake: "yeah bro it was hilarious"',
        ),
      },
      80,
      [25, 50, 75, 80]
    ),
    scenario("backchannel noise", "Mm-hmm.", "NO"),
    scenario("self-talk / thinking out loud", "Wait, where did I put my keys...", "NO"),
    scenario("multi-human addressed to specific other person", "Carol, can you pass me that?", "NO", {
      participants: ["alice", "bob", "carol"],
      speaker: "bob",
    }),
  ]),

  group("music wake latch", [
    scenario("music active, no wake, ambient chatter", "This beat is fire", "NO", {
      participants: ["vuhlp", "jake"],
      musicActive: true,
      musicWakeLatched: false,
    }),
    ...eagernessSweep(
      "music active with wake latch — command should go through @ eagerness {e}",
      {
        transcript: "Skip this song",
        musicActive: true,
        musicWakeLatched: true,
        msUntilMusicWakeLatchExpiry: 9000,
        recentAssistantReply: true,
        msSinceAssistantReply: 5000,
      },
      10,
      [10, 25, 50]
    ),
    ...eagernessSweep(
      "music wake latch carries a lightweight follow-up control @ eagerness {e}",
      {
        transcript: "Turn it up a little",
        participants: ["vuhlp", "jake"],
        musicActive: true,
        musicWakeLatched: true,
        msUntilMusicWakeLatchExpiry: 7000,
        recentAssistantReply: true,
        msSinceAssistantReply: 8000,
        timeline: turns(
          'vuhlp: "clanker conk play sicko mode"',
          'YOU: "playing sicko mode"',
          'jake: "this one is good"',
        ),
      },
      10,
      [10, 25, 50]
    ),
  ]),

  group("eagerness sweeps", [
    ...eagernessSweep(
      "eagerness {e}, follow up conversation",
      {
        participants: ["vuhlp", "jake"],
        speaker: "vuhlp",
        transcript: "yeah but what about game dev?",
        recentAssistantReply: true,
        msSinceAssistantReply: 10000,
        timeline: turns(
          'vuhlp: "clank what do you think about rust?"',
          'YOU: "rust is great for systems programming"',
        ),
      },
      25,
      [10, 25, 50]
    ),
    ...eagernessSweep(
      "eagerness {e}, follow up conversation, old conversation",
      {
        participants: ["vuhlp", "jake"],
        speaker: "vuhlp",
        transcript: "yeah but what about game dev?",
        recentAssistantReply: true,
        msSinceAssistantReply: 20000,
        timeline: turns(
          'vuhlp: "clank what do you think about rust?"',
          'YOU: "rust is great for systems programming"',
        ),
      },
      50,
      [10, 20, 50]
    ),
    ...eagernessSweep(
      "eagerness {e}, volunteer conversation",
      {
        participants: ["vuhlp", "jake"],
        transcript: "I wonder what the best programming language for game dev is",
        recentAssistantReply: true,
        msSinceAssistantReply: 60000,
        timeline: turns(
          'vuhlp: "yo what do you think about rust?"',
          'jake: "rust is great for systems programming"',
          'vuhlp: "yeah but what about game dev?"',
        ),
      },
      50,
      [10, 25, 50]
    ),
    ...eagernessSweep(
      "eagerness {e}, interrupt conversation",
      {
        participants: ["vuhlp", "jake"],
        transcript: "nah you stupid as shi for sayin that",
        recentAssistantReply: true,
        msSinceAssistantReply: 20000,
        timeline: turns(
          'vuhlp: "yo what do you think about rust?"',
          'jake: "rust is great for systems programming"',
        ),
      },
      80,
      [25, 50, 75, 80]
    ),
    ...eagernessSweep(
      "ambient chatter in 1:1 @ eagerness {e}",
      {
        participants: ["vuhlp"],
        transcript: "Man, what a day",
      },
      50,
      [10, 25, 50, 75]
    ),
    ...eagernessSweep(
      "ambient chatter in group @ eagerness {e}",
      {
        participants: ["lucky", "zeal"],
        transcript: "Man, what a day",
      },
      75,
      [10, 25, 50, 75]
    ),
  ]),
];

const TEST_TIMEOUT_MS = CLASSIFIER_PROVIDER === "claude-code" ? 30_000 : 10_000;

describe("voice classifier live tests", () => {
  for (const scenarioGroup of scenarioGroups) {
    const filteredScenarios = scenarioGroup.scenarios.filter((scenario) => matchesLabelFilter(scenario.label));
    if (!filteredScenarios.length) continue;

    describe(scenarioGroup.label, () => {
      for (const scenario of filteredScenarios) {
        test(scenario.label, async () => {
          const { decision, raw } = await runClassifier(scenario);
          assert.equal(
            decision,
            scenario.expected,
            `Expected ${scenario.expected} but got ${decision} (raw: "${raw}") for: ${scenario.label}`
          );
        }, TEST_TIMEOUT_MS);
      }
    });
  }
});
