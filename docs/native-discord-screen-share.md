# Native Discord Screen Watch

> Scope: what "native Discord screen watch" means in this repo, how it works in the Bun runtime, and where the share-link path still fits.
> Product surface: [`voice/screen-share-system.md`](voice/screen-share-system.md)
> Transport stack: [`voice/voice-provider-abstraction.md`](voice/voice-provider-abstraction.md)

This repo supports two transports behind one product capability:

- Native Discord screen watch: subscribe to an active Discord Go Live / video stream through Discord voice media.
- Share-link fallback: send `/share/:token`, capture with `getDisplayMedia()`, and POST JPEG frames back into the bot.

The model only sees `start_screen_watch`. Runtime chooses the transport.

## Current Status

Native Discord screen watch is now wired through the Bun runtime end to end.

That means:

- the voice brain can see who is actively sharing in Discord prompt context
- `start_screen_watch` can bind to an actual active Discord sharer, including an explicitly named target
- native Discord video can flow into the existing stream-watch frame pipeline

That does not mean:

- the model automatically sees a live share just because someone started sharing
- the runtime can safely guess among multiple active Discord sharers
- the native path replaces the share-link fallback

## Runtime Flow

### 1. `clankvox` discovers and forwards native video state

The Rust subprocess emits:

- `user_video_state`
- `user_video_frame`
- `user_video_end`

Those events include active stream metadata plus encoded frame payloads for subscribed users.

### 2. Bun tracks active sharers per voice session

The Bun voice session stores native Discord sharer state:

- active sharers
- stream metadata like codec / type / resolution
- last frame activity
- current native subscription target
- decode telemetry

That state is part of the normal voice session object, so it shows up in runtime inspection and prompt building.

### 3. The prompt can see who is sharing

Realtime instructions now include a section listing active Discord sharers when present.

Important prompt rule:

- active Discord stream availability is not the same thing as current visual frame context

So the brain can know that someone is sharing, without claiming it can already see that share.

### 4. `start_screen_watch` resolves a native target

When the model calls `start_screen_watch`, runtime tries native first.

The tool can optionally include a `target` string:

- display name
- username
- Discord mention
- Discord user id

Native watch is considered usable only when:

- screen watch is enabled
- the requester is in the same active voice session
- the current voice provider supports stream-watch commentary
- `ffmpeg` is available in the Bun runtime environment
- runtime can resolve a target sharer

Target resolution policy is intentionally conservative:

- if `target` resolves cleanly to one active Discord sharer, watch that sharer
- if `target` resolves to a voice participant who is not actively sharing, keep that user as the share-link fallback target
- if no `target` is provided and the requester is actively sharing, watch that requester
- if no `target` is provided and exactly one Discord sharer is active, watch that sharer
- if multiple unrelated sharers are active and no `target` is provided, do not guess
- if `target` is ambiguous or not in the voice session, fail clearly instead of binding the wrong person

If native watch cannot start, runtime falls back to the share-link path.

### 5. Bun decodes native keyframes into the existing frame pipeline

The native path does not currently hand decoded images directly out of Rust.

Current shape:

1. `clankvox` decrypts and forwards encoded video frame payloads
2. Bun receives `user_video_frame`
3. Bun only attempts decode for the currently watched target
4. Bun only decodes keyframes
5. Bun uses `ffmpeg` to decode H264 / VP8 into JPEG
6. Bun feeds that JPEG into `voiceStreamWatch`

After that point, native Discord watch and share-link fallback use the same downstream pipeline:

- latest frame storage
- rolling visual notes
- autonomous commentary triggers
- durable screen notes
- prompt injection

## Current Constraints

The native path is best-effort infrastructure, not a guaranteed transport.

- `ffmpeg` is required for Bun-side decode.
- The current Bun path decodes keyframes only.
- Frame delivery is still rate-limited by the existing stream-watch admission controls.
- If multiple Discord sharers are active and the requester is not the obvious target, runtime will not guess.
- When multiple Discord sharers are active, the intended path is for the brain to choose one by calling `start_screen_watch({ target: "name" })`.
- Share-link fallback remains the recovery path when native watch is unavailable or ambiguous.

## Settings

Native subscription tuning now lives under `voice.streamWatch`:

- `nativeDiscordMaxFramesPerSecond`
- `nativeDiscordPreferredQuality`
- `nativeDiscordPreferredPixelCount`
- `nativeDiscordPreferredStreamType`

These are canonical config fields in the settings schema and runtime, but they are not currently surfaced as dedicated dashboard controls.

Defaults favor low-friction screen watch when those fields are unset:

- 2 fps
- preferred stream type `screen`
- preferred pixel count `1280x720`

Native Discord decode remains keyframe-only today. That is a fixed runtime constraint, not a user-facing setting.

## Product Language

Prefer:

- "start screen watch"
- "watch your screen"
- "I can start watching that share"

Avoid:

- "I can already see your screen" unless frame context is actually active
- "native Discord watch always works" because it is still transport-dependent

Product language: native Discord screen watch is now a real Bun-runtime transport path, with share-link capture retained as the fallback path when native watch is unavailable or ambiguous.
