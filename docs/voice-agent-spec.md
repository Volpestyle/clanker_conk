# Voice Agent Product Spec

## Goal
Enable `clanker conk` to join Discord voice channels on explicit natural-language requests, run real-time conversations using xAI Grok Voice Agent, and use soundboard effects contextually, while staying human-like and constrained by strict session limits (default max 10 minutes).

## Product Decision (Locked)
- Decision date: February 25, 2026
- V1 voice stack: xAI Grok Voice Agent realtime (`wss://api.x.ai/v1/realtime`)
- Default voice profile: `Rex` (male) with neutral delivery instructions
- No parallel STT/TTS fallback path in V1 (single voice runtime path)

## Why This Matters
- Users already treat `clanker conk` like a social participant in text channels.
- Voice mode should extend that same persona into VC without turning into a generic assistant.
- Explicit time limits keep cost, moderation risk, and channel disruption under control.

## Primary User Stories
1. As a server member, I can say in text chat, "yo clanka hop in vc" or "go join the vc and bother those guys," and the bot joins my current voice channel.
2. As a server admin, I can enforce a hard max session length (10 minutes default), channel allow/block rules, and soundboard rate limits.
3. As users in voice chat, we can have back-and-forth conversation with the same style/personality as text mode.
4. As server admins, we can disable voice mode instantly without redeploying.

## Non-Goals (v1)
- 24/7 passive listening.
- Joining random channels without an explicit trigger.
- Long-term raw audio storage.
- Multi-guild multi-channel voice sharding optimization.

## Product Behavior
1. Trigger from text:
   - Bot detects direct request + voice intent in text chat.
   - Target channel defaults to the requestor's current VC.
2. Preflight checks:
   - Voice mode enabled.
   - Channel/user permission checks.
   - Not already in an active session for that guild.
3. Session start:
   - Bot joins VC, posts a short in-text confirmation, starts countdown timer.
4. Live conversation loop:
   - Ingest voice audio.
   - Stream audio to xAI realtime session.
   - Generate response with same persona and memory context.
   - Play model audio output back to the channel.
   - Optionally fire soundboard effects when confidence and cooldown rules allow.
5. Session end:
   - Hard stop at max duration (10 min default).
   - Early stop on inactivity timeout, explicit NL stop request, disconnect, or permission loss.
   - Bot announces exit briefly in text or voice.

## Technical Approach (V1)
- Use xAI realtime websocket (`wss://api.x.ai/v1/realtime`) for low-latency voice-in/voice-out.
- Use `session.update` to configure:
  - `voice: "Rex"`
  - persona instructions aligned to current text behavior, with explicit neutral delivery guardrails (calm, conversational, non-announcer tone).
  - audio format: `audio/pcm` at 24kHz for input/output.
- Use server-side API key auth for bot runtime (no browser client token flow needed).
- Enforce hard leave at `maxSessionMinutes=10`.
- Billing model: $0.05/minute of connection time (+ tool invocation costs if enabled).

### Voice Selection Note
- xAI currently exposes five voices: `Ara`, `Rex`, `Sal`, `Eve`, `Leo`.
- `Rex` is male and closest to your "neutral male" request when paired with neutral speaking instructions.
- If strictly neutral (not male) timbre is preferred later, swap to `Sal`.

## Required Discord Capabilities
- Add `GuildVoiceStates` gateway intent.
- Add bot permissions:
  - `Connect`
  - `Speak`
  - `Use Soundboard`
  - `Use External Sounds` (if cross-server sounds are allowed)
- Use `@discordjs/voice` for joining channels and audio streaming.
- Use Discord soundboard APIs / methods for contextual effects while connected.

## Required xAI Capabilities
- xAI realtime endpoint: `wss://api.x.ai/v1/realtime`.
- Runtime region: `us-east-1` (Voice Agent availability constraint).
- API key configured as `XAI_API_KEY` in bot server environment.

## Proposed Architecture Changes
- `src/bot.ts`
  - Add voice intent trigger routing in `messageCreate`.
  - Add VC NL intent handling (`join`, `leave`, `status`) with confidence gating.
  - Add `GatewayIntentBits.GuildVoiceStates`.
