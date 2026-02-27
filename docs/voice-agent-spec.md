# Voice Agent Product Spec

## Goal
Enable `clanker conk` to join Discord voice channels on explicit natural-language requests, run live conversations with selectable runtime modes, and optionally use Discord soundboard effects, while staying constrained by runtime limits and operational guardrails.

## Product Decision (Current)
- Updated: February 26, 2026
- Voice runtime is dashboard-selectable via `voice.mode`:
  - `voice_agent`: xAI realtime websocket (`wss://api.x.ai/v1/realtime`)
  - `openai_realtime`: OpenAI Realtime websocket (`wss://api.openai.com/v1/realtime?model=...`)
  - `gemini_realtime`: Gemini Live API websocket
  - `stt_pipeline`: STT -> shared chat LLM brain -> TTS
- Text NL voice controls (`join`, `leave`, `status`) are decided by an LLM classifier with confidence gating.
- Text NL stream-watch controls (`watch_stream`, `stop_watching_stream`, `stream_status`) route through the same structured intent path.
- `voiceSessionManager` is the single execution and safety authority for session lifecycle and join/leave/status behavior.
- Default runtime mode: `voice_agent`.
- Default xAI voice: `Rex`.

## Implemented Behavior

### 1. Text Trigger Routing
- Runs on guild text messages after normal channel/user permission filtering.
- Uses a lightweight prefilter for voice/action/mention hints to avoid unnecessary LLM calls.
- Classifies the message with strict JSON output:
  - `intent`: `join | leave | status | watch_stream | stop_watching_stream | stream_status | none`
  - `confidence`: `0..1`
- Applies `voice.intentConfidenceThreshold` (clamped `0.4..0.99`) before taking action.
- If parse/classification fails, intent handling fails closed (`none`).

### 2. Join Preflight Checks
- `voice.enabled` must be true.
- Requesting user must not be in `blockedVoiceUserIds`.
- Requesting user must already be in a voice channel.
- Target voice channel (requestor channel) must pass:
  - not in `blockedVoiceChannelIds`
  - if allowlist exists, it must be in `allowedVoiceChannelIds`
- Daily/global limits:
  - `maxSessionsPerDay` (24h count of `voice_session_start`)
  - `maxConcurrentSessions` across active + pending sessions
- Runtime readiness:
  - `voice_agent` requires `XAI_API_KEY`
  - `openai_realtime` requires `OPENAI_API_KEY`
  - `gemini_realtime` requires `GOOGLE_API_KEY`
  - `stt_pipeline` requires ASR + TTS readiness and voice-turn callback
- Voice-channel permissions must include `CONNECT` and `SPEAK`.

### 3. Session Start
- Joins requestor voice channel with `@discordjs/voice`.
- Waits for ready state (up to 15s).
- Initializes runtime-specific client and audio pipeline.
- Starts max-duration and inactivity timers.
- Logs `voice_session_start`.
- Sends an operational update to text chat.

### 4. Live Conversation Loop
- Captures inbound speaker audio, decodes Opus, normalizes PCM.
- Runtime-specific response path:
  - `voice_agent`: stream PCM to xAI realtime, play returned audio.
  - `openai_realtime`: stream PCM to OpenAI Realtime, play returned audio.
  - `gemini_realtime`: stream PCM to Gemini Live API, play returned audio.
  - `stt_pipeline`: transcribe turn, generate reply via shared chat LLM path (with memory), synthesize TTS, play audio.
- Stream watch:
  - `watch_stream` enables a per-session stream-watch state.
  - External relay can post frames to `/api/voice/stream-ingest/frame`.
  - In `gemini_realtime` mode, frames can trigger in-persona voice commentary under cooldown/quiet-channel guardrails.
- Multi-party gating:
  - In one-human sessions, turns are accepted directly.
  - In multi-human sessions, bot requires explicit addressing (`botName` or bot keyword) and uses focused-speaker follow-up TTL behavior.
- OpenAI realtime context refresh:
  - Debounced instruction updates include live roster, active speaker/transcript, and memory facts.
- Realtime reliability:
  - One pending response at a time.
  - Silent-response retries + hard recovery path.
  - Stalled turn fallback drops the stuck turn to allow recovery on next user turn.
- Soundboard:
  - Soundboard use is autonomous while in-session, based on live VC transcript context.
  - If `voice.soundboard.preferredSoundIds` is set, selection is constrained to those references.
  - If `voice.soundboard.preferredSoundIds` is empty, candidates are fetched from the guild soundboard catalog.
  - No configured cooldown or per-session cap is enforced.

### 5. Session End
- Session ends on any of:
  - max-duration timeout
  - inactivity timeout
  - explicit NL leave
  - runtime/socket error
  - connection loss
  - bot disconnect grace timeout
  - settings reconciliation (voice disabled or channel no longer allowed)
  - channel switch request
- Cleans up connection, timers, captures, realtime client, and audio stream.
- Logs `voice_session_end`.
- Sends a text-channel operational message (not voice TTS announcement).

## Current Architecture
- `src/bot.ts`
  - Routes message events and invokes LLM-based voice intent classification.
- `src/voice/voiceSessionManager.ts`
  - Source of truth for voice session lifecycle, preflight checks, timers, runtime wiring, and guardrails.
