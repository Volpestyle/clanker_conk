# Thought Queue Alignment Plan

Status: completed

## Goal

Align ambient text and voice behavior more closely with the presence-and-attention model by giving Clanker a real pending thought he can keep, refine, replace, drop, or surface later instead of only making one-shot speak/post decisions.

## Current Gaps

- Voice thought generation is single-shot: generate, refine once, then either speak now or drop.
- Text initiative is single-shot: post now or skip.
- Neither path persists an unsent ambient thought across ticks.
- Prompts do not expose continuity like "your current thought" or ask the model what it is currently thinking in an ongoing way.
- Runtime/debug surfaces do not show any pending ambient thought state.

## Implementation Plan

### 1. Voice queue

- Add a `pendingAmbientThought` object to voice session runtime state.
- Rework voice thought evaluation from binary `allow` into actions that can `speak_now`, `hold`, or `drop`.
- Revisit queued voice thoughts before generating a fresh one.
- Invalidate or re-evaluate queued voice thoughts when new user room activity changes the context.
- Expose queued thought state in the voice runtime snapshot.

### 2. Text initiative queue

- Add a lightweight per-guild pending initiative thought store on the bot runtime.
- Revisit pending thoughts before normal initiative cooldown/probability logic so held thoughts actually get reconsidered.
- Extend the initiative JSON contract so the model can `post`, `hold`, `replace`, or `drop` instead of collapsing everything into `skip`.
- Pass pending-thought continuity into the initiative prompt.

### 3. Prompt continuity

- Add explicit continuity language such as:
  - `Your current thought: ...`
  - `What are you thinking right now?`
- Keep fresh room/feed context rebuilt on each tick while preserving only the pending draft plus minimal provenance.

### 4. Docs and verification

- Update canonical docs to describe the shipped thought-queue behavior.
- Adjust focused tests around queue persistence/refinement/drop behavior.
- Run `bun run typecheck` and `bun run test` at the end.

## Done Criteria

- [x] Voice can hold a thought, revisit it, refine it, and either speak or drop it later.
- [x] Text initiative can hold a thought, revisit it, refine/replace it, and either post or drop it later.
- [x] Pending thought state is visible in runtime/debug surfaces where relevant.
- [x] Docs describe the actual shipped behavior, not the old one-shot flow.
