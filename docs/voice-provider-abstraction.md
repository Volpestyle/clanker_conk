# V2 Voice Chat System — Technical Overview

## Design Philosophy

The v2 voice chat system is built on the principle of **component swappability** — the voice pipeline is decomposed into three independent, configurable pieces:

1. **Voice/TTS Provider** — determines the output voice and audio format
2. **Brain Provider** — determines the reasoning engine that drives conversation
3. **Transcriber Provider** — converts incoming speech to text (currently fixed to OpenAI)

This means you can mix and match components without being locked into a single vendor's full stack.

## Core Architecture

### Data Flow

```
Discord Audio (Opus) 
    → Transcriber (OpenAI)
    → Brain (reasoning + tool execution)  
    → Voice Provider (TTS output)
    → Discord
```

### Provider Selection

The system resolves providers through a series of resolution functions (in `voiceSessionHelpers.ts`):

```typescript
// Resolution chain
voiceProvider = resolveVoiceProvider(settings)  // default: "openai"
brainProvider = resolveBrainProvider(settings)   // default: "native" (use voice's built-in brain)
transcriberProvider = resolveTranscriberProvider(settings)  // default: "openai"
```

When `brainProvider` is `"native"`, it uses the brain bundled with the selected voice provider. Setting it to an explicit provider (e.g., `"anthropic"`, `"xai"`) lets you swap the reasoning engine independently.

### Settings Schema

```typescript
voice: {
  voiceProvider: "openai" | "xai" | "gemini" | "elevenlabs",  // output voice
  brainProvider: "native" | "openai" | "anthropic" | "xai" | "gemini",  // reasoning
  transcriberProvider: "openai",  // STT (extensible in future)
  
  // Provider-specific configs (each provider has its own section)
  openaiRealtime: { model, voice, inputTranscriptionModel, usePerUserAsrBridge },
  xai: { voice, audioFormat, sampleRateHz, region },
  geminiRealtime: { model, voice, apiBaseUrl },
  elevenLabsRealtime: { agentId, voiceId, apiBaseUrl },
}
```

## Key Components

### voiceModes.ts
Defines the valid provider values and normalization functions:
- `VOICE_PROVIDERS` — valid output voice options
- `BRAIN_PROVIDERS` — valid reasoning engine options  
- `TRANSCRIBER_PROVIDERS` — valid transcription options (extensible)
- Normalization functions ensure valid values with sensible defaults

### voiceSessionHelpers.ts
Contains resolution functions that compute the effective provider from settings:
- `resolveVoiceProvider()` — gets the voice provider, defaults to "openai"
- `resolveBrainProvider()` — resolves brain, handling "native" shorthand
- `resolveTranscriberProvider()` — resolves transcriber (currently always OpenAI)
- `resolveVoiceRuntimeMode()` — derives the runtime mode for backwards compatibility

### voiceJoinFlow.ts
The main entry point for starting a voice session. Uses the resolved providers to:
- Instantiate the appropriate realtime client
- Configure per-user ASR (always enabled for OpenAI in brain mode)
- Pass tools and instructions to the brain

### voiceSessionManager.ts
Handles the runtime behavior:
- `resolveRealtimeReplyStrategy()` — determines whether to use native or custom brain based on `brainProvider`
- Tool execution and memory integration

### Dashboard Integration
The settings form (`settingsFormModel.ts`, `SettingsForm.tsx`) exposes the new provider fields, allowing users to select voice and brain providers from dropdowns.

## Provider Behavior

| Voice Provider | Brain "native" behavior | Brain explicit behavior |
|----------------|------------------------|-------------------------|
| `openai` | GPT-4o Realtime (brain + voice) | OpenAI API + OpenAI TTS |
| `xai` | Grok Voice Agent | xAI API + xAI voice |
| `gemini` | Gemini 2.5 Flash | Gemini API + Gemini voice |
| `elevenlabs` | ElevenLabs Agent | N/A (ElevenLabs is full-stack) |

## Backwards Compatibility

The system maintains backwards compatibility through:
1. `resolveVoiceRuntimeMode()` falls back to checking `settings.voice.mode` if `voiceProvider` isn't set
2. Existing configs with `mode: "openai_realtime"` continue to work
3. The `brainProvider: "native"` shorthand preserves the "use bundled brain" behavior

## Screen Share Integration

Screen share (streamWatch) is independent of voice/brain providers:

1. **Separate config** — `settings.voice.streamWatch` controls it (enabled, frame rate, autonomous commentary, brain context)

2. **Vision input to brain** — frames are sent to the brain as `input_image` content parts. The brain doesn't care which voice provider is outputting — it just receives images and generates a response.

3. **Works with any brain** — since screen share just sends vision input to whatever brain is active, it works with:
   - OpenAI brain (native)
   - Anthropic brain (if you swap it in)
   - xAI, Gemini, etc.

```
Screen share frames → input_image → [any brain] → text response → [any voice provider] → audio output
```

## Extensibility Points

- **New voice providers** — add to `VOICE_PROVIDERS` in `voiceModes.ts` + add config section in settings schema
- **New brain providers** — add to `BRAIN_PROVIDERS`, implement client if needed
- **New transcriber** — add to `TRANSCRIBER_PROVIDERS` (e.g., Deepgram, Whisper)
