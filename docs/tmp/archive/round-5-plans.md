# Round 5 Plans

**Date:** March 6, 2026
**Baseline:** 712 tests, 0 `:any` (production), typecheck clean
**Focus:** Unified voice reply pipeline + unit tests for extracted modules

---

## Plan A: Unified Voice Reply Pipeline

**Goal:** Replace `runSttPipelineReply` (312 lines) and `runRealtimeBrainReply` (461 lines) with a single parameterized `runVoiceReplyPipeline` (~350-400 lines). Extract to `src/voice/voiceReplyPipeline.ts`. Net savings: ~250-350 lines from VSM.

### Why this matters architecturally

The voice-provider-abstraction doc defines three reply paths (Native, Bridge, Brain) and the preset-driven-agent-stack spec says "voice is a capability runtime, not a reason to keep the entire bot multi-provider by default." Having two separate 300-400 line methods that encode the same pipeline with different provider wiring hardcoded inline is exactly the "provider choice leaks into too many runtime branches" problem the spec identifies.

### Structural analysis

32 logical steps were identified across both methods. Of those:

- **12 steps are IDENTICAL** between the methods
- **9 steps are SIMILAR** (differ only in source strings or minor structural placement)
- **3 steps are DIFFERENT** (guard clauses, empty-plan handling, post-playback state)
- **8 steps are EXCLUSIVE to realtime** (latency, interruption policy, forced retry, instruction manager, TTS mode)
- **1 step is EXCLUSIVE to STT** (post-generation session.ending check — a safety check realtime should also have)

### Design

#### New file: `src/voice/voiceReplyPipeline.ts`

```typescript
export interface VoiceReplyPipelineParams {
  session: VoiceSession;
  settings: Settings;
  userId: string;
  transcript: string;
  directAddressed?: boolean;
  directAddressConfidence?: number;
  conversationContext?: VoiceConversationContext | null;

  // Mode-specific params
  mode: "brain" | "bridge";
  source?: string;                    // defaults to mode name
  inputKind?: string;                 // only used by bridge mode
  latencyContext?: LatencyContext | null;  // only used by bridge mode
  forceSpokenOutput?: boolean;        // only used by bridge mode
  spokenOutputRetryCount?: number;    // only used by bridge mode
}

export interface VoiceReplyPipelineHost {
  // Generation
  generateVoiceTurn: (...) => Promise<GeneratedPayload>;

  // Playback
  playVoiceReplyInOrder: (...) => Promise<PlaybackResult>;
  buildVoiceReplyPlaybackPlan: (...) => PlaybackPlan;

  // Context builders (already extracted or extractable)
  buildVoiceConversationContext: (...) => VoiceConversationContext;
  getVoiceChannelParticipants: (...) => VoiceParticipant[];
  getRecentVoiceMembershipEvents: (...) => MembershipEvent[];

  // State management
  updateModelContextSummary: (...) => void;
  recordVoiceTurn: (...) => void;
  // Interruption policy — uses normalized policy shape from bargeInController.ts
  // (assertive/scope/allowedUserId/reason/source — see voice-interruption-policy.md)
  setActiveReplyInterruptionPolicy: (...) => void;
  maybeClearActiveReplyInterruptionPolicy: (...) => void;

  // Extracted module functions (already available)
  // ... addressing, soundboard, config, latency, etc.

  // Session lifecycle
  endSession: (...) => Promise<void>;
  waitForLeaveDirectivePlayback: (...) => Promise<void>;

  // Logging
  logVoiceRuntimeEvent: (...) => void;

  // Instruction manager (bridge mode only)
  instructionManager?: { prepareRealtimeTurnContext: (...) => Promise<void> };

  // LLM (brain mode only — for TTS synthesis check)
  llm?: { synthesizeSpeech?: (...) => Promise<Buffer> };
}

export async function runVoiceReplyPipeline(
  host: VoiceReplyPipelineHost,
  params: VoiceReplyPipelineParams
): Promise<boolean> {
  // ... unified pipeline
}
```

