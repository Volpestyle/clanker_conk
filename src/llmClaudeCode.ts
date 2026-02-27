import { spawn } from "node:child_process";

type ClaudeCliResult = {
  stdout: string;
  stderr: string;
};

type ClaudeCliError = Error & {
  killed?: boolean;
  signal?: string | null;
  code?: number | null;
  stdout?: string;
  stderr?: string;
};

export function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

export function runClaudeCli({ args, input, timeoutMs, maxBufferBytes }) {
  return new Promise<ClaudeCliResult>((resolve, reject) => {
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;

    const finish = (error: Error | null, result?: ClaudeCliResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result || { stdout: "", stderr: "" });
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 1000);
    }, timeoutMs);

    child.on("error", (error) => finish(error));

    child.stdout.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ""));
      if (stdoutBytes < maxBufferBytes) {
        const remaining = maxBufferBytes - stdoutBytes;
        stdout += buffer.subarray(0, remaining).toString("utf8");
      }
      stdoutBytes += buffer.length;
    });

    child.stderr.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ""));
      if (stderrBytes < maxBufferBytes) {
        const remaining = maxBufferBytes - stderrBytes;
        stderr += buffer.subarray(0, remaining).toString("utf8");
      }
      stderrBytes += buffer.length;
    });

    child.on("close", (code, signal) => {
      if (timedOut) {
        const error = new Error("claude CLI timeout") as ClaudeCliError;
        error.killed = true;
        error.signal = signal || "SIGTERM";
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        finish(error, undefined);
        return;
      }

      if (code === 0) {
        finish(null, { stdout, stderr });
        return;
      }

      const error = new Error(`Command failed: claude ${args.join(" ")}`) as ClaudeCliError;
      error.code = code;
      error.signal = signal;
      error.stdout = stdout;
      error.stderr = stderr;
      finish(error, undefined);
    });

    child.stdin.on("error", () => {});
    child.stdin.end(input || "");
  });
}

export function buildAnthropicImageParts(imageInputs) {
  return (Array.isArray(imageInputs) ? imageInputs : [])
    .map((image) => {
      const mediaType = String(image?.mediaType || image?.contentType || "").trim().toLowerCase();
      const base64 = String(image?.dataBase64 || "").trim();
      const url = String(image?.url || "").trim();
      if (base64 && /^image\/[a-z0-9.+-]+$/i.test(mediaType)) {
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: base64
          }
        };
      }
      if (!url) return null;
      return {
        type: "image",
        source: {
          type: "url",
          url
        }
      };
    })
    .filter(Boolean);
}

