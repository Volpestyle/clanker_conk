# Reply Decision Flow (Text + Voice)

This document describes the current two-stage reply policy and how text and voice differ at execution time.

## 1) Stage A: Should we even attempt a reply?

### Text (`src/bot/replyAdmission.ts`, called from `src/bot.ts`)

`shouldAttemptReplyDecision(...)` opens the reply loop when either:

- the turn is direct-addressed (`addressSignal.triggered`) or force-responded, or
- initiative replies are allowed and the bot has spoken in the recent context window.

For non-addressed turns, this prevents running the main reply LLM on every message in busy channels.

### Voice (`src/voice/voiceSessionManager.ts`)

`evaluateVoiceReplyDecision(...)` is the admission gate. It combines:

- direct-address signal from wake-word matching (`isVoiceTurnAddressedToBot`)
- low-signal filtering
- focused-speaker continuation logic
- `voice.replyEagerness`
- a small YES/NO classifier LLM for ambiguous turns

If this stage returns `allow: false`, the bot does not speak for that turn.

## 2) Stage B: If admitted, should we still skip?

### Text

After Stage A passes, the main reply LLM runs with explicit `[SKIP]` support for non-required turns.

- Non-addressed turns: model can choose `[SKIP]`.
- Force/direct turns: prompt marks reply as required (except safety refusal).

So text keeps a second backstop: policy gate first, then model-level skip.

### Voice

- `stt_pipeline`: after Stage A, generation runs with `isEagerTurn` for non-direct turns; the generation prompt can still output `[SKIP]`.
- `openai_realtime` / `gemini_realtime`: Stage A is the primary gate before audio is forwarded to realtime response creation.

So voice is stricter on admission in realtime modes, while STT mode mirrors text more closely with an extra `[SKIP]` backstop.

## 3) Text dispatch mode

After text Stage A/B resolves to "send":

- Direct/force turns are sent as threaded replies.
- Non-addressed turns are sent as channel-level messages (`sent_message`), including in non-initiative channels.
- In initiative channels, direct/force turns may still be sent as replies or channel-level messages.

## 4) Config semantics

- `activity.replyLevelInitiative` and `activity.replyLevelNonInitiative` are **eagerness signals**, not literal random percentages.
- `permissions.allowInitiativeReplies` controls whether non-addressed text turns can enter Stage A.
- `replyFollowupLlm` (optional) can override provider/model for text follow-up regeneration passes.
- `voice.replyEagerness` biases the voice decision gate for non-direct turns.

## 5) Observability

Useful logs for tuning:

- Text: `reply_skipped`, `sent_reply`, `sent_message`
- Voice: `voice_turn_addressing` (`allow`, `reason`, `directAddressed`, `llmResponse`)

These logs are the source of truth when diagnosing over-replying or missed replies.
