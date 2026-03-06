# Voice Session Manager Final Cleanup Plan

**Date:** March 6, 2026
**Target:** `src/voice/` — voiceSessionManager.ts (7,713 lines), voiceMusicPlayback.ts (32 `manager: any`), voiceReplyDecision.ts (7 `manager: any`), ~30 fire-and-forget patterns
**Goal:** Prune delegation stubs, eliminate all `manager: any` params, audit fire-and-forget patterns.

---

## Current State

The voice decomposition extracted 9 new modules (replyManager, bargeInController, captureManager, turnProcessor, thoughtEngine, deferredActionQueue, greetingManager, instructionManager, sessionLifecycle). But the orchestrator still has delegation stubs and two major files still use `manager: any`.

| Metric | Value |
|--------|-------|
| `voiceSessionManager.ts` | 7,713 lines |
| `manager: any` in voiceMusicPlayback.ts | 32 occurrences |
| `manager: any` in voiceReplyDecision.ts | 7 occurrences |
| `.catch(() => undefined)` in voice files | ~30 |
| Target VSM size | ~4,000–5,000 lines |

---

## Phase 1: Type `manager: any` in voiceMusicPlayback.ts (32 occurrences)

The music playback module calls back into the session manager for:
- Output lock state queries (`manager.getReplyOutputLockState()`)
- Activity touches (`manager.touchActivity()`)
- Deferred action rechecks (`manager.recheckDeferredVoiceActions()`)
- Session state reads (`manager.session.*`)
- Logging (`manager.store.logAction()`)

**Approach:** Define a `MusicPlaybackHost` interface that exposes only what the music module actually needs:

```typescript
export interface MusicPlaybackHost {
  getOutputChannelState(session: VoiceSession): OutputChannelState;
  touchActivity(session: VoiceSession): void;
  recheckDeferredVoiceActions(session: VoiceSession, reason: string): void;
  logAction(session: VoiceSession, action: string, detail?: Record<string, unknown>): void;
  // ... only the methods actually called
}
```

Replace all 32 `manager: any` with `manager: MusicPlaybackHost`.

**Files changed:** `voiceMusicPlayback.ts`
**Risk:** Low — parameter type narrowing, no logic change.

---

## Phase 2: Type `manager: any` in voiceReplyDecision.ts (7 occurrences)

Same pattern — define a `ReplyDecisionHost` interface.

**Files changed:** `voiceReplyDecision.ts`
**Risk:** Low.

---

## Phase 3: Prune delegation stubs from voiceSessionManager.ts

The session manager still has thin wrapper methods that just forward to extracted modules. These exist to preserve test compatibility and existing call sites.

**Approach:**
- Audit every method on the session manager — identify which are pure delegation (call `this.<module>.method()` with no additional logic)
- For runtime callers: migrate to `manager.<module>` access (e.g., `manager.replyManager.getOutputLockState()` instead of `manager.getReplyOutputLockState()`)
- For test callers: update test helpers to call modules directly where appropriate
- Delete the dead stubs
- Keep methods that are genuine orchestration (coordinate multiple modules, route events)

**Target:** Reduce voiceSessionManager.ts from 7,713 to ~4,000–5,000 lines.

**Files changed:** `voiceSessionManager.ts`, possibly test files that call the removed stubs
**Risk:** Medium — must ensure all callers are migrated before deleting stubs.

---

## Phase 4: Fire-and-forget audit (~30 patterns in voice files)

**Triage by category:**

| Category | Action |
|----------|--------|
| Cleanup/teardown (session end, disconnect, timer clear) | **Keep** — errors during cleanup are expected |
| Voice state mutations (drain, flush, sync) | **Audit** — some may mask real bugs |
| Discord/external API calls (send message, edit) | **Log** — `.catch(err => log.warn("...", { err }))` |

**Files to audit:**
- `voiceSessionManager.ts` (~20 patterns)
- `voiceToolCalls.ts` (~3)
- `voiceAsrBridge.ts` (~4)
- `voiceMusicPlayback.ts` (~1)
- `voiceJoinFlow.ts` (~1)
- `voiceStreamWatch.ts` (~1)

**Risk:** Minimal — adding logging, not changing behavior.

---

## Verification

Per-phase:
1. `bun run typecheck` — zero errors
2. `bun run test` — all 702+ tests pass
3. `bun run lint` — clean (at minimum `bunx eslint` on changed files)

---

## Estimated Effort

| Phase | Effort |
|-------|--------|
| 1 — Type voiceMusicPlayback.ts | 1 session |
| 2 — Type voiceReplyDecision.ts | 30 min |
| 3 — Prune delegation stubs | 1–2 sessions |
| 4 — Fire-and-forget audit | 1 session |
| **Total** | **3–4 sessions** |

---

## File Ownership

This plan owns `src/voice/` exclusively. Do not touch:
- `src/bot.ts` or `src/bot/`
- `src/llm.ts` or `src/llm/`
- `src/store/`
- `src/settings/`
- `dashboard/`
