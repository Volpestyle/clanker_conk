# Codex CLI Integration Plan

## Context / Why

Claude Code CLI (`claude`) powers two roles in Clanker Conk:

1. **Code agent** -- spawns `claude -p` subprocess to execute coding tasks locally
2. **Brain provider** -- persistent `claude -p` stream session powering the bot's conversational text generation, memory extraction, etc. This makes it a general-purpose LLM alongside OpenAI/Anthropic/xAI APIs.

Codex currently uses only the **OpenAI Responses API** (HTTP polling in `src/llm/llmCodex.ts`). It runs code **remotely on OpenAI's servers**, not locally. The Codex CLI (`codex` v0.111.0) is installed at `/Users/jamesvolpe/.nvm/versions/node/v25.4.0/bin/codex` but is unused by the bot.

The Codex CLI has full parity with Claude Code CLI for what we need:

| Capability | Claude Code CLI | Codex CLI |
|---|---|---|
| Non-interactive execution | `claude -p "prompt"` | `codex exec "prompt"` |
| JSONL streaming output | `--output-format stream-json` | `--json` |
| Working directory | `cwd` in spawn options | `-C <dir>` flag |
| Model selection | `--model sonnet` | `-m gpt-5.4` |
| Sandbox control | N/A (trusts local env) | `-s workspace-write` |
| Full auto mode | `--no-session-persistence` | `--full-auto` or `--dangerously-bypass-approvals-and-sandbox` |
| Ephemeral (no session files) | `--no-session-persistence` | `--ephemeral` |
| Multi-turn resume | stdin stream-json piping | `codex exec resume <session_id>` |
| Output schema | StructuredOutput tool | `--output-schema <file>` |
| Local/OSS models | N/A | `--oss` with `--local-provider ollama/lmstudio` |
| Config overrides | CLI flags | `-c key=value` (TOML) |

Verified working -- `codex exec --json --ephemeral "say hello"` outputs clean JSONL:

```json
{"type":"thread.started","thread_id":"019cc534-ec64-7c20-89f4-ff5b033081c5"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hello"}}
{"type":"turn.completed","usage":{"input_tokens":15698,"cached_input_tokens":3456,"output_tokens":104}}
```

## New Provider Identifiers

Follow the exact naming convention used for Claude Code:

| Provider ID | Role | Mirrors |
|---|---|---|
| `"codex-cli"` | One-shot Codex CLI invocation (brain + code agent) | `"claude-code"` |
| `"codex_cli_session"` | Persistent multi-turn Codex CLI session (brain) | `"claude_code_session"` |

---

## File-by-File Plan

### 1. NEW: `src/llm/llmCodexCli.ts` (mirrors `llmClaudeCode.ts`)

The low-level subprocess module. Key exports:

**Types:**

```typescript
type CodexCliResult = { stdout: string; stderr: string };
type CodexCliError = Error & { killed?: boolean; signal?: string | null; code?: number | null; stdout?: string; stderr?: string };
export type CodexCliStreamSessionLike = {
  run: (payload: { input?: string; timeoutMs?: number }) => Promise<CodexCliResult>;
  close: () => void;
  isIdle: () => boolean;
};
```

**`runCodexCli()`** -- One-shot subprocess spawn:

```typescript
export function runCodexCli({ args, input, timeoutMs, maxBufferBytes, cwd = "" }): Promise<CodexCliResult>
```

- Spawns `codex` instead of `claude`
- Same timeout/SIGTERM/SIGKILL pattern as `runClaudeCli()`
- Same stdout/stderr buffer limiting

**`CodexCliStreamSession`** -- Multi-turn session:

- Unlike Claude Code's stdin-piping approach, Codex CLI uses `codex exec resume <session_id>` to continue sessions
- The session class should:
  - On first `run()`: spawn `codex exec --json -m <model> <prompt>` and capture the `thread_id` from the `{"type":"thread.started","thread_id":"..."}` event
  - On subsequent `run()` calls: spawn `codex exec resume <thread_id> --json <prompt>`
  - This means each turn is a **new process** (unlike Claude Code which keeps one process alive). Store `threadId` between turns.
  - Same job queue/serialization pattern as `ClaudeCliStreamSession` but the child process completes and exits after each turn

**JSONL event parsing -- `parseCodexCliJsonlOutput()`:**

Codex CLI emits these event types:

```jsonl
{"type":"thread.started","thread_id":"019cc534-ec64-7c20-89f4-ff5b033081c5"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hello"}}
{"type":"turn.completed","usage":{"input_tokens":15698,"cached_input_tokens":3456,"output_tokens":104}}
```