- `src/voice/xaiRealtimeClient.ts`
  - xAI realtime websocket session and audio event handling.
- `src/voice/openaiRealtimeClient.ts`
  - OpenAI Realtime websocket session and audio event handling.
- `src/voice/geminiRealtimeClient.ts`
  - Gemini Live websocket session for audio + video frame ingest.
- `src/voice/soundboardDirector.ts`
  - Manual/mapped soundboard playback execution and permission checks.
- `src/prompts.ts` + `src/bot.ts`
  - Voice turn prompt/instruction generation and operational messaging.
- `src/store.ts`
  - Voice settings normalization and voice action persistence.
- `dashboard/src/components/SettingsForm.tsx`
  - Voice settings UI controls.

## Settings Model (Current)
```js
voice: {
  enabled: false,
  mode: "voice_agent", // "voice_agent" | "openai_realtime" | "gemini_realtime" | "stt_pipeline"
  intentConfidenceThreshold: 0.75,
  maxSessionMinutes: 10,
  inactivityLeaveSeconds: 90,
  maxSessionsPerDay: 12,
  maxConcurrentSessions: 1,
  allowedVoiceChannelIds: [],
  blockedVoiceChannelIds: [],
  blockedVoiceUserIds: [],
  xai: {
    voice: "Rex",
    audioFormat: "audio/pcm",
    sampleRateHz: 24000,
    region: "us-east-1"
  },
  openaiRealtime: {
    model: "gpt-realtime",
    voice: "alloy",
    inputAudioFormat: "pcm16",
    outputAudioFormat: "pcm16",
    inputSampleRateHz: 24000,
    outputSampleRateHz: 24000,
    inputTranscriptionModel: "gpt-4o-mini-transcribe",
    allowNsfwHumor: true
  },
  geminiRealtime: {
    model: "gemini-2.5-flash-native-audio-preview-12-2025",
    voice: "Aoede",
    apiBaseUrl: "https://generativelanguage.googleapis.com",
    inputSampleRateHz: 16000,
    outputSampleRateHz: 24000,
    allowNsfwHumor: true
  },
  sttPipeline: {
    transcriptionModel: "gpt-4o-mini-transcribe",
    ttsModel: "gpt-4o-mini-tts",
    ttsVoice: "alloy",
    ttsSpeed: 1
  },
  streamWatch: {
    enabled: true,
    minCommentaryIntervalSeconds: 8,
    maxFramesPerMinute: 180,
    maxFrameBytes: 350000
  },
  soundboard: {
    enabled: true,
    allowExternalSounds: false,
    preferredSoundIds: [] // optional override list; empty => use guild soundboard catalog
  }
}
```

## Data + Observability

### Action Log Kinds
- `voice_session_start`
- `voice_session_end`
- `voice_intent_detected`
- `voice_turn_in`
- `voice_turn_out`
- `voice_soundboard_play`
- `voice_runtime`
- `voice_error`

### Metrics (Practical)
- Join success/failure rates.
- Session duration distribution.
- Voice runtime error rates.
- Soundboard play frequency.
- Voice-mode USD cost/day.

## Safety + Guardrails (Current)
- Admin kill switch: `voice.enabled=false`.
- Session hard cap (`maxSessionMinutes`) and inactivity timeout (`inactivityLeaveSeconds`).
- Per-guild join lock and explicit session cleanup.
- Global concurrency cap (`maxConcurrentSessions`) and daily session cap (`maxSessionsPerDay`).
- Channel/user allow/block lists for voice control.
- Runtime/API prerequisite checks before join.
- No long-term raw audio storage path in DB.
  - STT transcription uses temporary WAV files in OS temp dir and deletes them after use.
- Soundboard is gated by settings + Discord permissions.
  - No implemented configurable cooldown/per-session cap yet.

## UX / NL Controls

### Example NL Triggers
- `join vc`
- `hop in voice`
- `go join the vc and bother those guys`
- `leave vc`
- `get out of vc`
- `voice status`

No slash commands are required for voice controls.
All NL intents route through `voiceSessionManager` methods.
Ambiguous requests can resolve to `none` and be ignored.

## Acceptance Criteria (Current)
1. A high-confidence valid NL join request triggers a join attempt to the requestor VC with preflight guardrails enforced.
2. Bot leaves automatically at or before configured max session time.
3. Bot leaves automatically after configured inactivity timeout.
4. Bot does not start when disabled, blocked, requester not in VC, permissions are missing, or runtime prerequisites are unavailable.
5. For `voice.mode=voice_agent`, session config sends configured xAI voice and audio settings.
6. For `voice.mode=openai_realtime`, session config sends configured model/voice/audio format/transcription settings.
7. For `voice.mode=gemini_realtime`, session config sends configured model/voice/sample-rate settings.
8. For `voice.mode=stt_pipeline`, replies use the shared chat LLM path and memory slice flow.
9. Multi-party addressing guardrails prevent unwanted replies in group voice unless addressed/focused.
10. Operational join/leave/status and failure updates are posted in text channels.
11. `watch_stream`/`stop_watching_stream`/`stream_status` intents are handled with confidence gating.

## Open Questions
1. Should soundboard autonomy add stronger anti-spam controls beyond transcript-level dedupe?
2. Should voice-control permissions add role-based allowlisting?
3. Should transcript/event retention policy be formalized with explicit pruning controls?
