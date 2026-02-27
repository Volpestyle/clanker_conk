# Repository Instructions

- Always remove legacy compatibility paths and dead code as part of the same change.
- Do not keep backward-compatibility shims, aliases, or old-field fallbacks unless the user explicitly asks for them.
- Prefer a single source of truth over parallel old/new code paths.
- After refactors, delete unused settings, branches, helpers, and UI wiring instead of leaving dormant code behind.
- Pull inspiration from ../openclaw when designing and coding agentic capabilites for clanker conk
- Expect parallel in-flight edits from the user or other agents; treat unexpected diffs as active work, and never revert/reset/checkout files you did not explicitly change for the current task.
- Avoid typecasts to `any` or `unknown`; prefer explicit, concrete types and narrow unions. Use casts only as a last resort with clear justification.
- Prefer LLM-driven decisions over hardcoded heuristics for conversational behavior; add deterministic heuristics only when explicitly requested or required for guardrails and obvious no-brainer cost savings.

## Dashboard UI Preferences

- No floating toasts. Prefer inline/in-UI alerts (status messages near the action that triggered them).

## Documentation Diagrams

Architecture and flow diagrams live as Mermaid source files in `docs/diagrams/*.mmd` and are rendered to high-res PNGs that the markdown files embed.
When writing or updating documentation, add/update a diagram when it would materially improve clarity for architecture, data flow, or runtime behavior.

### Regenerating diagrams after changes

After editing any `.mmd` file, re-render all diagrams:

```sh
npm run diagrams
```

Or render a single file:

```sh
npm run diagrams -- settings-flow.mmd
```

This runs `@mermaid-js/mermaid-cli` (`mmdc`) at 4x scale to produce crisp PNGs. Commit both the updated `.mmd` source and the regenerated `.png`.

### Adding a new diagram

1. Create `docs/diagrams/<name>.mmd` with valid Mermaid syntax.
2. Run `npm run diagrams -- <name>.mmd` to generate `docs/diagrams/<name>.png`.
3. Embed in the target markdown file:
   ```md
   ![Diagram Title](diagrams/<name>.png)
   <!-- source: docs/diagrams/<name>.mmd -->
   ```
4. Commit the `.mmd`, `.png`, and updated `.md` together.

### Conventions

- Never use inline ```` ```mermaid ```` blocks in markdown — always use rendered PNGs.
- Keep the `<!-- source: ... -->` comment below each image so readers can find and edit the source.
- Diagram filenames should be kebab-case and match the section they illustrate (e.g. `runtime-lifecycle.mmd`, `data-model.mmd`).
- Current diagrams: `runtime-lifecycle`, `data-model`, `settings-flow`, `message-event-flow`, `initiative-post-flow`, `memory-system-flow`.
