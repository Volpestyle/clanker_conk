import type { Database } from "bun:sqlite";
import type { LLMService } from "../../../src/llm.ts";

export type HarnessMode = "recorded" | "live";
export type ChannelMode = "initiative" | "non_initiative";

export type ReplayBaseArgs = {
  mode: HarnessMode;
  dbPath: string;
  since: string;
  until: string;
  historyLookbackHours: number;
  channelId: string;
  maxTurns: number;
  snapshotsLimit: number;
  outJsonPath: string;
};

export type MessageRow = {
  message_id: string;
  created_at: string;
  guild_id: string | null;
  channel_id: string;
  author_id: string;
  author_name: string;
  is_bot: number;
  content: string;
  referenced_message_id: string | null;
};

export type ActionRow = {
  id: number;
  created_at: string;
  channel_id: string | null;
  kind: string;
  content: string | null;
  metadata: string | null;
  message_id?: string | null;
};

export type DecisionOutcomeKind =
  | "sent_message"
  | "sent_reply"
  | "reply_skipped"
  | "voice_intent_detected"
  | "no_action";

export type ReplayDecision = {
  kind: DecisionOutcomeKind;
  addressed: boolean;
  attempted: boolean;
  content: string;
  reason: string;
  voiceIntent: string;
  llmProvider: string;
  llmModel: string;
  llmCostUsd: number;
};

export type ReplayEvent = {
  createdAt: string;
  channelId: string;
  role: "USER" | "BOT" | "BOT_ACTION";
  authorName: string;
  content: string;
};

export type TurnSnapshot = {
  index: number;
  messageId: string;
  createdAt: string;
  channelId: string;
  channelMode: ChannelMode;
  authorName: string;
  userContent: string;
  addressed: boolean;
  attempted: boolean;
  decisionKind: DecisionOutcomeKind;
  decisionReason: string;
  botContent: string;
  llmProvider: string;
  llmModel: string;
  llmCostUsd: number;
};

export type LoadDbStateInput<TArgs extends ReplayBaseArgs> = {
  db: Database;
  args: TArgs;
  contextSince: string;
  messages: MessageRow[];
};

export type CreateScenarioStateInput<TArgs extends ReplayBaseArgs, TDbState> = {
  args: TArgs;
  dbState: TDbState;
  runtimeSettings: Record<string, unknown>;
  botUserId: string;
  initiativeChannelIds: Set<string>;
};

export type ReplayTurnContext<TArgs extends ReplayBaseArgs, TScenarioState> = {
  args: TArgs;
  scenarioState: TScenarioState;
  runtimeSettings: Record<string, unknown>;
  mode: HarnessMode;
  message: MessageRow;
  channelMode: ChannelMode;
  history: MessageRow[];
  historyByMessageId: Map<string, MessageRow>;
  botUserId: string;
  llmService: LLMService;
  turnIndex: number;
};

export type ReplayTurnResult = {
  addressed: boolean;
  attempted: boolean;
  decision: ReplayDecision;
};

export type ReplayScenarioDefinition<
  TArgs extends ReplayBaseArgs,
  TScenarioState,
  TDbState
> = {
  name: string;
  loadDbState: (input: LoadDbStateInput<TArgs>) => TDbState;
  createScenarioState: (
    input: CreateScenarioStateInput<TArgs, TDbState>
  ) => TScenarioState;
  runTurn: (
    input: ReplayTurnContext<TArgs, TScenarioState>
  ) => Promise<ReplayTurnResult> | ReplayTurnResult;
};

export type ReplayEngineResult<
  TArgs extends ReplayBaseArgs,
  TScenarioState,
  TDbState
> = {
  args: TArgs;
  contextSince: string;
  runtimeSettings: Record<string, unknown>;
  botUserId: string;
  initiativeChannelIds: Set<string>;
  messages: MessageRow[];
  replayMessages: MessageRow[];
  processedTurns: number;
  timeline: ReplayEvent[];
  turnSnapshots: TurnSnapshot[];
  llmService: LLMService;
  scenarioState: TScenarioState;
  dbState: TDbState;
};
