# Clankvox — Remaining Work

**Branch:** `audit/rust-review`
**Date:** March 6, 2026

---

## 1. Extract `main.rs` into `AppState` + handler functions (High Priority)

The `main()` function is ~900 lines of `tokio::select!` match arms sharing ~20 mutable
local variables. This is the single biggest code quality issue in clankvox.

### Why it's tricky

All the match arms mutate shared state in the same scope. The arms aren't independent —
for example, the IPC `SetMusic` handler writes to `music_state`, which the 20ms audio
tick arm reads to mix frames, which the voice event arm uses to decide whether to drain
buffers. Naively extracting functions hits borrow checker issues because multiple handlers
need `&mut` access to overlapping state.

### Recommended approach

1. **Create an `AppState` struct** that owns all the mutable state currently living as
   `let mut` bindings in `main()`:
   ```rust
   struct AppState {
       voice_conn: Option<VoiceConnection>,
       audio_pipeline: AudioPipeline,
       music_state: MusicState,
       ssrc_map: HashMap<u32, u64>,
       user_capture_states: HashMap<u64, UserCaptureState>,
       asr_txs: HashMap<u64, mpsc::UnboundedSender<AsrCommand>>,
       speaking_states: HashMap<u64, SpeakingState>,
       self_user_id: Option<u64>,
       pending_connect: PendingConnect,
       buffer_depth_tick_counter: u32,
       buffer_depth_was_nonempty: bool,
       tts_playback_buffered: bool,
       // ... remaining locals
   }
   ```

2. **Extract handler methods on `AppState`:**
   - `handle_ipc_msg(&mut self, msg: InMsg, ...)` — dispatch the ~16 IPC message types
   - `handle_voice_event(&mut self, event: VoiceEvent, ...)` — handle voice connection events
   - `handle_asr_exit(&mut self, user_id: u64, reason: String)`
   - `on_audio_tick(&mut self)` — the 20ms send tick (mixing, encoding, sending)
   - `try_connect(&mut self)` — voice connection initiation

3. **The `select!` loop shrinks to ~50 lines** — each arm calls one method on `&mut state`.

4. **Each handler becomes independently testable** — construct an `AppState` in a test,
   call the handler, assert on state changes.

### Watch out for

- The `send_msg` closure captures the IPC sender. It should become a field on `AppState`
  or a method, not a closure.
- Some arms spawn tasks (`tokio::spawn`) that hold references to channels. These channels
  should be fields on `AppState` rather than captured locals.
- The `voice_conn` is `Option<VoiceConnection>` and many arms do `if let Some(vc) = &mut voice_conn`.
  This pattern is fine on `AppState` — just `if let Some(vc) = &mut self.voice_conn`.
- Don't try to split into multiple structs prematurely. One `AppState` with methods is
  the right first step. Sub-structs can come later if needed.

### Validation

- All 15 existing tests must still pass
- Zero clippy warnings must be maintained (pedantic is configured in Cargo.toml)
- Manual smoke test in a voice channel to confirm no regressions

---

## 2. `unwrap()` in `try_connect` (Medium Priority)

`main.rs` — `pending.user_id.unwrap()`, `pending.endpoint.as_ref().unwrap()`, etc. after
an `is_complete()` guard. The invariant holds but the compiler can't prove it.

### Fix

Either:
- Change `PendingConnect` fields to non-optional and use a builder that returns a
  validated `CompleteConnect` struct (type-state pattern), or
- Replace `unwrap()` with `let...else` + error log + return

The type-state approach is cleaner but more invasive. `let...else` is a 5-minute fix.

---

## 3. Voice WebSocket reconnect (Medium Priority, High Effort)

When Discord drops the voice WebSocket, clankvox exits and the TS side respawns the
entire process. This loses all in-flight state: ASR sessions, music playback position,
DAVE epoch, per-SSRC decoders, audio buffers. Users hear an audio gap.

### Why it's hard

- The voice connection (`VoiceConnection`) owns the WebSocket, UDP socket, transport
  cipher, and DAVE state. Reconnecting means re-running the full handshake (IP discovery,
  session description, DAVE welcome) while preserving the rest of `AppState`.
- Discord's reconnect flow (OP7 Resume) has different semantics than initial connect
  (OP0 Identify). `voice_conn.rs` would need a separate resume path.
- DAVE state may or may not survive a reconnect depending on whether the epoch changed.
- Music playback position would need to be tracked and resumed.

### Recommended approach

1. When the WebSocket closes with a resumable code (4015), attempt OP7 Resume
2. If resume fails or the close code is non-resumable, do a full reconnect (OP0)
3. Preserve `AppState` across reconnects — only replace the `VoiceConnection`
4. Re-join ASR sessions after reconnect completes
5. Resume music from the last known position (or accept a small skip)

This is a significant feature, not a cleanup task. Estimate 2-3 days.

---

## 4. Type the TS client (Medium Priority, Low Effort)

`clankvoxClient.ts` has several `any` types:
- `guild: any` — should be `Guild` from discord.js
- `_handleMessage(msg: any)` — should be a discriminated union of outbound message types
- `connectAsr` params are untyped

Straightforward typing work, ~1 hour.

---

## 5. Linear interpolation resampling (Low Priority)

`capture.rs` uses linear interpolation for sample rate conversion. Adequate for speech
but introduces aliasing artifacts on music. A polyphase or sinc resampler (e.g., the
`rubato` crate) would be better if music capture becomes a use case. Not worth doing
unless the product requires it.

---

## 6. Structured IPC error codes (Low Priority)

Errors from clankvox to the TS client are string messages. Typed error codes would let
the TS side react programmatically to specific failure modes (e.g., DAVE failure vs.
network timeout vs. codec error) instead of pattern-matching on strings.

---

## Priority order

1. `AppState` refactor of `main.rs` — biggest code quality win, unlocks testability
2. `unwrap()` → `let...else` in `try_connect` — quick safety fix
3. Type the TS client — quick cleanup
4. Voice WS reconnect — significant feature work, do when the audio gaps become a problem
5. Structured error codes — do when the TS side needs to react to specific failures
6. Resampler upgrade — do if/when music capture is needed
