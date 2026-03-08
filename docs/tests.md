# Tests

## Default Test Commands

- `bun run test` runs the default unit and integration suite and excludes `.live.test.ts` files.
- `bun run test:e2e` runs the Discord E2E suite.
- `bun run test:e2e:voice` runs the voice E2E suite.
- `bun run test:e2e:text` runs the text E2E suite.

## Live LLM Tests

These tests make real model calls or use real model CLIs, so they can cost money or consume quota.

### Shared Voice Coverage

The active voice live suites share a single source of truth:

- `tests/live/shared/voiceLiveScenarios.ts`

Current shared voice catalog size:

- `91` scenarios total
- `8` scenario groups
- Running both active voice suites exercises those same `91` scenarios twice: once in `voiceAdmission.live.test.ts` and once in the voice section of `replyGeneration.live.test.ts`
- Voice generation expectations are now exact for `82` of those `91` shared scenarios
- The remaining `9` generation `either` cases are raw room-event cues, where admission may allow but the brain is still intentionally free to speak or `[SKIP]`

Current group breakdown:

- `name detection fast-paths`: `4`
- `join events`: `9`
- `music commands`: `4`
- `clear engagement`: `18`
- `contextual engagement`: `13`
- `stays quiet`: `15`
- `music wake latch`: `7`
- `eagerness sweeps`: `21`

Coverage assessment:

- Good breadth for admission and generation behavior across name detection, unsolicited participation, joins, music control, silence cases, and eagerness thresholds
- Good alignment because admission and generation now consume the same voice inputs instead of drifting into separate hand-written suites
- The voice generation prompt now relies on transcript plus contextual guidance such as membership events, room context, and fuzzy bot-name cues instead of a dedicated join-state prompt flag
- Still not full-stack realtime coverage: these tests do not validate websocket/session transport, ASR streaming, TTS audio output, Discord timing, or end-to-end voice latency
- Still not a full provider matrix by default: the scenarios are broad, but we do not automatically run every scenario against every provider/model combination

### Structured Reply Live Test (Generation LLM only — no classifier)

This exercises the real structured reply contract for both text and voice generation.
It tests the **generation LLM brain only** — the classifier admission pipeline is NOT involved.
Each scenario builds a full generation prompt (`buildSystemPrompt` + `buildVoiceTurnPrompt`)
and sends it directly to the LLM via `llm.generate()`, then asserts whether the structured
output is a real spoken reply or `[SKIP]`.

This answers: "Given this context, does the generation LLM produce the right reply-vs-skip decision?"

The voice section uses the shared voice live scenario catalog that is also consumed by `tests/live/voiceAdmission.live.test.ts`, so both suites cover the same voice situations.

The text section also covers:

- tool selection for `web_search`, `web_scrape`, `conversation_search`, and `adaptive_directive_add`
- a vision turn with inline image input
- raw structured-output validity for representative reply and skip cases

Defaults:

- Text provider defaults to `claude-oauth`
- Voice provider defaults to `claude-oauth`
- The suite includes a small eagerness sweep for both text and voice so we validate low-vs-high participation behavior, not just one-off direct-address cases
- Tool-selection subtests are skipped automatically for providers without tool-call support
- Vision subtests are skipped automatically for providers without multimodal image support

```sh
bun test tests/live/replyGeneration.live.test.ts
```

You can target different providers/models per path:

```sh
TEXT_LLM_PROVIDER=claude-oauth TEXT_LLM_MODEL=claude-sonnet-4-6 \
VOICE_LLM_PROVIDER=claude-oauth VOICE_LLM_MODEL=claude-sonnet-4-6 \
bun test tests/live/replyGeneration.live.test.ts
```

```sh
TEXT_LLM_PROVIDER=openai TEXT_LLM_MODEL=gpt-5-mini \
VOICE_LLM_PROVIDER=anthropic VOICE_LLM_MODEL=claude-haiku-4-5 \
OPENAI_API_KEY=... ANTHROPIC_API_KEY=... \
bun test tests/live/replyGeneration.live.test.ts
```

You can also filter to only one side:

```sh
LIVE_REPLY_FILTER=voice bun test tests/live/replyGeneration.live.test.ts
LIVE_REPLY_FILTER=text bun test tests/live/replyGeneration.live.test.ts
```

Debug visibility:

- `LIVE_REPLY_DEBUG=1` prints provider/model, system prompt, user prompt, raw model output, parsed structured text, and any returned tool calls

### Voice Admission Live Test (Classifier + fast-paths — no generation)

This is the active end-to-end admission suite for voice reply gating. It tests the
**classifier pipeline** — name detection fast-paths plus the YES/NO LLM classifier —
via `evaluateVoiceReplyDecision()`. The generation LLM is NOT involved.

The classifier LLM returns YES or NO. The admission pipeline wraps that into allow/deny
(along with deterministic fast-paths that can allow/deny before the classifier runs).
Each scenario asserts on the final `allow`/`deny` outcome.

This answers: "Given this context, does the admission pipeline (fast-paths + classifier) correctly gate the turn?"

It uses the same shared scenario corpus as the voice section of `replyGeneration.live.test.ts`.

Defaults:

- Classifier provider defaults to `claude-oauth`
- The suite covers the shared name-detection, join-event, music, contextual, and eagerness scenarios

```sh
bun test tests/live/voiceAdmission.live.test.ts
```

```sh
CLASSIFIER_PROVIDER=claude-oauth CLASSIFIER_MODEL=claude-haiku-4-5 VOICE_ADMISSION_DEBUG=0 bun test tests/live/voiceAdmission.live.test.ts
```

```sh
CLASSIFIER_PROVIDER=claude-oauth CLASSIFIER_MODEL=claude-haiku-4-5 LABEL_FILTER="event: another person joins" VOICE_ADMISSION_DEBUG=1 bun test tests/live/voiceAdmission.live.test.ts
```

Debug visibility:

- `VOICE_ADMISSION_DEBUG=1` prints the exact classifier system prompt, classifier user prompt, raw classifier output, and parsed decision for each scenario
- `VOICE_CLASSIFIER_DEBUG=1` still works as a compatibility alias for the same live admission debug path
