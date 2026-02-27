# Claude-Code Voice Classifier Incident (2026-02-27)

## Summary
- Voice reply classification using `claude-code` became unstable and expensive.
- The decider path expected strict `YES|NO` outputs but frequently received very large outputs and intermittent invalid/empty stream responses.
- During incident handling, voice reply decision provider was switched to Anthropic (`claude-haiku-4-5`), which restored classifier reliability.

## What We Saw
- `llm_error` spikes for provider `claude-code` with repeated:
  - `claude-code returned an empty or invalid stream response`
  - fallback failures with empty/invalid response
- Errors repeated close to scheduler cadence (~60s windows) during the failure period.
- In voice classifier calls, token usage was far above expected binary-output behavior:
  - source `voice_reply_decision`: average output tokens in the hundreds (should be ~1-2)
  - this increased latency and cost for classification-only calls

## Impact
- Voice reply decisions became slower and less predictable.
- Some decision turns were missed or delayed due to classifier instability.
- Perceived user impact: bot felt slow or unresponsive in VC during bursts.

## Root-Cause Hypothesis
- `claude-code` CLI path does not enforce a hard output-token cap for this flow.
- The implementation relies on instruction-level token constraints in system prompt text, which is not sufficient for binary classifier strictness.
- Stream/fallback parsing also encountered intermittent empty/invalid outputs, causing retries/failures.

## Mitigation Applied
- Voice reply decision model switched from `claude-code` to Anthropic API (`claude-haiku-4-5`).
- This returned stable tiny outputs (`YES`/`NO`) and removed the stream-format instability from classifier calls.

## Follow-Ups
- Keep `claude-code` disabled for classifier path until output bounds and stream handling are hardened.
- If `claude-code` is reintroduced for classifier:
  - require strict schema validation and explicit bounded outputs
  - add health-based circuit breaker on repeated stream/fallback failures
  - isolate initiative/background load from realtime classifier path

