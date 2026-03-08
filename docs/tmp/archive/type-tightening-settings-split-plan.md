# Type Tightening & Settings Split Plan

**Date:** March 6, 2026
**Target:** `ContextMessage` type in `src/llm/serviceShared.ts`, `settingsNormalization.ts` file split
**Goal:** Narrow the `ContextMessage.content` type from `unknown`, split the settings normalizer into per-section files.

---

## Current State

- `ContextMessage.content` is typed as `string | null | unknown` (effectively `unknown`) — a merge compromise
- `settingsNormalization.ts` is 1,668 lines with 0 `as any` casts but still a single large file
- 3 call sites construct context messages with mixed content types (string, Anthropic content blocks)

---

## Phase 1: Tighten ContextMessage.content Type

### The Problem

`ContextMessage` in `src/llm/serviceShared.ts` currently has:

```typescript
export type ContextMessage = {
  role?: string | null;
  content?: string | null | unknown;
};
```

`string | null | unknown` collapses to `unknown`, providing no type safety. The actual usage is:
- Plain text: `{ role: "user", content: "some prompt" }`
- Anthropic raw content blocks: `{ role: "assistant", content: [{ type: "text", text: "..." }] }`
- Anthropic tool results: `{ role: "user", content: [{ type: "tool_result", tool_use_id: "...", content: "..." }] }`

### The Fix

Define proper content block types and narrow the union:

```typescript
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

export type ContextMessage = {
  role?: string | null;
  content?: string | null | ContentBlock[];
};
```

### Call Sites to Update

1. `src/bot/replyPipeline.ts:679` — `Array<{ role: string; content: unknown }>` → `ContextMessage[]`
2. `src/bot/automationEngine.ts:441` — same
3. `src/bot/voiceReplies.ts:688` — same

Each file needs:
- Import `ContextMessage` (and possibly `ContentBlock`) from `../llm/serviceShared.ts`
- Change the array type annotation
- Verify the content being pushed matches `ContentBlock[]` shape

### Verification

Check that `generation.rawContent` (returned from LLM providers) matches the `ContentBlock[]` shape. If not, the `ContentBlock` type may need additional variants.

**Files changed:** `src/llm/serviceShared.ts`, `src/bot/replyPipeline.ts`, `src/bot/automationEngine.ts`, `src/bot/voiceReplies.ts`
**Risk:** Low — type narrowing with no logic change.
**Verification:** `bun run typecheck` + `bun run test`

---

## Phase 2: Split settingsNormalization.ts into Per-Section Files

### The Problem

`settingsNormalization.ts` is 1,668 lines. The `as any` casts are gone (typed section normalizers were added), but the file is still large. All 13 section normalizers live in one file.

### The Fix

Split into `src/store/normalize/` with one file per section:

```
src/store/settingsNormalization.ts          (~150 lines — orchestrator + shared primitive normalizers)
src/store/normalize/identity.ts
src/store/normalize/persona.ts
src/store/normalize/prompting.ts
src/store/normalize/permissions.ts
src/store/normalize/interaction.ts
src/store/normalize/agentStack.ts           (largest section)
src/store/normalize/memory.ts
src/store/normalize/directives.ts
src/store/normalize/initiative.ts
src/store/normalize/voice.ts
src/store/normalize/media.ts
src/store/normalize/music.ts
src/store/normalize/automations.ts
```

### Approach

1. Create `src/store/normalize/` directory
2. Move each `normalize*Section()` function into its own file
3. Move shared primitive normalizers (`normalizeString`, `normalizeBoolean`, `normalizeNumber`, `normalizeInt`, etc.) into `src/store/normalize/primitives.ts`
4. Move enum normalizers (`normalizeReplyPath`, `normalizeOperationalMessages`, etc.) into `src/store/normalize/enums.ts` or co-locate with the section that uses them
5. Keep `normalizeSettings()` in `settingsNormalization.ts` as the orchestrator — imports section normalizers, composes the result
6. Update the 10 files that import from `settingsNormalization.ts` — they should still import `normalizeSettings` from the same path (no breaking change)

### Decision: Co-locate Enum Normalizers or Separate?

Many enum normalizers are used by exactly one section (e.g., `normalizeReplyPath` is only used by the interaction section). Co-locating them with their section reduces imports. Shared ones (`normalizeModelBinding`, `normalizeExecutionPolicy`) go in a shared file.

**Recommendation:** Co-locate single-use normalizers, shared file for multi-use ones.

### File Sizing (estimated)

| File | Lines |
|------|-------|
| `settingsNormalization.ts` (orchestrator) | ~100 |
| `normalize/primitives.ts` | ~80 |
| `normalize/shared.ts` (model binding, execution policy) | ~150 |
| `normalize/identity.ts` | ~20 |
| `normalize/persona.ts` | ~30 |
| `normalize/prompting.ts` | ~50 |
| `normalize/permissions.ts` | ~40 |
| `normalize/interaction.ts` | ~180 |
| `normalize/agentStack.ts` | ~350 |
| `normalize/memory.ts` | ~60 |
| `normalize/directives.ts` | ~20 |
| `normalize/initiative.ts` | ~250 |
| `normalize/voice.ts` | ~250 |
| `normalize/media.ts` | ~100 |
| `normalize/music.ts` | ~30 |
| `normalize/automations.ts` | ~40 |
| **Total** | ~1,750 |

Slight growth from import boilerplate. No file exceeds 350 lines.

**Files changed:** `src/store/settingsNormalization.ts` (major reduction), new `src/store/normalize/*.ts` files
**Files NOT changed:** All 10 importers — `normalizeSettings` stays exported from the same path.
**Risk:** Low — pure file reorganization, no logic change.
**Verification:** `bun run typecheck` + `bun run test` (especially `settingsNormalization.test.ts`, `settingsFormModel.test.ts`)

---

## Estimated Effort

| Phase | Effort |
|-------|--------|
| 1 — ContextMessage type tightening | 1 session |
| 2 — Settings file split | 1–2 sessions |
| **Total** | **2–3 sessions** |

---

## File Ownership

This plan owns:
- `src/llm/serviceShared.ts` (ContextMessage type)
- `src/bot/replyPipeline.ts`, `src/bot/automationEngine.ts`, `src/bot/voiceReplies.ts` (type annotation updates only)
- `src/store/settingsNormalization.ts` and new `src/store/normalize/` directory

Do not touch:
- `src/voice/` (owned by voice cleanup plan)
- `src/bot.ts`
- `src/llm.ts` or other `src/llm/` files
- `dashboard/` (except if settingsFormModel.ts needs an import path update, which it shouldn't)
