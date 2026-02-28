# Voice Golden Validation Suite

This suite validates voice-chat behavior across all runtime modes with:

- golden utterance cases
- admission/response pass-fail scoring
- optional LLM-as-judge evaluation
- performance timing metrics (p50/p95/avg)

Modes covered:

- `stt_pipeline`
- `voice_agent` (xAI realtime)
- `openai_realtime`
- `gemini_realtime`

Notes:

- `stt_pipeline` cases now allow model-directed `[[WEB_SEARCH:...]]` follow-ups when web search is enabled and a provider is configured (`BRAVE_SEARCH_API_KEY` and/or `SERPAPI_API_KEY`).

## Run simulated (fast local loop)

```sh
npm run replay:voice-golden
# or
npm run test:voice-golden
```

## Run live APIs (real perf)

```sh
npm run replay:voice-golden:live
# or
npm run test:voice-golden:live
```

By default live mode enables judge scoring.

## Key CLI flags

```sh
bun scripts/voiceGoldenHarness.ts \
  --mode live \
  --modes stt_pipeline,voice_agent,openai_realtime,gemini_realtime \
  --iterations 1 \
  --judge \
  --judge-provider openai \
  --judge-model gpt-5-mini \
  --decider-provider openai \
  --decider-model gpt-5-nano \
  --actor-provider openai \
  --actor-model gpt-5-mini \
  --input-transport audio \
  --timeout-ms 45000 \
  --out-json data/voice-golden-report.json
```

Additional flags:

- `--allow-missing-credentials`
- `--max-cases <n>`
- `--no-judge`

## Live test env vars

Used by `src/voice/voiceGoldenValidation.live.smoke.test.ts`:

- `RUN_LIVE_VOICE_GOLDEN=1`
- `LIVE_VOICE_GOLDEN_MODES`
- `LIVE_VOICE_GOLDEN_ITERATIONS`
- `LIVE_VOICE_GOLDEN_MAX_CASES`
- `LIVE_VOICE_GOLDEN_INPUT_TRANSPORT` (`audio` or `text`)
- `LIVE_VOICE_GOLDEN_TIMEOUT_MS`
- `LIVE_VOICE_GOLDEN_ALLOW_MISSING_CREDENTIALS`
- `LIVE_VOICE_GOLDEN_ACTOR_PROVIDER`, `LIVE_VOICE_GOLDEN_ACTOR_MODEL`
- `LIVE_VOICE_GOLDEN_DECIDER_PROVIDER`, `LIVE_VOICE_GOLDEN_DECIDER_MODEL`
- `LIVE_VOICE_GOLDEN_JUDGE_PROVIDER`, `LIVE_VOICE_GOLDEN_JUDGE_MODEL`
- `LIVE_VOICE_GOLDEN_NO_JUDGE=1`
- `LIVE_VOICE_GOLDEN_MIN_PASS_RATE`

## Credential requirements

- `stt_pipeline`: `OPENAI_API_KEY`
- `openai_realtime`: `OPENAI_API_KEY`
- `voice_agent`: `XAI_API_KEY` (+ `OPENAI_API_KEY` when `--input-transport audio`)
- `gemini_realtime`: `GOOGLE_API_KEY` (+ `OPENAI_API_KEY` when `--input-transport audio`)