export function buildClaudeCodeStreamInput({
  contextMessages = [],
  userPrompt,
  imageInputs = []
}) {
  const events = [];

  for (const msg of Array.isArray(contextMessages) ? contextMessages : []) {
    const role = msg?.role === "assistant" ? "assistant" : "user";
    const text = String(msg?.content || "");
    events.push({
      type: role,
      message: {
        role,
        content: [{ type: "text", text }]
      }
    });
  }

  const userText = String(userPrompt || "");
  const imageParts = buildAnthropicImageParts(imageInputs);
  const userContent = [{ type: "text", text: userText }, ...imageParts];
  events.push({
    type: "user",
    message: {
      role: "user",
      content: userContent
    }
  });

  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

export function buildClaudeCodeCliArgs({ model, systemPrompt = "", jsonSchema = "" }) {
  const args = [
    "-p",
    "--verbose",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--tools", "",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--model", model,
    "--max-turns", "1"
  ];

  const normalizedSystemPrompt = String(systemPrompt || "").trim();
  if (normalizedSystemPrompt) {
    args.push("--system-prompt", normalizedSystemPrompt);
  }

  const normalizedSchema = String(jsonSchema || "").trim();
  if (normalizedSchema) {
    args.push("--json-schema", normalizedSchema);
  }

  return args;
}

export function buildClaudeCodeJsonCliArgs({
  model,
  systemPrompt = "",
  jsonSchema = "",
  prompt = ""
}) {
  const args = [
    "-p",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--tools", "",
    "--output-format", "json",
    "--model", model,
    "--max-turns", "1"
  ];

  const normalizedSystemPrompt = String(systemPrompt || "").trim();
  if (normalizedSystemPrompt) {
    args.push("--system-prompt", normalizedSystemPrompt);
  }

  const normalizedSchema = String(jsonSchema || "").trim();
  if (normalizedSchema) {
    args.push("--json-schema", normalizedSchema);
  }

  const normalizedPrompt = String(prompt || "").trim();
  if (normalizedPrompt) {
    args.push(normalizedPrompt);
  }

  return args;
}

export function buildClaudeCodeTextCliArgs({
  model,
  systemPrompt = "",
  jsonSchema = "",
  prompt = ""
}) {
  const args = [
    "-p",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--tools", "",
    "--model", model,
    "--max-turns", "1"
  ];

  const normalizedSystemPrompt = String(systemPrompt || "").trim();
  if (normalizedSystemPrompt) {
    args.push("--system-prompt", normalizedSystemPrompt);
  }

  const normalizedSchema = String(jsonSchema || "").trim();
  if (normalizedSchema) {
    args.push("--json-schema", normalizedSchema);
  }

  const normalizedPrompt = String(prompt || "").trim();
  if (normalizedPrompt) {
    args.push(normalizedPrompt);
  }

  return args;
}

export function buildClaudeCodeFallbackPrompt({
  contextMessages = [],
  userPrompt = "",
  imageInputs = []
}) {
  const sections = [];
  const historyLines = [];
  for (const message of Array.isArray(contextMessages) ? contextMessages : []) {
    const role = message?.role === "assistant" ? "assistant" : "user";
    const text = String(message?.content || "").trim();
    if (!text) continue;
    historyLines.push(`${role}: ${text}`);
  }
  if (historyLines.length) {
    sections.push(`Conversation context:\n${historyLines.join("\n")}`);
  }

  const normalizedPrompt = String(userPrompt || "").trim();
  if (normalizedPrompt) {
    sections.push(`User request:\n${normalizedPrompt}`);
  }

  const imageLines = (Array.isArray(imageInputs) ? imageInputs : [])
    .map((image) => {
      const url = String(image?.url || "").trim();
      if (url) return `- ${url}`;

      const mediaType = String(image?.mediaType || image?.contentType || "").trim();
      const hasInlineImage = Boolean(String(image?.dataBase64 || "").trim());
      if (!hasInlineImage) return "";

      return mediaType ? `- inline image (${mediaType})` : "- inline image";
    })
    .filter(Boolean);
  if (imageLines.length) {
    sections.push(`Image references:\n${imageLines.join("\n")}`);
  }

  return sections.join("\n\n").trim();
}

export function buildClaudeCodeSystemPrompt({ systemPrompt = "", maxOutputTokens = 0 }) {
  const normalizedSystemPrompt = String(systemPrompt || "").trim();
  if (!normalizedSystemPrompt) return "";

  const requestedMaxOutputTokens = Number(maxOutputTokens || 0);
  if (!Number.isFinite(requestedMaxOutputTokens) || requestedMaxOutputTokens <= 0) {
    return normalizedSystemPrompt;
  }

  const boundedMaxOutputTokens = clampInt(maxOutputTokens, 1, 32000);

  return [
    normalizedSystemPrompt,
    `Keep the final answer under ${boundedMaxOutputTokens} tokens.`
  ].join("\n\n");
}

export function parseClaudeCodeStreamOutput(rawOutput) {
  const lines = String(rawOutput || "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  let lastResult = null;
  let lastAssistantText = "";
  let lastStructuredOutputText = "";

  for (const line of lines) {
    const event = safeJsonParse(line, null);
    if (!event || typeof event !== "object") continue;

    if (event.type === "assistant" && event.message && Array.isArray(event.message.content)) {
      const textParts = [];
      for (const part of event.message.content) {
        if (part?.type === "text") {
          const textPart = String(part?.text || "").trim();
          if (textPart) textParts.push(textPart);
          continue;
        }

        if (part?.type === "tool_use" && String(part?.name || "") === "StructuredOutput") {
          const serializedOutput = serializeClaudeCodeStructuredOutput(part?.input);
          if (serializedOutput) lastStructuredOutputText = serializedOutput;
        }
      }

      const text = textParts.join("\n").trim();
      if (text) lastAssistantText = text;
      continue;
    }

    if (event.type === "result") {
      lastResult = event;
    }
  }

  if (!lastResult) {
    const fallbackText = lastStructuredOutputText || lastAssistantText;
    if (!fallbackText) return null;
    return {
      text: fallbackText,
      isError: false,
      errorMessage: "",
      usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
      costUsd: 0
    };
  }

  const usage = lastResult.usage || {};
  const resultText = String(lastResult.result || "").trim();
  const errors = Array.isArray(lastResult.errors) ? lastResult.errors : [];
  const errorMessage = resultText || errors.map((item) => String(item || "").trim()).filter(Boolean).join(" | ");
  const preferredText = lastStructuredOutputText || resultText || lastAssistantText;

  return {
    text: preferredText,
    isError: Boolean(lastResult.is_error),
    errorMessage,
    usage: {
      inputTokens: Number(usage.input_tokens || 0),
      outputTokens: Number(usage.output_tokens || 0),
      cacheWriteTokens: Number(usage.cache_creation_input_tokens || 0),
      cacheReadTokens: Number(usage.cache_read_input_tokens || 0)
    },
    costUsd: Number(lastResult.total_cost_usd || 0)
  };
}

function serializeClaudeCodeStructuredOutput(rawValue) {
  if (rawValue == null) return "";
  if (typeof rawValue === "string") {
    return String(rawValue || "").trim();
  }

  try {
    return JSON.stringify(rawValue);
  } catch {
    return "";
  }
}

export function parseClaudeCodeJsonOutput(rawOutput) {
  const rawText = String(rawOutput || "").trim();
  if (!rawText) return null;

  const parsedWhole = safeJsonParse(rawText, null);
  let lastResult =
    parsedWhole && typeof parsedWhole === "object" && !Array.isArray(parsedWhole)
      ? parsedWhole
      : null;

  if (!lastResult || (!lastResult.type && lastResult.result === undefined)) {
    const lines = rawText
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean);
    lastResult = null;
    for (const line of lines) {
      const event = safeJsonParse(line, null);
      if (!event || typeof event !== "object") continue;
      if (event.type === "result") {
        lastResult = event;
      }
    }
  }
  if (!lastResult) return null;

  const usage = lastResult.usage || {};
  const resultText = String(lastResult.result || "").trim();
  const errors = Array.isArray(lastResult.errors) ? lastResult.errors : [];
  const errorMessage = resultText || errors.map((item) => String(item || "").trim()).filter(Boolean).join(" | ");

  return {
    text: resultText,
    isError: Boolean(lastResult.is_error),
    errorMessage,
    usage: {
      inputTokens: Number(usage.input_tokens || 0),
      outputTokens: Number(usage.output_tokens || 0),
      cacheWriteTokens: Number(usage.cache_creation_input_tokens || 0),
      cacheReadTokens: Number(usage.cache_read_input_tokens || 0)
    },
    costUsd: Number(lastResult.total_cost_usd || 0)
  };
}

export function normalizeClaudeCodeCliError(
  error,
  { timeoutPrefix = "claude-code timed out", timeoutMs = 30_000 } = {}
) {
  if (error?.killed || error?.signal === "SIGTERM") {
    return {
      isTimeout: true,
      message: `${timeoutPrefix} after ${Math.max(1, Math.floor(Number(timeoutMs) || 0) / 1000)}s.`
    };
  }

  const detail = String(error?.stderr || error?.stdout || "").trim();
  return {
    isTimeout: false,
    message: detail
      ? `claude-code CLI error: ${error?.message || error} | ${detail.slice(0, 300)}`
      : `claude-code CLI error: ${error?.message || error}`
  };
}

export function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function clampInt(value, min, max) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return min;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}