#### Pipeline structure (32 steps collapsed to ~20):

```
1.  Guard clauses (parameterized by mode; output lock check uses assistantOutput.phase, not legacy botTurnOpen)
2.  Normalize transcript
3.  Build context turns + dedup last turn
4.  Compute context char count + model context summary
5.  Resolve soundboard candidates
6.  Resolve conversation context
7.  Build participant roster + membership events
8.  Compute timing context
9.  [if bridge] Normalize latency context
10. Call generateVoiceTurn (parameterized: inputKind, source)
11. Process generated payload + normalize result fields
12. Voice addressing annotation
13. [if bridge] Build reply interruption policy (normalizeReplyInterruptionPolicy from bargeInController.ts)
14. [if bridge && forceSpokenOutput && empty reply] Retry with forced prompt
15. Build playback plan
16. Handle empty playback plan (always log, realtime pattern)
17. [if bridge] Instruction manager turn context prep
18. [if bridge] Build latency context for reply + set interruption policy
19. Compute TTS mode (brain: always API; bridge: from settings)
20. Call playVoiceReplyInOrder (parameterized: preferRealtimeUtterance, interruptionPolicy, latencyContext)
21. Handle interrupted playback
22. [if bridge] Log latency stage
23. Post-playback state updates (assistantOutput phase transitions; gated on requestedRealtimeUtterance)
24. Log runtime event (parameterized event name + metadata)
25. Handle leave voice channel directive
```

#### Key design decisions:

1. **Return type:** Always `boolean`. Brain mode returns `true` on success (aligns with realtime pattern; STT currently returns void but nothing reads the return).

2. **Source string:** Derived from `params.source ?? params.mode`. All log strings use this consistently — no more hardcoded `"stt_pipeline"` vs `"realtime"`.

3. **Latency tracking:** Conditional on `params.latencyContext` being non-null. Brain mode simply doesn't pass it. No runtime cost when unused.

4. **Interruption policy:** Conditional on `params.mode === "bridge"`. Brain mode skips it entirely. Policy normalization lives in `bargeInController.ts` — import `normalizeReplyInterruptionPolicy` from there, don't inline it.

5. **Post-generation session.ending check:** ADDED for both modes (STT had it, realtime didn't — it's a safety check).