The parser should:
- Collect all `item.completed` events where `item.type === "agent_message"`, concatenate their `.text`
- Extract `usage` from the `turn.completed` event
- Extract `thread_id` from `thread.started` for session continuation
- Return shape matching Claude Code's parsed result: `{ text, isError, errorMessage, usage: { inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens }, costUsd, threadId }`

**Arg builders:**

`buildCodexCliBrainArgs()` -- for brain/general LLM use:

```typescript
// codex exec --json --ephemeral -m <model> --skip-git-repo-check
// --dangerously-bypass-approvals-and-sandbox <prompt>
```

`buildCodexCliCodeAgentArgs()` -- for code agent one-shot:

```typescript
// codex exec --json --ephemeral -m <model> -C <cwd>
// -s workspace-write --dangerously-bypass-approvals-and-sandbox <instruction>
```

`buildCodexCliResumeArgs()` -- for session continuation:

```typescript
// codex exec resume <threadId> --json -m <model> <prompt>
```

**`normalizeCodexCliError()`** -- same pattern as `normalizeClaudeCodeCliError()`

### 2. NEW: `src/llm/codexCliService.ts` (mirrors `claudeCodeService.ts`)

The brain provider service. Key exports:

**`CodexCliServiceDeps`** type:

```typescript
export type CodexCliServiceDeps = {
  codexCliAvailable: boolean;
  getBrainSession: () => CodexCliStreamSessionLike | null;
  setBrainSession: (session: CodexCliStreamSessionLike | null) => void;
  getBrainModel: () => string;
  setBrainModel: (model: string) => void;
};
```

**`callCodexCli()`** -- main brain entry point with fallback strategy:

1. Primary: persistent session via `CodexCliStreamSession` (resume-based)
2. Fallback: one-shot `codex exec --json` invocation
3. Last resort: one-shot plain text (capture stdout as-is)

**`callCodexCliMemoryExtraction()`** -- one-shot memory extraction

**`runCodexCliBrainStream()`** -- manages the persistent brain session, creates/resets on model change

**`closeCodexCliSession()`** -- cleanup

**Key difference from Claude Code brain:**

- Claude Code creates an isolated workspace at `/tmp/clanker-conk-brain/` with a fake `.git` directory
- Codex CLI can use `--skip-git-repo-check` instead, no fake workspace needed
- Turn preamble injection works the same way -- prepend scope/privacy/system prompt to the user message

### 3. UPDATE: `src/agents/codeAgent.ts`

**Add a third provider resolution path:**

Currently `CodeAgentProvider = "claude-code" | "codex" | "auto"`. Change to:

```typescript
export type CodeAgentProvider = "claude-code" | "codex" | "codex-cli" | "auto";
```

**Update `resolveEffectiveCodeAgentProvider()`:**

```typescript
function resolveEffectiveCodeAgentProvider(provider: CodeAgentProvider): "claude-code" | "codex" | "codex-cli" {
  if (provider === "codex") return "codex";
  if (provider === "codex-cli") return "codex-cli";
  return "claude-code";
}
```

**Add `codex-cli` branch in `runCodeAgent()`:**

When `resolvedProvider === "codex-cli"`:
- Import and use `runCodexCli` + `buildCodexCliCodeAgentArgs` from `llmCodexCli.ts`
- Parse output with `parseCodexCliJsonlOutput()`
- Pass `cwd` via `-C` flag (Codex CLI has native directory support)

**Add `CodexCliAgentSession` creation in `createCodeAgentSession()`:**

Create a new session class (could live in a new `src/agents/codexCliAgent.ts` or inline) that wraps `CodexCliStreamSession` and implements `SubAgentSession`.

**Update `CodeAgentConfig` and `resolveCodeAgentConfig()`:**

Add `codexCliModel` field. Read from `devRuntime.codexCli?.model`.

### 4. NEW: `src/agents/codexCliAgent.ts` (mirrors `codexAgent.ts`)

`CodexCliAgentSession` class implementing `SubAgentSession`:
- Constructor takes `{ scopeKey, cwd, model, timeoutMs, trace, store }`
- `runTurn()` uses `CodexCliStreamSession` (resume-based multi-turn)
- `close()` closes the stream session
- Same logging pattern as `CodexAgentSession` but with `provider: "codex-cli"`

### 5. UPDATE: `src/llm.ts` (`LLMService`)

**Constructor -- add Codex CLI detection:**

