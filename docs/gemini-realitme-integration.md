# Gemini Realtime + Discord Stream Watch Integration Spec

Updated: February 26, 2026

## Goal
Add Gemini as a first-class voice runtime provider while preserving existing VC providers, and add a real stream-frame ingest path so clanker conk can watch VC users' streams and comment in persona.

## Scope
- Keep current voice modes fully supported:
  - `voice_agent` (xAI realtime)
  - `openai_realtime` (OpenAI Realtime)
  - `stt_pipeline` (STT -> chat LLM -> TTS)
- Add new voice mode:
  - `gemini_realtime` (Gemini Live API)
- Add NL stream-watch intents handled through existing structured voice-intent flow.
- Add HTTP ingest endpoint for external stream relay to send frames into active VC sessions.

## Non-Goals
- Direct Discord Go Live capture from bot-only Discord APIs (not available in current bot stack).
- Replacing existing providers.
- Backward-compat shim layers for legacy mode names.

## Product Behavior

### 1. New Voice Runtime Mode
`voice.mode = gemini_realtime` uses Gemini Live API websocket runtime for:
- low-latency audio input/output
- in-VC persona speech output
- optional stream-frame ingest for commentary turns

### 2. Stream Watch Commands (NL)
Structured intent classifier supports:
- `watch_stream`
- `stop_watching_stream`
- `stream_status`

These are decided by LLM with confidence gating using existing `voice.intentConfidenceThreshold`.

### 3. Stream Watch Session Rules
- Stream watch can only run when a VC session is already active in that guild.
- Requesting user must be in the same VC session channel.
- `voice.streamWatch.enabled` must be true.
- Provider requirement: stream watch commentary requires `voice.mode=gemini_realtime`.
- Watch target defaults to requesting user.

### 4. Real Frame Ingest Path
Dashboard/API exposes:
- `POST /api/voice/stream-ingest/frame`

Payload:
```json
{
  "guildId": "123...",
  "streamerUserId": "456...",
  "mimeType": "image/jpeg",
  "dataBase64": "...",
  "source": "relay_name"
}
```

Behavior:
- Validates active session + watch status + provider + payload limits.
- Pushes frame to Gemini realtime session.
- Applies frame-rate and frame-size guardrails from settings.
- Opportunistically requests short voice commentary turns when channel is quiet and cooldown allows.

## Architecture

### Components
- `src/voice/geminiRealtimeClient.ts`
  - Gemini websocket lifecycle, setup, audio/video input, transcript/audio events.
- `src/voice/voiceSessionManager.ts`
  - provider selection for `gemini_realtime`
  - stream watch lifecycle (`start/stop/status`)
  - external frame ingest + commentary scheduling
- `src/bot.ts`
  - intent dispatch for watch commands
  - public runtime ingest adapter (`ingestVoiceStreamFrame`)
- `src/dashboard.ts`
  - stream ingest endpoint

### Data Flow
1. User says: "yo clanky watch my stream" in text.
2. Structured intent parser returns `watch_stream` with confidence above threshold.
3. `VoiceSessionManager.requestWatchStream` enables stream-watch state on active session.
4. External relay posts frames to `/api/voice/stream-ingest/frame`.
5. `VoiceSessionManager.ingestStreamFrame` forwards frame into Gemini session.
6. On cooldown and quiet-channel conditions, manager requests a short commentary turn.
7. Audio output is played in VC via existing PCM pipeline.

## Settings

### New Environment Variable
- `GOOGLE_API_KEY` required for `gemini_realtime` mode.

### New Voice Settings
```js
voice: {
  mode: "gemini_realtime", // now valid
  geminiRealtime: {
    model: "gemini-2.5-flash-native-audio-preview-12-2025",
    voice: "Aoede",
    apiBaseUrl: "https://generativelanguage.googleapis.com",
    inputSampleRateHz: 16000,
    outputSampleRateHz: 24000,
    allowNsfwHumor: true
  },
  streamWatch: {
    enabled: true,
    minCommentaryIntervalSeconds: 8,
    maxFramesPerMinute: 180,
    maxFrameBytes: 350000
  }
}
```

## Safety + Guardrails
- Voice session limits remain unchanged (`maxSessionMinutes`, inactivity timeout, concurrency/day caps).
- Stream ingest requires authenticated dashboard API access.
- Frame MIME allowlist (`image/jpeg|image/png|image/webp`).
- Frame byte ceiling and per-minute ingest cap enforced per session.
- Commentary requests are rate-limited and only attempted when no active user speech/pending bot response.

## Operational Notes
- Because Discord stream video is not directly exposed via current bot voice APIs, production requires an external relay that can decode stream video and post frames to ingest endpoint.
- Recommended relay behavior:
  - 1-3 fps sampling
  - JPEG compression target under `voice.streamWatch.maxFrameBytes`
  - include `guildId` and `streamerUserId` in each frame post

## Acceptance Criteria
1. `voice.mode=gemini_realtime` sessions can join VC and speak realtime replies.
2. Existing voice modes continue to operate unchanged.
3. LLM can classify `watch_stream`/`stop_watching_stream`/`stream_status` intents.
4. `watch_stream` enables stream-watch state only when policy checks pass.
5. `/api/voice/stream-ingest/frame` accepts valid frames and rejects invalid/misrouted frames with reason codes.
6. In active watch mode, valid ingested frames can trigger in-persona commentary turns in VC.
7. Stream watch can be stopped via NL command and status can be queried.
