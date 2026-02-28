import { parseJsonObjectFromText } from "./utils.ts";

type JudgeTrace = {
  guildId: unknown;
  channelId: unknown;
  userId: unknown;
  source: unknown;
  event: unknown;
  reason: unknown;
  messageId: unknown;
};

export type JudgeLlmService = {
  generate: (input: {
    settings: Record<string, unknown>;
    systemPrompt: string;
    userPrompt: string;
    imageInputs?: unknown[];
    contextMessages?: unknown[];
    trace?: JudgeTrace;
    jsonSchema?: string;
  }) => Promise<{
    text: string;
    provider?: string;
    model?: string;
    costUsd?: number;
    usage?: unknown;
  }>;
};

export type RunJsonJudgeInput<T> = {
  llm: JudgeLlmService;
  settings: Record<string, unknown>;
  systemPrompt: string;
  userPrompt: string;
  trace: JudgeTrace;
  onParsed: (parsed: Record<string, unknown>, rawText: string) => T;
  onParseError: (rawText: string) => T;
};

export async function runJsonJudge<T>(input: RunJsonJudgeInput<T>): Promise<T> {
  const generation = await input.llm.generate({
    settings: input.settings,
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    trace: input.trace
  });

  const rawText = String(generation?.text || "");
  const parsed = parseJsonObjectFromText(rawText);
  if (!parsed) {
    return input.onParseError(rawText);
  }

  return input.onParsed(parsed, rawText);
}
