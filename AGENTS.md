# Repository Instructions

## Agent Autonomy — Core Design Principle

This bot is built around a single idea: **the agent sees context like a human would, and decides what to do on its own.**

We do not hardcode behaviors for the agent. We give it rich context — conversation history, channel events, available tools, memory, participant state — and let the model reason about what to do. The agent should feel like a real person who happens to have access to powerful tools, not a state machine following a script.

**What this means in practice:**

- **Tools are capabilities, not triggers.** If the agent sees a link in chat, it *can* use the browser tool to look at it — but only if it decides that's useful. We never wire "if link → browse" or "if question → search."
- **Prompts inform, they don't command.** Use soft guidance ("prefer", "when it fits naturally", "you may") over prescriptive rules ("you must", "always do X"). The model should reason about the situation, not follow a flowchart.
- **All user-facing speech is model-generated.** No canned responses, no fallback text, no hardcoded greetings. If the bot speaks, the model wrote those words for that moment.
- **Deterministic gates exist only for infrastructure safety** — permissions, rate limits, acoustic thresholds, budget caps. Never for creative or conversational decisions.
- **Admission gates are cost gates, not relevance gates.** They decide whether it's worth calling the LLM, not whether the bot should respond. The LLM decides that via `[SKIP]`. At high eagerness, gates widen and the model sees more; at low eagerness, gates narrow to save cost.
- **Settings are context, not rules.** Eagerness levels, persona flavor, and guidance text are injected into prompts for the model to reason about, not enforced as hard thresholds.
- **The agent can always choose silence.** `[SKIP]` is a first-class output. The bot should never be forced to respond just because it was triggered.

**When adding new features, ask:** "Am I telling the agent what to do, or am I giving it the context to decide for itself?" If the answer is the former, reconsider the design.

## General

- Include a 'Product language' conclusion in your messages and commit messages when it seems like it makes sense.
- Refer to docs/openai/openai-realtime-transcription.md when working with openai realtime transcripton or ASR.
- Refer to docs/openai/openai-realtime-speech.md when working with openai realtime speech.
- Runtime/package manager standard: use Bun (`bun`, `bun run`, `bunx`) over Node/NPM (`node`, `npm`, `npx`) unless explicitly requested.
- Do not run 'smoke' or 'live' tests unless the user explicitly directs you to run them, since they incur cost. E2E tests and essential unit tests are the primary focus.
- Build modular, composable, and easily testable components. Avoid monolithic architecture.
- For runtime debugging and incident analysis, prefer Grafana/Loki log exploration first; see `docs/logs.md` for setup and query workflow.
- Remove legacy compatibility paths, dead code, backward-compat shims, aliases, and old-field fallbacks as part of the same change. Prefer a single source of truth over parallel old/new code paths. Keep only what the user explicitly asks to preserve.
- Expect parallel in-flight edits from the user or other agents; treat unexpected diffs as active work, and never revert/reset/checkout files you did not explicitly change for the current task. Do not call out unrelated in-flight edits unless they directly interfere with your task.
- Avoid typecasts to `any` or `unknown`; prefer explicit, concrete types and narrow unions. Use casts only as a last resort with clear justification.
- Bot name is a customizable setting. Bot is not always named 'clanker conk'.
- Use git commit author `Volpestyle <14805252+Volpestyle@users.noreply.github.com>` for all commits in this repository.
- Pull inspiration from ../openclaw when designing and coding agentic capabilities for clanker conk.

## Testing Philosophy

- Design around Test Driven Development using Golden E2E Test Suites/Harnesses.
- E2E Discord bot-to-bot tests (`tests/e2e/`) validate the physical voice layer but require separate bot tokens and test guild setup (see `docs/e2e-testing.md`)
- The E2E Discord bot-to-bot tests are our primary testing method for this.
- When running live smoke or golden test suites, make sure we test different configurations, and are conscious about watching the integration test and the actual process logs at the same time, to cross reference. Integration test timings are most accurate when we read directly from our process logs.

### Test Commands

- When running e2e integration tests, start the bun bot process and then test so you can compare logs side by side.
- `bun run test` — unit/integration tests only (files in `src/` and `dashboard/src/`). E2E tests are excluded. Always use this for verification after code changes.
- `bun run test:e2e` — E2E tests only (`tests/e2e/`). Requires running dashboard, bot tokens, and test guild.
- `bun run test:e2e:voice` / `bun run test:e2e:text` — targeted E2E suites.
- Never run bare `bun test` — it discovers all `*.test.ts` files including E2E. Always use `bun run test`.


## Dashboard UI Preferences

- No floating toasts. Prefer inline/in-UI alerts (status messages near the action that triggered them).

## Documentation Diagrams

Architecture and flow diagrams live as Mermaid source files in `docs/diagrams/*.mmd` and are rendered to high-res PNGs that the markdown files embed.
When writing or updating documentation, add/update a diagram when it would materially improve clarity for architecture, data flow, or runtime behavior.

### Regenerating diagrams after changes

After editing any `.mmd` file, re-render all diagrams:

```sh
bun run diagrams
```

Or render a single file:

```sh
bun run diagrams -- settings-flow.mmd
```

This runs `@mermaid-js/mermaid-cli` (`mmdc`) at 4x scale to produce crisp PNGs. Commit both the updated `.mmd` source and the regenerated `.png`.

### Adding a new diagram

1. Create `docs/diagrams/<name>.mmd` with valid Mermaid syntax.
2. Run `bun run diagrams -- <name>.mmd` to generate `docs/diagrams/<name>.png`.
3. Embed in the target markdown file:

   ```md
   ![Diagram Title](diagrams/<name>.png)

   <!-- source: docs/diagrams/<name>.mmd -->
   ```

4. Commit the `.mmd`, `.png`, and updated `.md` together.

## Code Hygiene (Desloppifying)

When the codebase accumulates AI-generated cruft, follow this protocol:

### Audit Phase

Run analysis tools to identify issues, prioritized by impact:

- **High**: Bugs, security issues, type safety violations, `any`/`unknown` casts
- **Medium**: Duplicate code, dead code, unused imports/variables, inconsistent naming
- **Low**: Formatting, style inconsistencies

### Cleanup Workflow

1. Run linters and type checkers to surface issues
2. Categorize findings by severity (see above)
3. Fix incrementally — one category at a time, with tests between changes
4. Verify fixes with `bun run typecheck` and existing test suite
5. Use agents with file-level context rather than whole-repo context for targeted fixes

General rules on dead code removal, single source of truth, and type safety apply here — see [General](#general) above.
