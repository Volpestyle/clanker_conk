# Voice Golden Validation Suite

This suite validates voice-chat behavior across all runtime modes with:

- golden utterance cases
- admission/response pass-fail scoring
- LLM-as-judge evaluation (enabled by default)
- performance timing metrics (p50/p95/avg)

Modes covered:

- `stt_pipeline`
- `voice_agent` (xAI realtime)
- `openai_realtime`
- `gemini_realtime`
- `elevenlabs_realtime`

Notes:

- `stt_pipeline` cases now allow model-directed `[[WEB_SEARCH:...]]` follow-ups when web search is enabled and a provider is configured (`BRAVE_SEARCH_API_KEY` and/or `SERPAPI_API_KEY`).

## Run simulated (fast local loop)

```sh
bun run replay:voice-golden
# or
bun run test:voice-golden
# or (voice golden + text-mode web-search regression)
bun run test:golden
```

## Run live APIs (real perf)

```sh
bun run replay:voice-golden:live
# or
bun run test:voice-golden:live
```

By default judge scoring is enabled in both simulated and live runs. Use `--no-judge` to disable it.

## Key CLI flags

```sh
bun scripts/voiceGoldenHarness.ts \
  --mode live \
  --modes stt_pipeline,voice_agent,openai_realtime,gemini_realtime,elevenlabs_realtime \
  --iterations 1 \
  --judge-provider anthropic \
  --judge-model claude-haiku-4-5 \
  --decider-provider anthropic \
  --decider-model claude-haiku-4-5 \
  --actor-provider anthropic \
  --actor-model claude-sonnet-4-5 \
  --out-json data/voice-golden-report.json
```

Additional flags:

- `--judge`
- `--allow-missing-credentials`
- `--max-cases <n>`
- `--no-judge`

## Live test env vars

Used by `src/voice/voiceGoldenValidation.live.smoke.test.ts`:

- `RUN_LIVE_VOICE_GOLDEN=1`
- `LIVE_VOICE_GOLDEN_MODES`
- `LIVE_VOICE_GOLDEN_ITERATIONS`
- `LIVE_VOICE_GOLDEN_MAX_CASES`
- `LIVE_VOICE_GOLDEN_ALLOW_MISSING_CREDENTIALS`
- `LIVE_VOICE_GOLDEN_ACTOR_PROVIDER`, `LIVE_VOICE_GOLDEN_ACTOR_MODEL`
- `LIVE_VOICE_GOLDEN_DECIDER_PROVIDER`, `LIVE_VOICE_GOLDEN_DECIDER_MODEL`
- `LIVE_VOICE_GOLDEN_JUDGE_PROVIDER`, `LIVE_VOICE_GOLDEN_JUDGE_MODEL`
- `LIVE_VOICE_GOLDEN_NO_JUDGE=1`
- `LIVE_VOICE_GOLDEN_MIN_PASS_RATE`

## Credential requirements

- Live mode requires credentials for the providers selected by `--actor-provider` and `--decider-provider`.
- Judge mode requires credentials for `--judge-provider`.
- With defaults (`anthropic` actor on `claude-sonnet-4-5`, `anthropic` decider/judge on `claude-haiku-4-5`), set `ANTHROPIC_API_KEY`.
- For web-search cases, set at least one search provider key: `BRAVE_SEARCH_API_KEY` and/or `SERPAPI_API_KEY`.
