# Reply Decision & Conversation Context Flow

This document describes (1) the two-stage reply policy for text and voice, (2) the conversation context window each mode assembles before generation, and (3) how session state differs across API integrations.

## 0) Visual Flows (Text + Chat)

### Text reply sequence

![Text Reply Decision Sequence](diagrams/reply-decision-text-sequence.png)
<!-- source: docs/diagrams/reply-decision-text-sequence.mmd -->

### Text reply state machine

![Text Reply Decision State](diagrams/reply-decision-text-state.png)
<!-- source: docs/diagrams/reply-decision-text-state.mmd -->

### Voice chat reply sequence

![Voice Chat Reply Decision Sequence](diagrams/reply-decision-chat-sequence.png)
<!-- source: docs/diagrams/reply-decision-chat-sequence.mmd -->

### Voice chat reply state machine

![Voice Chat Reply Decision State](diagrams/reply-decision-chat-state.png)
<!-- source: docs/diagrams/reply-decision-chat-state.mmd -->

## 1) Stage A: Should we even attempt a reply?

### Text (`src/bot/replyAdmission.ts`, used by `src/bot.ts` + `src/bot/queueGateway.ts`)

`shouldAttemptReplyDecision(...)` allows text reply evaluation when either:

- the turn is address-triggered (`addressSignal.triggered`) or force-responded, or
- `permissions.allowInitiativeReplies` is enabled and the bot appears in the recent channel window.

Current addressing signal reasons:

- `direct`: explicit mention or reply-thread direct address.
- `name_exact`: exact bot-name token match.
- `name_alias`: exact match on a configured bot-name alias.
- `llm_direct_address`: LLM confidence classifier marked the turn as likely directed at the bot.
- `llm_decides`: no direct signal; deferred to LLM evaluation.

Important nuance: force-respond is only automatic for high-certainty direct signals; `llm_direct_address` does not auto-force (`shouldForceRespondForAddressSignal`).

The text path applies this admission gate before queueing and again right before generation, so non-addressed channel chatter does not continuously hit the main reply model.

### Voice (`src/voice/voiceSessionManager.ts`)

`evaluateVoiceReplyDecision(...)` is the admission gate. It combines:

- direct-address signal (`isVoiceTurnAddressedToBot` + direct-address confidence),
- low-signal filtering (`isLowSignalVoiceFragment` / wake-ping checks),
- focused-speaker + recent-bot-reply continuation windows,
- `voice.replyEagerness` gating for non-direct turns,
- a YES/NO classifier LLM (`voice.replyDecisionLlm`) when deterministic fast paths do not resolve the turn.

Fast-path allow reasons include `direct_address_fast_path`, `focused_speaker_followup`, and `bot_recent_reply_followup`. Fast-path deny reasons include `missing_transcript`, `bot_turn_open`, `low_signal_fragment`, and `eagerness_disabled_without_direct_address`.

If this stage returns `allow: false`, the bot does not speak for that turn.

## 2) Stage B: If admitted, should we still skip?

### Text

After Stage A passes, the main reply LLM runs with explicit `[SKIP]` support for non-required turns.

- Non-addressed turns: model can choose `[SKIP]`.
- Force-required turns: prompt marks reply as required (except safety refusal).
- `llm_direct_address` turns are admitted but not force-required, so they can still `[SKIP]`.

If the model output is empty (and no media-only payload is viable), the turn is also treated as skipped (`reply_skipped` with `empty_reply`/`empty_reply_after_media`).

So text keeps a second backstop: policy gate first, then model-level skip.

### Voice

- `stt_pipeline`: after Stage A, generation runs with `isEagerTurn` for non-direct turns; generation can still return `[SKIP]`/empty and produce no spoken reply.
- realtime + `voice.realtimeReplyStrategy = brain`: same second-stage generation/skip behavior as STT.
- realtime + `voice.realtimeReplyStrategy = native`: Stage A is the primary gate before forwarding audio to native realtime response creation (no local `[SKIP]` stage).

Join-window greetings are a special case: generation can be force-retried to avoid silence right after join.

## 3) Voice Modes & Session State

Three distinct voice paths exist. The critical architectural difference is **who does the thinking**.

| Aspect | STT Pipeline | Realtime + Brain (default) | Realtime + Native |
|---|---|---|---|
| **ASR** | Your own transcription (`voice.sttPipeline.transcriptionModel`) | Realtime API (OpenAI/xAI/Gemini/ElevenLabs) | Realtime API |
| **Thinking** | Your LLM (`voice.generationLlm`) | Your LLM (`voice.generationLlm`) | Realtime API |
| **TTS** | Your own synthesis (`voice.sttPipeline.ttsModel`) | Realtime API (`requestTextUtterance`) | Realtime API |
| **Context control** | Full — you build it | Full — you build it | Black box — server manages |
| **Skip backstop** | Yes (`[SKIP]`/empty) | Yes (`[SKIP]`/empty) | No — Stage A only |
| **Setting** | `voice.mode = stt_pipeline` | `voice.realtimeReplyStrategy = brain` | `voice.realtimeReplyStrategy = native` |

