# Voice Interruption Policy

Controls whether users can barge-in (interrupt) the bot while it is speaking.

## Policy Object

```ts
{
  assertive: boolean;   // true = policy is active (false/null = anyone can interrupt)
  scope: "none" | "speaker";
  allowedUserId?: string; // only used when scope = "speaker"
  reason?: string;        // descriptive label for logging
  source?: string;        // originating system (e.g. "music_now_playing")
}
```

Passed as `interruptionPolicy` to `requestRealtimePromptUtterance()` or set on a tracked audio response.

## Decision Logic

`isUserAllowedToInterruptReply({ policy, userId })` in `voiceSessionManager.ts:3202`:

1. Policy is `null` or `assertive` is falsy → **anyone can interrupt** (default).
2. `scope === "none"` → **nobody can interrupt**.
3. `scope === "speaker"` → only `allowedUserId` can interrupt; everyone else is blocked.

## Normalization

`normalizeReplyInterruptionPolicy()` (`voiceSessionManager.ts:3127`) sanitizes the raw policy:
- Accepts legacy `scope: "all"` and normalizes it to `"none"`.
- If `assertive` is not explicitly set, it defaults to `true` when `scope === "none"` or `allowedUserId` is present.
- If `assertive` resolves to `false`, returns `null` (no policy).
- If `scope === "speaker"` with no `allowedUserId`, returns `null`.

## Scopes

| Scope | Effect | Use Case |
|-------|--------|----------|
| `null` (no policy) | Anyone can interrupt | Normal conversation replies |
| `"speaker"` | Only `allowedUserId` can interrupt | Reply directed at a specific user |
| `"none"` | Nobody can interrupt | Short announcements (errors, system alerts) |

## Announcement Pattern

For short system announcements that must not be cut off by chatter:

```ts
manager.requestRealtimePromptUtterance({
  session,
  prompt: `(system: failed to load "Song Title" — error message)`,
  source: "music_play_failed",
  interruptionPolicy: {
    assertive: true,
    scope: "none",
    reason: "announcement",
    source: "music_play_failed"
  }
});
```

For announcements where the requester should be able to interrupt (e.g. to change their mind):

```ts
manager.requestRealtimePromptUtterance({
  session,
  prompt: `(system: "Song Title" by Artist is now playing)`,
  source: "music_now_playing",
  interruptionPolicy: {
    assertive: true,
    scope: "speaker",
    allowedUserId: session.lastOpenAiToolCallerUserId || null,
    reason: "announcement",
    source: "music_now_playing"
  }
});
```

## Barge-In Flow

When a user starts speaking during bot audio (`voiceSessionManager.ts:6254`):

1. `isUserAllowedToInterruptReply()` checks the active policy.
2. If allowed → bot audio is cancelled, user speech is transcribed.
3. If blocked → user speech is ignored, bot continues speaking.

---

## Noise Rejection Pipeline

Before a transcribed turn reaches the brain, it passes through a layered rejection pipeline in `runRealtimeTurn()`. Each gate targets a different failure mode and operates on a specific code path. They are **not** redundant — removing any one gate leaves a class of bad input unfiltered.

### Gate Ordering (in execution order)

```
PCM audio arrives
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ 1. Silence Gate (PCM analysis)                          │
│    Path: all turns (before ASR)                         │
│    Signal: RMS, peak amplitude, active sample ratio     │
│    Drops: near-silent PCM (mic blips, Discord speaking  │
│           events with no actual audio)                  │
│    Log: voice_turn_dropped_silence_gate                 │
└─────────────────────────────────────────────────────────┘
    │
    ▼  ASR runs (either ASR bridge or local transcription)
    │
┌─────────────────────────────────────────────────────────┐
│ 2. Short Clip Skip                                      │
│    Path: local transcription (!hasTranscriptOverride)   │
│    Signal: PCM byte length < VOICE_TURN_MIN_ASR_CLIP_MS │
│    Drops: micro speaking_end clips that hallucinate     │
│    Log: voice_turn_skipped_short_clip_asr               │
└─────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ 3. Low-Signal Fallback Filter                           │
│    Path: local transcription (!hasTranscriptOverride)   │
│    Signal: isLowSignalVoiceFragment() on transcript     │
│           text + fallback model usage + silence metrics  │
│    Drops: trivial/short transcripts from the fallback   │
│           whisper model ("uh", "hmm") that are real but │
│           not worth responding to                       │
│    Log: voice_turn_dropped_low_signal_fallback          │
└─────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ 4. ASR Logprobs Confidence Gate                         │
│    Path: ASR bridge (hasTranscriptOverride = true)      │
│    Signal: mean logprob from OpenAI transcription       │
│    Threshold: VOICE_ASR_LOGPROB_CONFIDENCE_THRESHOLD    │
│              (-1.0 ≈ 37% per-token confidence)          │
│    Drops: hallucinated text from noise/breathing where  │
│           the ASR model produced text but was uncertain  │
│    Log: voice_turn_dropped_asr_low_confidence           │
│    Helper: computeAsrTranscriptConfidence()             │
│            in voiceDecisionRuntime.ts                   │
└─────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ 5. ASR Bridge Fallback Hallucination Guard              │
│    Path: local transcription when ASR bridge was active │
│           but returned empty (!hasTranscriptOverride    │
│           && asrBridgeWasActive)                        │
│    Signal: silence metrics on short clips               │
│    Drops: hallucinated text from local ASR that ran     │
│           because the bridge commit race returned empty  │
│    Log: voice_turn_dropped_asr_bridge_fallback_         │
│         hallucination                                   │
└─────────────────────────────────────────────────────────┘
    │
    ▼
    Turn reaches the brain
```

### Why Each Gate Exists

| Gate | Code Path | What It Catches | Why Others Don't Cover It |
|------|-----------|-----------------|--------------------------|
| Silence gate | All | No-audio PCM blips | Runs before ASR — prevents wasting ASR calls |
| Short clip skip | Local ASR | Micro speaking_end clips | Content-agnostic; pure duration check |
| Low-signal filter | Local ASR | Confident but trivial transcripts ("hmm") | Logprobs gate doesn't apply (no bridge); content is real but not worth responding to |
| Logprobs confidence | ASR bridge | Hallucinated text with low model confidence | Low-signal filter doesn't run on bridge path; silence gate already passed |
| Bridge fallback guard | Local ASR (bridge was active) | Hallucinations from bridge→local fallback race | Only fires when bridge returned empty and local ASR filled in |

### Key Distinction

**Logprobs gate** and **low-signal filter** are the two most commonly confused gates. They are not interchangeable:

- **Logprobs gate** asks: *"Is this transcription accurate?"* — model was uncertain → likely hallucination from noise
- **Low-signal filter** asks: *"Is this content worth responding to?"* — model was confident it heard "hmm" but we don't need to respond

They also guard **different code paths**: logprobs only exists on the ASR bridge path (`hasTranscriptOverride = true`), while low-signal only fires on the local transcription fallback path (`hasTranscriptOverride = false`).
