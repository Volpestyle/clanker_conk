# Realtime vs Full-Brain Parity Plan

## Goal

Bring provider-native realtime voice behavior closer to the full-brain/orchestrator path without a rewrite.

## Current Assessment

- Tool access is fairly close to parity.
- Screen watch start/use is fairly close to parity.
- Context richness, memory behavior, reasoning quality, and debugging visibility are not yet in parity.
- Same tools does not currently mean same judgment.

## Recommended Plan

### 1. Unify turn context first

Build one shared voice turn context layer used by both full-brain and provider-native paths.

Include:

- active sharers
- screen-watch notes
- membership events
- memory slice
- recent tool outcomes
- music state
- addressing context

Primary integration targets:

- `src/bot/voiceReplies.ts`
- `src/voice/voiceReplyPipeline.ts`
- realtime instruction refresh / provider-native tool path

### 2. Make screen-watch context identical

Provider-native should receive the same screen-watch capability summary and rolling note buffer the brain path sees, not just `start_screen_watch`.

Expose the same view of:

- who is sharing
- who can be watched
- what notes already exist
- what screen-watch state is active now

This is likely the most user-visible parity win.

### 3. Normalize tool loop semantics

Keep one canonical tool descriptor set and one canonical tool-result summary shape for both paths.

After provider-native tool execution, inject a compact structured result summary back into live context so follow-up reasoning matches brain behavior more closely.

Goal:

- same tools
- same result understanding
- same retry/failure behavior

### 4. Bring memory loading into parity

Make provider-native use the same continuity and behavioral-memory policy as the full-brain path where feasible.

Even if transport differs, memory selection should not.

This improves:

- follow-up coherence
- identity continuity
- room-state awareness

### 5. Unify capability logging and operator replay

Add the same capability snapshots and decision breadcrumbs to provider-native turns that the full-brain path already emits.

Especially:

- screen watch capability
- tool availability
- selected target
- memory load summary
- post-tool result summary

This reduces cases where behavior differs but the reason is unclear.

### 6. Add parity golden tests

Create side-by-side scenarios that run under both:

- `replyPath="brain"`
- provider-native realtime tool ownership

Start with:

- watch X's stream
- search and answer
- tool failure recovery
- follow-up after recent bot reply
- multi-speaker interruption and resume

## Recommended Order

1. Shared turn context
2. Screen-watch parity
3. Tool-result parity
4. Memory parity
5. Logging/replay parity
6. Golden parity suite

## Impact vs Effort

### High impact / medium effort

- shared turn context
- screen-watch parity

### High impact / low-medium effort

- logging parity

### Medium-high impact / medium effort

- tool-result parity

### High impact / higher effort

- memory parity

### Critical for safety

- golden parity tests

## Suggested First Implementation Pass

Extract a shared builder for:

- active stream roster
- screen-watch capability
- rolling screen notes
- recent room events
- compact memory slice

Then consume it from both:

- `src/bot/voiceReplies.ts`
- realtime instruction refresh / provider-native tool path

## Product Language

Make both paths see the same room before asking them to behave the same.