**STT Pipeline** and **Realtime + Brain** share the same generation path (`generateVoiceTurnReply` in `src/bot/voiceReplies.ts`). The only difference is the I/O layer: STT pipeline handles ASR and TTS locally, while realtime + brain delegates voice I/O to the realtime WebSocket API.

**Realtime + Native** bypasses local generation entirely. Audio is forwarded to the realtime API which handles ASR, reasoning, and TTS end-to-end. You lose context control and skip capability, but gain lower latency.

### Realtime + Brain flow

```
User speaks in Discord voice channel
    ↓
Realtime API (WebSocket) transcribes audio
    ↓
runRealtimeTurn() receives transcript
    ↓
evaluateVoiceReplyDecision() — Stage A
    ↓
resolveRealtimeReplyStrategy() → "brain"
    ↓
runRealtimeBrainReply() builds context (see §4)
    ↓
generateVoiceTurnReply() → calls LLM brain
    ↓
LLM returns text response
    ↓
requestTextUtterance() → sends text to realtime API
    ↓
Realtime API generates TTS audio → Discord
```

### Realtime API state

The realtime APIs (OpenAI, xAI, Gemini, ElevenLabs) maintain their own server-side conversation history over the WebSocket. In **brain mode**, this implicit server state accumulates but is not used for reasoning — the bot builds its own context and uses the realtime API only for voice I/O. In **native mode**, the server-side state *is* the conversation context, and there is no way to inspect or control it.

## 4) Conversation Context Windows

### What the LLM sees on each text reply

Built by `buildReplyPrompt()` in `src/prompts.ts`, called from `src/bot.ts`:

| Context slice | Source | Default limit |
|---|---|---|
| Recent channel messages | `store.getRecentMessages(channelId)` | `memory.maxRecentMessages` (default **35**) |
| Relevant searched messages | Semantic search triggered by query | Variable |
| Durable memory facts (user) | `memory.searchDurableFacts()` by user | Up to **10** facts |
| Durable memory facts (relevant) | `memory.searchDurableFacts()` by query | Up to **10** facts |
| Recent web lookups | Cached lookup results | Up to **6** with age tracking |
| System prompt | `buildSystemPrompt(settings)` | Full persona + directives |

The full `messages[]` array sent to the API includes `contextMessages` (recent channel history formatted as user/assistant turns) plus the new user prompt. For stateless providers (Anthropic, OpenAI text, xAI text), the entire array is sent every call. For `claude-code` provider, context is passed into a persistent brain session (see `docs/claude-code-brain-session-mode.md`).

### What the LLM sees on each voice turn (STT Pipeline + Realtime Brain)

Built by `runSttPipelineReply()` / `runRealtimeBrainReply()` in `src/voice/voiceSessionManager.ts`, generation in `src/bot/voiceReplies.ts`:

| Context slice | Source | Limit |
|---|---|---|
| Transcript (current turn) | ASR output (STT pipeline) or realtime API transcript event | `STT_REPLY_MAX_CHARS` = **1200** chars |
| Recent voice turns | `session.recentVoiceTurns` | `STT_CONTEXT_MAX_MESSAGES` = **10** turns |
| Participant roster | `getVoiceChannelParticipants(session)` | `REALTIME_CONTEXT_MEMBER_LIMIT` = **12** members |
| Durable memory facts | `memory.searchDurableFacts()` | `VOICE_MEMORY_CONTEXT_MAX_FACTS` = **24** facts |
| Stream watch brain context | `getStreamWatchBrainContextForPrompt()` — video keyframe observations | `brainContextMaxEntries` = **8** entries |
| Recent membership events | Join/leave events during session | Recent entries |
| Addressing/engagement state | `VoiceConversationContext` — engaged, direct-addressed, timing | Structured metadata |
| Soundboard candidates | Available sound effects | Formatted list |
| Session timing | Join window active, session age | Timing metadata |
| System prompt | `buildSystemPrompt(settings)` | Full persona + directives |

Each voice turn's `contextMessages` is built from `session.recentVoiceTurns` — an in-memory array of `{ role, userId, speakerName, text, at, addressing }` objects stored on the session. This array grows unbounded during the session but is sliced to the last 10 entries when building the LLM context.

### What the voice decision classifier sees

The admission classifier (`evaluateVoiceReplyDecision`) gets a smaller context window:

| Context slice | Limit |
|---|---|
| Recent voice turns | `VOICE_DECIDER_HISTORY_MAX_TURNS` = **8** turns |
| Current transcript | `REALTIME_CONTEXT_TRANSCRIPT_MAX_CHARS` = **420** chars |
| Participant roster | `REALTIME_CONTEXT_MEMBER_LIMIT` = **12** members |