```typescript
this.codexCliAvailable = false;
try {
  const result = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 5000 });
  const versionOutput = String(result?.stdout || result?.stderr || "").trim();
  this.codexCliAvailable = result?.status === 0 && Boolean(versionOutput);
} catch {
  this.codexCliAvailable = false;
}
this.codexCliBrainSession = null;
this.codexCliBrainModel = "";
```

**Add class properties:**

```typescript
codexCliAvailable: boolean;
codexCliBrainSession: CodexCliStreamSessionLike | null;
codexCliBrainModel: string;
```

**Add `codexCliDeps()` method:**

```typescript
private codexCliDeps(): CodexCliServiceDeps {
  return {
    codexCliAvailable: this.codexCliAvailable,
    getBrainSession: () => this.codexCliBrainSession,
    setBrainSession: (session) => { this.codexCliBrainSession = session; },
    getBrainModel: () => this.codexCliBrainModel,
    setBrainModel: (model) => { this.codexCliBrainModel = model; }
  };
}
```

**Update `callChatModel()`** -- add routing:

```typescript
if (provider === "codex-cli") {
  return callCodexCliRequest(this.codexCliDeps(), payload);
}
```

**Update `isProviderConfigured()`:**

```typescript
if (provider === "codex-cli") return Boolean(this.codexCliAvailable);
if (provider === "codex_cli_session") return Boolean(this.codexCliAvailable);
```

**Update `resolveDefaultModel()`:**

```typescript
if (provider === "codex-cli") return normalizeDefaultModel(this.appConfig?.defaultCodexCliModel, "gpt-5.4");
if (provider === "codex_cli_session") return normalizeDefaultModel(this.appConfig?.defaultCodexCliModel, "gpt-5.4");
```

**Add wrapper methods:**

- `callCodexCli()`
- `callCodexCliMemoryExtraction()`
- `runCodexCliBrainStream()`

**Update `close()`:**

```typescript
close() {
  closeClaudeCodeSession(this.claudeCodeDeps());
  closeCodexCliSession(this.codexCliDeps());
}
```

### 6. UPDATE: `src/llm/llmHelpers.ts`

**Add `CODEX_CLI_MODELS`:**

```typescript
const CODEX_CLI_MODELS = new Set(["gpt-5.4", "gpt-5", "gpt-5-codex", "codex-mini-latest", "o3", "o4-mini"]);
// Or keep it open -- codex CLI can use any model string, unlike claude-code which restricts to sonnet/opus/haiku
```

**Update `normalizeLlmProvider()`:**

Add cases for `"codex-cli"` and `"codex_cli_session"`.

**Update `defaultModelForLlmProvider()`:**

```typescript
if (provider === "codex-cli") return "gpt-5.4";
if (provider === "codex_cli_session") return "gpt-5.4";
```

**Update `resolveProviderFallbackOrder()`:**

```typescript
if (provider === "codex-cli") return ["codex-cli", "codex", "openai", "anthropic", "claude-code", "xai"];
if (provider === "codex_cli_session") return ["codex_cli_session", "codex-cli", "codex", "openai", "anthropic", "claude-code", "xai", "claude_code_session"];
```

**Add `normalizeCodexCliModel()` (or skip -- codex CLI accepts any model string, no validation needed).**

### 7. UPDATE: `src/settings/settingsSchema.ts`

**Update `MODEL_PROVIDER_KINDS`:**

```typescript
export const MODEL_PROVIDER_KINDS = [
  "openai", "anthropic", "ai_sdk_anthropic", "litellm",
  "claude_code_session", "codex_cli_session",
  "xai", "claude-code", "codex", "codex-cli"
] as const;
```

**Update `PROVIDER_MODEL_FALLBACKS`:**

```typescript
"codex-cli": ["gpt-5.4", "gpt-5-codex"],
codex_cli_session: ["gpt-5.4"]
```

**Add `devTeam.codexCli` default config** (alongside existing `devTeam.codex` and `devTeam.claudeCode`):

```typescript
codexCli: {
  enabled: false,
  model: "gpt-5.4",
  maxTurns: 30,
  timeoutMs: 300_000,
  maxBufferBytes: 2 * 1024 * 1024,
  defaultCwd: "",
  maxTasksPerHour: 10,
  maxParallelTasks: 2
}
```

**Add `codexCliSession` runtime config** (alongside `claudeCodeSession`):

```typescript
codexCliSession: {
  sessionScope: "guild",
  inactivityTimeoutMs: 1_800_000,
  contextPruningStrategy: "summarize",
  maxPinnedStateChars: 12_000
}
```

