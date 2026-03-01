# Claude Code Brain Session Mode

This document explains the `claude-code` provider behavior when running Clanker Conk as a single serialized Claude Code "brain" session.

## What It Is

When `llm.provider` resolves to `claude-code`, text generation now prefers one warm stream-json Claude CLI process for the active model:

- one long-lived `claude -p` process
- one in-memory turn queue (serialized brain turns)
- no parallel Claude brain turns
- continuity across turns in the same runtime process

Memory extraction stays stateless and does not share the persistent brain stream.

## Turn Model

Each turn still includes:

- explicit `contextMessages`
- the current `userPrompt`
- a turn preamble (scope metadata + privacy boundary reminder + current system directives)

This preserves continuity while still reinforcing channel/user boundaries in-prompt.

## Compared To API Mode

`openai` / `anthropic` / `xai` API mode:

- stateless request/response per call
- no hidden cross-call model state
- continuity is achieved by re-sending context and memory slices each turn
- easy to reason about replay determinism

`claude-code` brain session mode:

- stateful in-process session continuity
- lower warm-turn latency from process/session reuse
- potential for stronger long-horizon persona continuity
- higher need for prompt-level privacy boundaries and serialized orchestration discipline

## Operational Notes

- Session continuity is runtime-local; restarting the bot resets the in-memory Claude brain session.
- Switching Claude model aliases (for example `haiku` -> `sonnet`) restarts the warm brain session for that model.
- JSON fallback parsing now prefers `structured_output` when present, matching modern Claude CLI output patterns.