### What Realtime Native mode sees

In native mode, the realtime API manages its own context internally. The bot sends:

- `session.update` with system `instructions` (persona prompt) at connection time
- Raw audio buffers via `appendInputAudioBuffer()` / `commitInputAudioBuffer()`

The API accumulates conversation items server-side. There is **no way to inspect, prune, or inject context** into this window from the bot side. The only observability comes from transcript events emitted by the API (`conversation.item.input_audio_transcription.completed`, `response.output_audio_transcript.delta`).

### Context limits reference

All voice constants are defined in `src/voice/voiceSessionManager.constants.ts`:

```
STT_CONTEXT_MAX_MESSAGES          = 10      # voice turns passed to brain LLM
STT_REPLY_MAX_CHARS               = 1200    # max chars per turn content
VOICE_DECIDER_HISTORY_MAX_TURNS   = 8       # turns passed to admission classifier
REALTIME_CONTEXT_TRANSCRIPT_MAX_CHARS = 420  # transcript chars for decision context
REALTIME_CONTEXT_MEMBER_LIMIT     = 12      # max participants in roster
VOICE_MEMORY_CONTEXT_MAX_FACTS    = 24      # durable facts for voice context
```

Text defaults are in `src/settings/settingsSchema.ts`:

```
memory.maxRecentMessages          = 35      # recent channel messages
```

## 5) Text Queue + Dispatch

Queue behavior before dispatch:

- Per-channel queue can coalesce burst messages from the same author using `activity.replyCoalesceWindowSeconds` and `activity.replyCoalesceMaxMessages`.
- Coalesced jobs share one reply attempt with combined `triggerMessageIds`.

Dispatch behavior after Stage A/B resolves to "send":

- Non-addressed turns always send as channel messages (`sent_message`).
- Direct/force-threaded turns in non-initiative channels send as replies (`sent_reply`).
- In initiative channels, threaded candidates use mixed routing (`shouldSendAsReply`): 65% reply, otherwise channel message.

## 6) Config semantics

- `activity.replyLevelInitiative` and `activity.replyLevelNonInitiative` are **eagerness signals**, not literal random percentages.
- `permissions.allowInitiativeReplies` controls whether non-addressed text turns can enter Stage A.
- `activity.replyCoalesceWindowSeconds` / `activity.replyCoalesceMaxMessages` control text burst coalescing before model calls.
- `replyFollowupLlm` (optional) can override provider/model for text follow-up regeneration passes.
- `voice.replyEagerness` biases the voice decision gate for non-direct turns.
- `voice.replyDecisionLlm.*` controls the voice admission classifier (`enabled`, provider/model, attempt count, prompts).
- `voice.realtimeReplyStrategy` decides realtime path shape: `brain` (local generation with skip backstop) vs `native` (admission-only gate then forward).

## 7) Observability

Useful logs for tuning:

- Text: `reply_skipped`, `sent_reply`, `sent_message`
- Voice admission: `voice_turn_addressing` (`allow`, `reason`, `directAddressed`, `llmResponse`, classifier model/provider, conversation context fields)
- Voice generation outcomes: `stt_pipeline_reply_spoken`, `realtime_reply_requested`, `realtime_reply_skipped`

These logs are the source of truth when diagnosing over-replying or missed replies.

### Context window observability gap

Currently there is no dashboard view that shows the assembled conversation context for a given turn. For **STT pipeline** and **realtime + brain** modes, the full context payload could be logged at the `generateVoiceTurnReply()` call site and exposed via dashboard API. For **realtime native**, observability is limited to transcript events — the internal server-side context is not accessible.

## 8) Latency-First Model Tuning

Model choices that matter most for turn latency:

- Text generation: `llm.provider` + `llm.model`.
- `replyFollowupLlm.enabled` + `replyFollowupLlm.provider/model`: can add a second generation pass after model-requested lookups (`webSearchQuery`, `memoryLookupQuery`, `imageLookupQuery`).
- Voice generation (STT + realtime brain): `voice.generationLlm.provider/model`.
- `voice.replyDecisionLlm.provider/model`: classifier model for ambiguous voice turns before the bot decides to speak.
- Voice runtime-specific levers depend on path: realtime native uses `voice.openaiRealtime.model` / `voice.geminiRealtime.model`; STT + brain paths use `voice.sttPipeline.transcriptionModel` + `voice.sttPipeline.ttsModel`.

Model choice with lower immediate impact:

- `memoryLlm.provider/model`: used for memory extraction on ingest; this is not on the synchronous text reply critical path.

When tuning, check reply performance phases (`llm1Ms`, `followupMs`) and voice `voice_turn_addressing` logs before/after each model change.
