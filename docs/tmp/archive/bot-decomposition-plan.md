# ClankerBot Decomposition Plan

**Date:** March 6, 2026
**Target:** `src/bot.ts` (5,428 lines, 90+ methods, 18 responsibility domains)
**Goal:** Reduce to a thin orchestrator + domain modules. No method on the class unless it genuinely needs instance state.

---

## Table of Contents

1. [Why This Is Easier Than Voice](#1-why-this-is-easier-than-voice)
2. [Current Domain Map](#2-current-domain-map)
3. [Target Architecture](#3-target-architecture)
4. [The BotContext Pattern](#4-the-botcontext-pattern)
5. [Phased Execution Plan](#5-phased-execution-plan)
6. [Verification Strategy](#6-verification-strategy)

---

## 1. Why This Is Easier Than Voice

The voice session manager is hard because of cross-cutting mutable state — 120 properties, boolean flags encoding implicit states, every subsystem reading every other subsystem's internals. The decomposition requires inventing new abstractions (OutputChannel, phase enums, command pattern).

`bot.ts` is fundamentally different. It's a **responsibility dumping ground**, not a state machine. The coupling is shallow:

- Most methods only read 1–3 `this.*` fields (typically `store`, `llm`, `client`)
- 21 methods use zero `this` — they're pure functions that happen to live on the class
- Another ~20 are thin delegation wrappers that pass `this` to already-extracted standalone functions
- The real mutable state is small: `lastBotMessageAt`, `discoveryPosting`, `textThoughtLoopRunning`, `automationCycleRunning`, `nextReflectionRunAt`, and queue/timer references
- Cross-domain calls are tree-shaped (no cycles) — Discovery/Automation call Memory/Budget/Media, not the other way around

This means the decomposition is **mechanical extraction**, not architectural redesign. Move methods to modules, pass dependencies as parameters, delete the delegation stubs.

---

## 2. Current Domain Map

### 18 domains, 90+ methods, 5,428 lines

| Domain | Methods | Lines | Coupling |
|--------|---------|-------|----------|
| A. Constructor + fields | 2 | 115 | Sets up everything |
| B. Event registration | 1 | 276 | Reads client, store, voiceSessionManager |
| C. Lifecycle | 8 | 177 | Manages timers, calls H/I/R |
| D. Reply queue | 13 | 95 | Already delegated to queueGateway.ts |
| E. Reply pipeline | 13 | 489 | Orchestrates replies, calls D/F/G/I/P/Q |
| F. Voice coordination | 5 | 333 | Builds runtime, delegates to voiceReplies.ts |
| G. Screen share | 7 | 518 | Reads screenShareSessionManager |
| H. Discovery/initiative | 17 | 676 | Highest fan-out: calls C/E/J/K/L/P/Q |
| I. Automation | 3 | 461 | High fan-out: calls C/E/J/K/L/Q |
| J. Memory/knowledge | 4 | 144 | Leaf: reads memory, store |
| K. Media generation | 6 | 238 | Reads llm, gifs; calls L |
| L. Budget/context | 14 | 390 | Reads store, llm, search, video; calls M |
| M. Image analysis | 6 | 219 | Reads imageCaptionCache, llm |
| N. Browser/code agents | 5 | 277 | Reads browserManager, llm, store |
| O. Dashboard API | 3 | 37 | Reads scattered state for snapshot |
| P. Permissions | 10 | 100 | Already delegated to replyAdmission.ts |
| Q. Message utilities | 8 | 277 | Reads store, client.user.id |
| R. Reflection | 1 | 25 | Reads store, memory |

### Cross-Domain Call Graph

```
B (Events) ──→ C, E, F, N, Q
C (Lifecycle) ──→ D, H, I, P, Q, R
D (Reply Queue) ──→ E
E (Reply Pipeline) ──→ D, F, G, I, P, Q
F (Voice) ──→ G, J, Q
G (Screen Share) ──→ F
H (Discovery) ──→ C, E, J, K, L, P, Q
I (Automation) ──→ C, E, J, K, L, Q
K (Media Gen) ──→ L
L (Budget) ──→ M
```

**Leaf domains (no outgoing calls):** J, M, N, R, Q, P
**Root orchestrators:** H (Discovery), I (Automation), E (Reply Pipeline)

---

## 3. Target Architecture

```
ClankerBot (orchestrator — event wiring, timer lifecycle, instance state)
│
├── src/bot/replyPipeline.ts          (already exists, needs typing)
├── src/bot/replyAdmission.ts         (already exists, needs typing)
├── src/bot/queueGateway.ts           (already exists, needs typing)
├── src/bot/voiceReplies.ts           (already exists, needs typing)
├── src/bot/discoverySchedule.ts      (already exists)
├── src/bot/startupCatchup.ts         (already exists)
├── src/bot/automationControl.ts      (already exists)
├── src/bot/mentions.ts               (already exists)
│
├── src/bot/permissions.ts            (NEW — extract from bot.ts)
├── src/bot/messageHistory.ts         (NEW — extract from bot.ts)
├── src/bot/budgetTracking.ts         (NEW — extract from bot.ts)
├── src/bot/mediaAttachment.ts        (NEW — extract from bot.ts)
├── src/bot/imageAnalysis.ts          (NEW — extract from bot.ts)
├── src/bot/screenShare.ts            (NEW — extract from bot.ts)
├── src/bot/discoveryEngine.ts        (NEW — extract from bot.ts)
├── src/bot/automationEngine.ts       (NEW — extract from bot.ts)
├── src/bot/textThoughtLoop.ts        (NEW — extract from bot.ts)
├── src/bot/agentTasks.ts             (NEW — extract from bot.ts)
├── src/bot/memorySlice.ts            (NEW — extract from bot.ts)
└── src/bot/voiceCoordination.ts      (NEW — extract from bot.ts)
```

### Target ClankerBot class (~800–1,200 lines)

After extraction, the class retains only:

1. **Constructor** — wires up dependencies, creates child modules
2. **Event registration** — `registerEvents()` dispatches to modules
3. **Timer lifecycle** — `start()` / `stop()` manage intervals
4. **Instance state** — the small set of genuinely mutable fields (`lastBotMessageAt`, `discoveryPosting`, etc.)
5. **Dashboard API** — `getRuntimeState()` aggregates state snapshots
6. **`handleMessage()`** — the message intake orchestrator (delegates to admission + pipeline)

Everything else moves to standalone modules.

---

## 4. The BotContext Pattern

Most extracted methods need 1–3 dependencies from `this`. Instead of passing them individually, define a `BotContext` that carries the shared service references:

```typescript
// src/bot/botContext.ts

export interface BotContext {
  readonly appConfig: AppConfig;
  readonly store: Store;
  readonly llm: LLMService;
  readonly memory: MemoryService;
  readonly client: DiscordClientLike;
  readonly botUserId: string;
}
```

The `ClankerBot` class implements this interface (or constructs it once in `start()`). Every extracted module receives `ctx: BotContext` as its first parameter instead of `bot: any`.

For modules that need additional specialized dependencies (e.g., media needs `gifs`, `video`; agents need `browserManager`), add module-specific context extensions:

```typescript
export interface MediaContext extends BotContext {
  readonly gifs: GifService;
  readonly video: VideoService;
}

export interface AgentContext extends BotContext {
  readonly browserManager: BrowserManager | null;
  readonly activeBrowserTasks: BrowserTaskRegistry;
  readonly subAgentSessions: SubAgentSessionManager;
}
```

This is the **single pattern** that replaces both the `bot: any` parameters in existing extracted modules and the verbose `this.*` reads in the methods being extracted.

---

## 5. Phased Execution Plan

### Ordering Rationale

Extract leaf domains first (no outgoing calls), then work inward toward the orchestrators. This way, each phase only depends on already-extracted modules.

```
Phase 0: Foundation (BotContext type, type existing modules)
Phase 1: Leaf extractions (permissions, message utils, memory, image analysis, agents, reflection)
Phase 2: Service extractions (budget tracking, media generation)
Phase 3: Orchestrator extractions (screen share, voice coordination)
Phase 4: Large orchestrator extractions (discovery, automation, text thought loop)
Phase 5: Clean up ClankerBot class
```

---

### Phase 0: Foundation

**Goal:** Define `BotContext`, type existing extracted modules, establish the pattern.

**Steps:**

1. Create `src/bot/botContext.ts` with the `BotContext` interface and extensions.

2. Type all existing `src/bot/*.ts` modules — replace `bot: any` with `BotContext`:
   - `replyPipeline.ts` — 5 functions with `bot: any` → `ctx: BotContext`
   - `queueGateway.ts` — 8 functions with `bot` (implicit any) → `ctx: BotContext`
   - `replyAdmission.ts` — fix misplaced import at bottom of file
   - `voiceReplies.ts` — type `runtime` parameter
   - `conversationContinuity.ts` — type parameters

3. Add `toBotContext(): BotContext` method on `ClankerBot` that returns `{ appConfig, store, llm, memory, client, botUserId: this.client.user?.id }`.

4. Update delegation stubs in `bot.ts` to pass `this.toBotContext()` instead of `this`.

**Files created:** `src/bot/botContext.ts` (~50 lines)
**Files changed:** `bot.ts` (add `toBotContext()`, update delegation calls), `replyPipeline.ts`, `queueGateway.ts`, `replyAdmission.ts`, `voiceReplies.ts`, `conversationContinuity.ts`
**Lines added:** ~100 (types)
**Risk:** Low — parameter rename with type addition.
**Verification:** `bun run typecheck` + `bun run test` (all 657 pass).

---

### Phase 1: Leaf Extractions

**Goal:** Extract the 6 leaf domains that have zero outgoing cross-domain calls. These are the easiest wins — pure functions or single-dependency methods.

#### 1a. Permissions → `src/bot/permissions.ts`

Move 10 methods (100 lines). Most are already 1-line delegations to `replyAdmission.ts`. The few with real logic (`isChannelAllowed`, `isReplyChannel`, `isDiscoveryChannel`, `isUserBlocked`) are pure functions of `(settings, id)`.

```typescript
// All pure — no BotContext needed, just settings + IDs
export function isChannelAllowed(settings: Settings, channelId: string, isDM: boolean): boolean;
export function isReplyChannel(settings: Settings, channelId: string): boolean;
export function isDiscoveryChannel(settings: Settings, channelId: string): boolean;
export function isUserBlocked(settings: Settings, userId: string): boolean;
```

**Lines moved:** ~100
**Risk:** Minimal — pure functions.

#### 1b. Message History → `src/bot/messageHistory.ts`

Move 8 methods (277 lines): `composeMessageContentForHistory`, `syncMessageSnapshot`, `syncMessageSnapshotFromReaction`, `recordReactionHistoryEvent`, `getImageInputs`, `getRecentLookupContextForPrompt`, `getConversationHistoryForPrompt`, `rememberRecentLookupContext`.

Plus 4 private helpers at the bottom of `bot.ts` (lines 5345–5428): `safeUrlHost`, `isLikelyImageUrl`, `parseHistoryImageReference`, `normalizeImageContentTypeFromExt`.

```typescript
export function composeMessageContentForHistory(message: Message, baseText: string): string; // pure
export function syncMessageSnapshot(ctx: BotContext, message: Message, settings: Settings): void;
export function getRecentLookupContextForPrompt(ctx: BotContext, ...): string;
export function rememberRecentLookupContext(ctx: BotContext, ...): void;
```

**Lines moved:** ~360
**Risk:** Low — `composeMessageContentForHistory` and `getImageInputs` are pure, the rest just need `store` and `botUserId`.

#### 1c. Memory Slice → `src/bot/memorySlice.ts`

Move 4 methods (144 lines): `loadPromptMemorySlice`, `buildMediaMemoryFacts`, `getScopedFallbackFacts`, `loadRelevantMemoryFacts`.

```typescript
export function buildMediaMemoryFacts(recentMessages: Message[], ...): string[]; // pure
export function loadRelevantMemoryFacts(ctx: BotContext, ...): Promise<string[]>;
export function loadPromptMemorySlice(ctx: BotContext, ...): Promise<PromptMemorySlice>;
```

**Lines moved:** ~144
**Risk:** Minimal — already mostly delegates to `memory/promptMemorySlice.ts`.

#### 1d. Image Analysis → `src/bot/imageAnalysis.ts`

Move 6 methods (219 lines): `extractHistoryImageCandidates`, `rankImageLookupCandidates`, `runModelRequestedImageLookup`, `captionRecentHistoryImages`, `getAutoIncludeImageInputs`, `mergeImageInputs`.

```typescript
export function rankImageLookupCandidates(...): ImageCandidate[]; // pure
export function getAutoIncludeImageInputs(...): ImageInput[]; // pure
export function mergeImageInputs(...): ImageInput[]; // pure
export function captionRecentHistoryImages(ctx: BotContext, cache: ImageCaptionCache, ...): Promise<void>;
export function runModelRequestedImageLookup(ctx: BotContext, cache: ImageCaptionCache, ...): Promise<ImageLookupResult>;
```

Note: `captionRecentHistoryImages` mutates `captionTimestamps` (rate limiting). Pass the timestamps array as a mutable ref, or encapsulate in the `ImageCaptionCache`.

**Lines moved:** ~219
**Risk:** Low — 3 are pure, rest need `llm` + `imageCaptionCache`.

#### 1e. Agent Tasks → `src/bot/agentTasks.ts`

Move 5 methods (277 lines): `runModelRequestedBrowserBrowse`, `runModelRequestedCodeTask`, `createCodeAgentSession`, `createBrowserAgentSession`, `buildSubAgentSessionsRuntime`.

```typescript
export function runModelRequestedBrowserBrowse(ctx: AgentContext, ...): Promise<BrowseResult>;
export function runModelRequestedCodeTask(ctx: AgentContext, ...): Promise<CodeResult>;
export function createCodeAgentSession(ctx: AgentContext, ...): CodeAgentSession;
export function createBrowserAgentSession(ctx: AgentContext, ...): BrowserAgentSession;
```

**Lines moved:** ~277
**Risk:** Low — already mostly delegates to `agents/*.ts`.

#### 1f. Reflection → keep inline (25 lines)

`maybeRunReflection` is 25 lines. Not worth a separate file. Keep it on the class.

**Phase 1 total:** ~1,100 lines extracted into 5 new files + typing 5 existing files. ClankerBot drops from 5,428 to ~4,300 lines.

---

### Phase 2: Service Extractions

**Goal:** Extract the service-layer domains that are called by multiple orchestrators.

#### 2a. Budget Tracking → `src/bot/budgetTracking.ts`

Move 14 methods (390 lines): all `get*BudgetState`, `getMediaGenerationCapabilities`, `isImageGenerationReady`, `isVideoGenerationReady`, `buildVideoReplyContext`, `buildWebSearchContext`, `buildBrowserBrowseContext`, `buildMemoryLookupContext`, `buildImageLookupContext`.

All of these read `store.countActionsSince()` and sometimes `llm`, `search`, `video`, `browserManager`. Define:

```typescript
export interface BudgetContext extends BotContext {
  readonly search: SearchService;
  readonly video: VideoService;
  readonly browserManager: BrowserManager | null;
  readonly imageCaptionCache: ImageCaptionCache;
}

export function getImageBudgetState(ctx: BudgetContext, settings: Settings): BudgetState;
export function buildVideoReplyContext(ctx: BudgetContext, ...): Promise<VideoContext>;
// ... etc
```

**Lines moved:** ~390
**Risk:** Low — read-only service methods with no mutable state.

#### 2b. Media Attachment → `src/bot/mediaAttachment.ts`

Move 6 methods (238 lines): `maybeAttachGeneratedImage`, `maybeAttachGeneratedVideo`, `maybeAttachReplyGif`, `buildMessagePayloadWithImage`, `buildMessagePayloadWithVideo`, `buildMessagePayloadWithGif`.

The media attachment cascade (check image, then video, then GIF) appears in 3 places (reply pipeline, discovery, automation). Extract a unified entry point:

```typescript
export interface MediaAttachmentResult {
  files?: AttachmentPayload[];
  imageUrl?: string;
  videoUrl?: string;
  gifUrl?: string;
}

export async function resolveMediaAttachment(
  ctx: MediaContext,
  settings: Settings,
  directive: MediaDirective,
  budgets: MediaBudgets
): Promise<MediaAttachmentResult>;
```

This replaces the duplicated if/else cascade with a single function. The three call sites (reply pipeline, discovery, automation) all call `resolveMediaAttachment` instead of repeating the pattern.

**Lines moved:** ~238, plus ~100 lines of duplicated cascade logic in discovery and automation become calls to the shared function.
**Risk:** Medium — touching three call sites. Test each one.

---

### Phase 3: Coordinator Extractions

**Goal:** Extract mid-complexity domains that coordinate between services.

#### 3a. Screen Share → `src/bot/screenShare.ts`

Move 7 methods (518 lines): `getVoiceScreenShareCapability`, `offerVoiceScreenShareLink`, `maybeHandleScreenShareOfferIntent`, `composeScreenShareOfferMessage`, `composeScreenShareUnavailableMessage`, `resolveOperationalChannel`, `sendToChannel`.

```typescript
export interface ScreenShareContext extends BotContext {
  readonly screenShareSessionManager: ScreenShareSessionManager;
  readonly voiceSessionManager: VoiceSessionManager;
}

export function getVoiceScreenShareCapability(ctx: ScreenShareContext, ...): ScreenShareCapability;
export async function offerVoiceScreenShareLink(ctx: ScreenShareContext, ...): Promise<void>;
```

**Lines moved:** ~518
**Risk:** Low — self-contained domain.

#### 3b. Voice Coordination → `src/bot/voiceCoordination.ts`

Move 5 methods (333 lines): `composeVoiceOperationalMessage`, `generateVoiceTurnReply`, `requestVoiceJoinFromDashboard`, `resolveDashboardVoiceJoinRequester`, `resolveDashboardVoiceJoinTextChannel`.

The key change: the `runtime` adapter object that `composeVoiceOperationalMessage` and `generateVoiceTurnReply` build verbatim (duplicated) gets built once in a shared helper:

```typescript
export function buildVoiceReplyRuntime(ctx: BotContext, ...): VoiceReplyRuntime {
  return {
    llm: ctx.llm,
    store: ctx.store,
    memory: ctx.memory,
    loadRelevantMemoryFacts: (payload) => loadRelevantMemoryFacts(ctx, payload),
    buildMediaMemoryFacts: (payload) => buildMediaMemoryFacts(payload),
    // ...
  };
}
```

This eliminates the duplicated runtime construction (flagged in the original review).

**Lines moved:** ~333
**Risk:** Low — already mostly delegates to `voiceReplies.ts`.

---

### Phase 4: Large Orchestrator Extractions

**Goal:** Extract the three big orchestrators: discovery, automation, text thought loop. These are the highest-fan-out methods and the hardest extractions because they call into many other domains.

#### 4a. Discovery Engine → `src/bot/discoveryEngine.ts`

Move 17 methods (676 lines). The big one is `maybeRunDiscoveryCycle` (371 lines) which contains the duplicated media attachment cascade.

```typescript
export interface DiscoveryContext extends MediaContext {
  readonly discovery: DiscoveryService;
}

export async function maybeRunDiscoveryCycle(
  ctx: DiscoveryContext,
  state: DiscoveryState,
  deps: {
    loadMemory: typeof loadRelevantMemoryFacts;
    budgets: typeof getMediaGenerationCapabilities;
    resolveMedia: typeof resolveMediaAttachment;
    permissions: typeof isChannelAllowed;
  }
): Promise<void>;
```

The `deps` parameter receives the already-extracted service functions, eliminating the need for `this.*` calls. The `state` parameter is a small mutable object: `{ posting: boolean }`.

After this extraction, `maybeRunDiscoveryCycle` drops from 371 lines to ~300 because the media cascade becomes a single `resolveMediaAttachment()` call.

**Lines moved:** ~676
**Risk:** Medium — highest fan-out method, but the cross-domain calls become explicit `deps.*` calls which is actually safer than implicit `this.*`.

#### 4b. Automation Engine → `src/bot/automationEngine.ts`

Move 3 methods (461 lines): `maybeRunAutomationCycle`, `runAutomationJob`, `generateAutomationPayload`.

Same pattern as discovery: explicit `deps` parameter for cross-domain calls, `state: { cycleRunning: boolean }` for mutable state.

`generateAutomationPayload` (294 lines) also has the duplicated media cascade — same `resolveMediaAttachment()` fix.

**Lines moved:** ~461
**Risk:** Medium — same as discovery.

#### 4c. Text Thought Loop → `src/bot/textThoughtLoop.ts`

Move 5 methods (~163 lines): `maybeRunTextThoughtLoopCycle`, `pickTextThoughtLoopCandidate`, `buildStoredMessageRuntime`, `getLatestRecentHumanMessage`, `isRecentHumanActivity`.

Small and self-contained.

**Lines moved:** ~163
**Risk:** Low.

---

### Phase 5: Clean Up ClankerBot

**Goal:** Remove all delegation stubs, finalize the class.

**Steps:**

1. Delete all thin wrapper methods that just forward to extracted modules.

2. Update `registerEvents()` to call extracted module functions directly instead of going through class methods.

3. Update `handleMessage()` to call extracted module functions directly.

4. Verify the class is under 1,200 lines.

5. Group remaining methods:
   - Constructor + field declarations (~120 lines)
   - `toBotContext()` (~10 lines)
   - `start()` + `stop()` + timer management (~100 lines)
   - `registerEvents()` (~276 lines — this stays because it wires Discord events to `this.client`)
   - `handleMessage()` (~100 lines — the message intake orchestrator)
   - `enqueueReplyJob()` (~56 lines — queue mutation needs `this.replyQueues`)
   - Dashboard API: `getRuntimeState()`, `getGuilds()`, `getGuildChannels()` (~37 lines)
   - `applyRuntimeSettings()`, `ingestVoiceStreamFrame()` (~21 lines)
   - `attachScreenShareSessionManager()` (~3 lines)
   - `maybeRunReflection()` (~25 lines)

6. Run full test suite + typecheck.

**Target ClankerBot:** ~800–1,000 lines.

---

## Line Count Projections

### Before

| File | Lines |
|------|-------|
| `src/bot.ts` | 5,428 |

### After

| File | Lines | Status |
|------|-------|--------|
| `src/bot.ts` (orchestrator) | ~900 | Reduced |
| `src/bot/botContext.ts` | ~50 | New |
| `src/bot/permissions.ts` | ~100 | New |
| `src/bot/messageHistory.ts` | ~360 | New |
| `src/bot/memorySlice.ts` | ~144 | New |
| `src/bot/imageAnalysis.ts` | ~219 | New |
| `src/bot/agentTasks.ts` | ~277 | New |
| `src/bot/budgetTracking.ts` | ~390 | New |
| `src/bot/mediaAttachment.ts` | ~250 | New |
| `src/bot/screenShare.ts` | ~518 | New |
| `src/bot/voiceCoordination.ts` | ~333 | New |
| `src/bot/discoveryEngine.ts` | ~620 | New |
| `src/bot/automationEngine.ts` | ~420 | New |
| `src/bot/textThoughtLoop.ts` | ~163 | New |
| `src/bot/replyPipeline.ts` | 1,226 | Existing (typed) |
| `src/bot/queueGateway.ts` | 407 | Existing (typed) |
| `src/bot/replyAdmission.ts` | 197 | Existing (typed) |
| `src/bot/voiceReplies.ts` | ~300 | Existing (typed) |
| `src/bot/conversationContinuity.ts` | 220 | Existing (typed) |
| Other existing bot/ files | ~400 | Existing |
| **Total** | ~6,494 | |

The total line count grows by ~1,000 lines (module boilerplate, BotContext type definitions, explicit dependency passing). But no file exceeds 1,226 lines, and the bot class itself drops from 5,428 to ~900. Every module is independently testable.

---

## 6. Verification Strategy

### Per-Phase

Every phase must pass before merging:

1. `bun run test` — all 657+ tests pass
2. `bun run typecheck` — zero errors
3. `bun run lint` — clean

### Critical Test Files

| Phase | Test Files to Watch |
|-------|-------------------|
| 0 (Foundation) | `bot.loop.test.ts`, `bot.helpers.test.ts`, `bot.replyDecisionPolicy.test.ts` |
| 1 (Leaf extractions) | `bot.helpers.test.ts` (composeMessageContentForHistory, image parsing), `bot.replyDecisionPolicy.test.ts` (permissions), `memory.ingest.test.ts` |
| 2 (Budget/media) | `bot.loop.test.ts` (full reply pipeline), `bot.replyDecisionPolicy.test.ts` |
| 3 (Screen share/voice) | `bot.loop.test.ts`, `voiceReplies.test.ts` |
| 4 (Discovery/automation) | `bot.loop.test.ts`, `discovery.test.ts`, `automation.test.ts` |
| 5 (Cleanup) | All of the above |

### New Tests to Add

As each module is extracted, add focused unit tests:

- `permissions.test.ts` — pure function tests for channel/user checks
- `budgetTracking.test.ts` — budget state computation with mock store
- `mediaAttachment.test.ts` — the unified cascade logic (replaces 3 duplicated paths)
- `imageAnalysis.test.ts` — ranking, caption rate limiting
- `agentTasks.test.ts` — task gating, session creation

---

## Estimated Effort

| Phase | Effort | Notes |
|-------|--------|-------|
| 0 — Foundation | 1 session | BotContext type, update existing modules |
| 1 — Leaf extractions | 2 sessions | 5 modules, straightforward moves |
| 2 — Service extractions | 1–2 sessions | Budget + media, includes cascade dedup |
| 3 — Coordinator extractions | 1 session | Screen share + voice coordination |
| 4 — Large orchestrators | 2–3 sessions | Discovery + automation + thought loop |
| 5 — Cleanup | 1 session | Delete stubs, verify final class size |
| **Total** | **8–10 focused sessions** | |

At your pace, 2–4 days.

---

## Comparison: bot.ts vs voiceSessionManager.ts

| Aspect | `bot.ts` | `voiceSessionManager.ts` |
|--------|----------|--------------------------|
| Size | 5,428 lines | 12,819 lines |
| Core problem | Responsibility dump | Implicit state machine |
| Cross-cutting state | Shallow (1–3 fields per method) | Deep (120 mutable properties) |
| Dependency graph | Tree (no cycles) | Mesh (circular reads) |
| New abstractions needed | BotContext (simple) | OutputChannel + phase enums + commands |
| Extraction approach | Mechanical move + type | Architectural redesign |
| Estimated effort | 8–10 sessions | 10–14 sessions |
| Risk level | Low–medium | Medium–high |

**Recommendation:** Do `bot.ts` first. It's faster, lower risk, and the BotContext pattern you establish here will inform the voice decomposition. The typing discipline you build in Phase 0 (replacing `bot: any` with `BotContext`) directly feeds into the voice plan's Phase 0 (typing the session interface).
