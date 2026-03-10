export type PromptCapture = {
  systemPrompt: string;
  initialUserPrompt: string;
  followupUserPrompts: string[];
};

export type LoggedPromptBundle = {
  hiddenByDefault: boolean;
  systemPrompt: string;
  initialUserPrompt: string;
  followupUserPrompts: string[];
  followupSteps: number;
};

export function createPromptCapture({
  systemPrompt = "",
  initialUserPrompt = ""
}: {
  systemPrompt?: string;
  initialUserPrompt?: string;
} = {}): PromptCapture {
  return {
    systemPrompt: String(systemPrompt || ""),
    initialUserPrompt: String(initialUserPrompt || ""),
    followupUserPrompts: []
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

  return {
    hiddenByDefault: true,
    systemPrompt,
    initialUserPrompt,
    followupUserPrompts,
    followupSteps: resolvedFollowupSteps
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