- `src/voice/voiceSessionManager.ts`
  - Owns session lifecycle, timers, join/leave, and guild-level locking.
- `src/voice/voiceIntentParser.ts`
  - Detects natural-language text requests to join VC.
- `src/voice/xaiRealtimeClient.ts`
  - Owns xAI websocket session creation, audio in/out streaming, and session updates.
- `src/voice/soundboardDirector.ts`
  - Chooses if/when to trigger soundboard sounds under cooldown and cap rules.
- `src/prompts.ts`
  - Add voice-specific system/turn prompts while preserving current persona.
- `src/store.ts`
  - Persist voice session metadata and voice actions.
- `dashboard/src/components/SettingsForm.tsx`
  - Add voice settings controls.

## Settings Model (New)
```js
voice: {
  enabled: false,
  joinOnTextNL: true,
  requireDirectMentionForJoin: true,
  intentConfidenceThreshold: 0.75,
  maxSessionMinutes: 10,
  inactivityLeaveSeconds: 90,
  maxSessionsPerDay: 12,
  maxConcurrentGuildSessions: 1,
  allowedVoiceChannelIds: [],
  blockedVoiceChannelIds: [],
  blockedVoiceUserIds: [],
  xai: {
    voice: "Rex", // male voice with neutral delivery instructions
    audioFormat: "audio/pcm",
    sampleRateHz: 24000,
    region: "us-east-1"
  },
  soundboard: {
    enabled: true,
    maxPlaysPerSession: 4,
    minSecondsBetweenPlays: 45,
    allowExternalSounds: false
  }
}
```

## Data + Observability

### Action Log Kinds
- `voice_session_start`
- `voice_session_end`
- `voice_turn_in`
- `voice_turn_out`
- `voice_soundboard_play`
- `voice_error`

### Metrics
- Join success rate
- Time to join VC
- Median reply latency (voice turn)
- Session duration distribution
- Soundboard plays/session
- Voice-mode USD cost/day

## Safety + Guardrails
- Admin kill switch: `voice.enabled=false`.
- Strict time cap and inactivity timeout.
- One active session per guild.
- Soundboard anti-spam cooldown + per-session cap.
- No raw audio retention by default.
- Keep transcript retention short and configurable.
- Keep "playful bother" behavior non-harassing; apply existing moderation policy to voice outputs.

## UX/NL Design

### Natural Language Triggers
- "join vc"
- "hop in voice"
- "go join the vc and bother those guys"
- "leave vc"
- "get out of vc"
- "voice status"

No slash commands in v1. NL is the only control surface.
All NL intents route through the same `voiceSessionManager` methods (single source of truth).

## Rollout Plan
1. Phase 1: Join/leave infrastructure + timer + xAI realtime websocket session wiring.
2. Phase 2: Voice behavior tuning (persona parity with text, neutral male delivery, interruption handling).
3. Phase 3: Soundboard director with strict caps/cooldowns + dashboard controls + cost reporting.

## Acceptance Criteria
1. Bot joins requestor's VC within 5 seconds after a valid NL trigger.
2. Bot leaves automatically at or before configured max session time (default 10 minutes).
3. Bot leaves early after configured inactivity timeout.
4. Bot does not start if voice mode disabled or channel is blocked.
5. Soundboard playback never exceeds configured cooldown and per-session cap.
6. Voice prompt style remains consistent with text persona.
7. Every xAI voice session sends `voice: "Rex"` in session config.
8. Voice output follows neutral delivery style guidance (calm, conversational, low-drama).

## Migration/Cleanup Notes
- Remove the hard-limit statement "Cannot join voice channels." from:
  - `src/defaultSettings.ts`
  - `src/memory.ts` memory markdown identity block
  once voice mode is enabled in production.
- Keep one canonical voice path; avoid parallel "legacy voice" shims.

## Open Questions
1. Should voice sessions be restricted to allowlisted roles in v1?
2. Do we want transcript storage off by default, or short retention (for debugging)?
3. Should the bot auto-join opportunistically later, or remain explicit-NL-trigger-only?
