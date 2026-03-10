export type PromptCapturedTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown> | null;
};

export type PromptCapture = {
  systemPrompt: string;
  initialUserPrompt: string;
  followupUserPrompts: string[];
  tools: PromptCapturedTool[];
};

export type LoggedPromptBundle = {
  hiddenByDefault: boolean;
  systemPrompt: string;
  initialUserPrompt: string;
  followupUserPrompts: string[];
  followupSteps: number;
  tools: PromptCapturedTool[];
};

export function createPromptCapture({
  systemPrompt = "",
  initialUserPrompt = "",
  tools = []
}: {
  systemPrompt?: string;
  initialUserPrompt?: string;
  tools?: PromptCapturedTool[];
} = {}): PromptCapture {
  return {
    systemPrompt: String(systemPrompt || ""),
    initialUserPrompt: String(initialUserPrompt || ""),
    followupUserPrompts: [],
    tools: Array.isArray(tools) ? tools : []
  };
}

export function appendPromptFollowup(
  capture: PromptCapture | null = null,
  userPrompt = ""
) {
  if (!capture || typeof capture !== "object") return;
  if (!Array.isArray(capture.followupUserPrompts)) {
    capture.followupUserPrompts = [];
  }
  capture.followupUserPrompts.push(String(userPrompt || ""));
}

export function buildLoggedPromptBundle(
  capture: PromptCapture | null = null,
  followupSteps = 0
): LoggedPromptBundle | null {
  if (!capture || typeof capture !== "object") return null;
  const systemPrompt = String(capture.systemPrompt || "");
  const initialUserPrompt = String(capture.initialUserPrompt || "");
  const followupUserPrompts = Array.isArray(capture.followupUserPrompts)
    ? capture.followupUserPrompts.map((prompt) => String(prompt || ""))
    : [];
  const resolvedFollowupSteps = Math.max(
    0,
    Number.isFinite(Number(followupSteps))
      ? Math.floor(Number(followupSteps))
      : followupUserPrompts.length
  );

  const tools = Array.isArray(capture.tools)
    ? capture.tools.map((t) => ({
      name: String(t?.name || ""),
      description: String(t?.description || ""),
      parameters: t?.parameters && typeof t.parameters === "object" ? t.parameters : null
    })).filter((t) => t.name)
    : [];

  return {
    hiddenByDefault: true,
    systemPrompt,
    initialUserPrompt,
    followupUserPrompts,
    followupSteps: resolvedFollowupSteps,
    tools
  };
}

export function buildSingleTurnPromptLog({
  systemPrompt = "",
  userPrompt = ""
}: {
  systemPrompt?: string;
  userPrompt?: string;
} = {}): LoggedPromptBundle {
  return buildLoggedPromptBundle(
    createPromptCapture({
      systemPrompt,
      initialUserPrompt: userPrompt
    }),
    0
  ) as LoggedPromptBundle;
}