6. **Empty-plan logging:** Always log rich diagnostics (realtime's pattern). STT's silent return was a debugging blind spot.

7. **Post-playback try/catch:** Always wrap (STT's pattern). Realtime's lack of error boundary was a bug.

8. **Forced spoken output retry:** Conditional on `params.forceSpokenOutput`. Only bridge mode uses this.

### Callers

Two callers in voiceSessionManager.ts need updating:

1. **Where `runSttPipelineReply` was called** — replace with `runVoiceReplyPipeline(this, { mode: "brain", ... })`
2. **Where `runRealtimeBrainReply` was called** — replace with `runVoiceReplyPipeline(this, { mode: "bridge", ... })`

The `flushDeferredBotTurnOpenTurns` method dispatches to both — it'll just switch on the pipeline mode.

### Reference docs (read before implementing):
- `docs/voice-provider-abstraction.md` — pipeline stages, reply paths (Native/Bridge/Brain), output lock via `assistantOutput` state machine
- `docs/voice-interruption-policy.md` — barge-in policy object shape, normalization in `bargeInController.ts`, noise rejection gates (4 gates, not 6 — low-signal fallback and idle hallucination guard were removed)
- `docs/voice-output-state-machine.md` — canonical `assistantOutput.phase` lifecycle

### File ownership (STRICT):
- **OWNS:** `src/voice/voiceSessionManager.ts`, `src/voice/voiceReplyPipeline.ts` (new)
- **MAY READ:** `src/voice/voiceSessionTypes.ts` (for type imports), `src/voice/bargeInController.ts` (for interruption policy imports)
- **MUST NOT MODIFY:** `src/bot.ts`, `src/bot/*`, `src/store/*`, `src/dashboard/*`, any other `src/voice/` files

### Expected result:
- VSM: 5,666 → ~5,100 lines (-550 from removing two methods, adding ~20 lines of delegation)
- New file: `voiceReplyPipeline.ts` ~350-400 lines
- All 712 tests pass

---

## Plan B: Unit Tests for Pure-Function Modules

**Goal:** Write unit tests for the 4 pure-function extracted modules. These require no mocks — just input/output verification.

### Target modules:

| Module | Lines | What to test |
|--------|-------|-------------|
| `voiceAddressing.ts` | 277 | normalizeVoiceAddressingAnnotation, mergeVoiceAddressingAnnotation, findLatestVoiceTurnIndex, annotateLatestVoiceTurnAddressing, buildVoiceAddressingState |
| `voiceAudioAnalysis.ts` | 110 | analyzeMonoPcmSignal (RMS, peak, active ratio), evaluatePcmSilenceGate (threshold logic), estimatePcm16MonoDurationMs, estimateDiscordPcmPlaybackDurationMs |
| `voiceConfigResolver.ts` | 227 | shouldUsePerUserTranscription, shouldUseSharedTranscription, shouldUseRealtimeTranscriptBridge, resolveRealtimeReplyStrategy, isAsrActive — test each with different settings combinations |
| `voiceLatencyTracker.ts` | 161 | computeLatencyMs, buildVoiceLatencyStageMetrics — pure timestamp math |

### File ownership (STRICT):
- **OWNS:** New test files: `src/voice/voiceAddressing.test.ts`, `src/voice/voiceAudioAnalysis.test.ts`, `src/voice/voiceConfigResolver.test.ts`, `src/voice/voiceLatencyTracker.test.ts`
- **MUST NOT MODIFY:** Any production files

---

## Plan C: Unit Tests for Host-Interface Modules

**Goal:** Write unit tests for the 5 host-interface extracted modules. These require lightweight mock host objects.

### Target modules:

| Module | Lines | What to test |
|--------|-------|-------------|
| `voiceSoundboard.ts` | 326 | normalizeSoundboardRefs, fetchGuildSoundboardCandidates (mock Discord API), resolveSoundboardCandidates, maybeTriggerAssistantDirectedSoundboard (mock host) |
| `voiceMusicDisambiguation.ts` | 441 | resolvePendingMusicDisambiguationSelection (mock session state), isMusicDisambiguationResolutionTurn, completePendingMusicDisambiguationSelection (mock host), getMusicPromptContext |
| `voiceThoughtGeneration.ts` | 597 | generateVoiceThoughtCandidate (mock LLM), evaluateVoiceThoughtDecision (mock LLM — test allow/reject/parse-failure), resolveVoiceThoughtEngineConfig (mock settings) |
| `voiceRuntimeSnapshot.ts` | 575 | buildVoiceRuntimeSnapshot — test with mock sessions and verify output shape/completeness |
| `botRuntimeFactories.ts` | 566 | buildBotContext, buildReplyPipelineRuntime, buildQueueGatewayRuntime — verify correct field mapping from mock ClankerBot |

### File ownership (STRICT):
- **OWNS:** New test files: `src/voice/voiceSoundboard.test.ts`, `src/voice/voiceMusicDisambiguation.test.ts`, `src/voice/voiceThoughtGeneration.test.ts`, `src/voice/voiceRuntimeSnapshot.test.ts`, `src/bot/botRuntimeFactories.test.ts`
- **MUST NOT MODIFY:** Any production files

---

## Concurrency Matrix

| | Plan A (pipeline unify) | Plan B (pure tests) | Plan C (host tests) |
|---|---|---|---|
| **Plan A** | — | Safe concurrent | Safe concurrent |
| **Plan B** | Safe concurrent | — | Safe concurrent |
| **Plan C** | Safe concurrent | Safe concurrent | — |

All three can run concurrently. Plan A modifies production code in VSM only. Plans B and C create test files only.

### Merge order:
1. **B first** (pure-function tests — no conflicts possible)
2. **C second** (host-interface tests — no conflicts possible)
3. **A last** (pipeline unification — modifies VSM)