### 8. UPDATE: `src/settings/agentStack.ts`

**Update preset definitions** -- add `codex_cli` as a coding worker option:

- `openai_native` preset: `codingWorkers: ["codex", "codex_cli", "claude_code"]`
- `claude_code_max` preset: `codingWorkers: ["claude_code", "codex_cli", "codex"]`
- Add a new preset `codex_cli_max` if desired

**Update `resolveAgentStack()`** to recognize `codex_cli` as a valid coding worker.

**Update `getDevTeamRuntimeConfig()`** to return `codexCli` config.

### 9. UPDATE: `src/llm/pricing.ts`

Add `"codex-cli"` as a zero-cost provider (billing is external via the CLI):

```typescript
"codex-cli": {
  "gpt-5.4": { inputPer1M: 0, outputPer1M: 0 },
  "gpt-5-codex": { inputPer1M: 0, outputPer1M: 0 }
}
```

Add `"codex-cli"` to `LLM_PROVIDER_KEYS`.

### 10. UPDATE: `src/store/normalize/agentStack.ts`

Add normalization for `devTeam.codexCli.*` fields (same pattern as `devTeam.codex` and `devTeam.claudeCode`).

### 11. UPDATE: `src/llm/memoryExtraction.ts`

Add `codex-cli` routing in `callMemoryExtractionModel()`:

```typescript
if (provider === "codex-cli") return callCodexCliMemoryExtractionRequest(deps, payload);
```

### 12. UPDATE: Dashboard files

- `dashboard/src/components/settingsSections/LlmProviderOptions.tsx` -- add `"codex-cli"` and `"codex_cli_session"` to the dropdown
- `dashboard/src/components/settingsSections/CodeAgentSettingsSection.tsx` -- add `"Codex CLI (local)"` option alongside `"Claude Code (local)"` and `"Codex (OpenAI)"`
- `dashboard/src/settingsFormModel.ts` -- add codexCli form model fields

### 13. UPDATE: `src/bot.ts` and `src/bot/agentTasks.ts`

Pass `codexCliModel` through to agent task creation, same as `codexModel` is passed today.

### 14. Tests

- Add `src/llm/llm.codexCli.test.ts` -- unit tests for arg builders, JSONL parser (same style as `llm.claudeCode.test.ts`)
- Update `src/llm/llm.providerSelection.test.ts` -- add codex-cli provider resolution/fallback tests
- Update `dashboard/src/settingsFormModel.test.ts` -- add codexCli settings roundtrip

---

## Key Design Decision: Multi-Turn Session Model

The biggest architectural difference is session continuity:

| | Claude Code CLI | Codex CLI |
|---|---|---|
| **Mechanism** | Single long-lived process, stdin/stdout piping | New process per turn, `codex exec resume <threadId>` |
| **State** | In-process memory | Disk-persisted session files |
| **Latency** | Lower (no process startup) | Higher (~1-2s process startup per turn) |
| **Reliability** | Process crash = session lost | Session survives crashes |

For the `CodexCliStreamSession` class, **do not** try to keep a persistent process alive. Instead:

- First turn: `codex exec --json ...` -> capture `thread_id` from stdout
- Subsequent turns: `codex exec resume <thread_id> --json <prompt>` -> new process, same session
- `close()` is a no-op (no process to kill) or could delete the session files

This is actually more robust than Claude Code's approach -- if the bot crashes mid-turn, the Codex session survives on disk and can be resumed.

## Remove dead API path?

After this work, there will be three ways to use Codex:

1. `"codex"` -- OpenAI Responses API (existing, remote execution)
2. `"codex-cli"` -- Codex CLI subprocess (new, local execution)
3. `"codex_cli_session"` -- Codex CLI persistent brain session (new, local execution)

The existing `"codex"` API path should stay for now -- it's a valid use case (remote sandboxed execution without needing the CLI installed). But the new CLI paths become the preferred local option.

## Benefits of This Integration

- **Sandbox control** -- Codex CLI has built-in sandboxing (`-s workspace-write`) that the Responses API path lacks
- **Local execution with real filesystem access** -- the Responses API runs code remotely on OpenAI's servers, while the CLI runs locally just like Claude Code does
- **Consistency** -- both coding agents use the same subprocess pattern
- **OSS model support** -- Codex CLI can use Ollama/LM Studio models, extending the "any LLM" story
- **Cost** -- CLI billing may differ from API billing (just like Claude Code's zero-cost pricing model)
- **Crash resilience** -- Codex CLI's disk-persisted sessions survive bot crashes
