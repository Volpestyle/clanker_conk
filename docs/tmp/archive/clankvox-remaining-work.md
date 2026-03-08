# Clankvox — `AppState` Refactor Plan

`main()` is 1,026 lines with a 951-line `select!` loop sharing 24 mutable locals.
The refactor moves all state into an `AppState` struct with handler methods, shrinking
the loop to ~50 lines of dispatch.

## Phased approach

Each phase is a standalone commit. Tests + clippy must pass after every phase.
No behavioral changes — pure structural refactor.

---

### Phase 1: Create `AppState` struct, move state into it

Move the 24 `let mut` locals into a struct. `main()` creates `AppState::new(...)`,
then the existing `select!` loop accesses fields via `state.field` instead of bare names.

This is a mechanical find-and-replace. The loop body stays inline — we're just changing
where the variables live. No logic moves.

**Borrow checker note:** `send_msg` is already a free function using a `OnceLock` global,
so it doesn't capture anything. No closure problems here.

Fields to move (all 24):
- Connection: `pending_conn`, `guild_id`, `channel_id`, `self_mute`, `voice_conn`
- Reconnect: `reconnect_deadline`, `reconnect_attempt`
- Audio: `music`, `tts_playback_buffered`, `buffer_depth_tick_counter`, `buffer_depth_was_nonempty`
- Users: `ssrc_map`, `self_user_id`, `opus_decoders`, `speaking_states`, `user_capture_states`
- ASR: `asr_sessions`, `next_asr_session_id`

Fields that stay as locals in `main()` (channels/Arc refs — these are either receivers
that `select!` needs to borrow, or `Arc`s passed into spawned tasks):
- `ipc_control_rx`, `ipc_audio_rx` — receivers, `select!` borrows them
- `voice_event_tx`, `voice_event_rx` — tx cloned into tasks, rx selected on
- `music_pcm_tx`, `music_pcm_rx` — crossbeam channels, passed to music pipeline
- `music_event_tx`, `music_event_rx` — tx passed to music pipeline, rx selected on
- `asr_exit_tx`, `asr_exit_rx` — tx cloned into spawned ASR tasks, rx selected on
- `send_interval` — `select!` ticks on it
- `dave`, `audio_send_state` — `Arc<Mutex<_>>`, shared via clone

**Validation:** 20 tests pass, zero clippy warnings, behavior identical.

---

### Phase 2: Extract `handle_voice_event()`

The voice event arm (lines 620-803, ~183 lines) is a good first extraction because:
- All sub-events (`Ready`, `SsrcUpdate`, `ClientDisconnect`, `OpusReceived`,
  `DaveReady`, `Disconnected`) only touch `AppState` fields + `Arc` refs
- No channel receivers needed (it's dispatched from `voice_event_rx.recv()` which
  stays in the `select!` match)
- Self-contained — doesn't call `try_connect` (except `Disconnected` which calls
  `schedule_reconnect`, already a free function)

Signature:
```rust
impl AppState {
    fn handle_voice_event(
        &mut self,
        event: VoiceEvent,
        dave: &Arc<Mutex<Option<DaveManager>>>,
        audio_send_state: &Arc<Mutex<Option<AudioSendState>>>,
        music_pcm_tx: &crossbeam::Sender<Vec<i16>>,
        music_event_tx: &mpsc::Sender<MusicEvent>,
    )
}
```

The `select!` arm becomes:
```rust
Some(event) = voice_event_rx.recv() => {
    state.handle_voice_event(event, &dave, &audio_send_state, &music_pcm_tx, &music_event_tx);
}
```

---

### Phase 3: Extract `handle_music_event()` and `handle_asr_exit()`

Two small arms:
- Music events (lines 807-858, ~51 lines) — only touches `music` + `send_msg`
- ASR exit (lines 861-873, ~12 lines) — only touches `asr_sessions`

Both are straightforward — low coupling, no async, no spawning.

---

### Phase 4: Extract `handle_ipc_msg()`

The IPC arm (lines 192-617, ~425 lines) is the largest and most coupled. It dispatches
16 message types, some of which call `try_connect` (async) and one (`ConnectAsr`)
spawns a `tokio::spawn`.

Approach:
- `handle_ipc_msg` takes `&mut self` + the channel/Arc refs it needs
- It must be `async` because `VoiceServer`, `VoiceState`, and `MusicResume` call
  `try_connect().await`
- `try_connect` moves from a free function to a method on `AppState` (it already
  takes most of the same params)
- `schedule_reconnect` also becomes a method (avoids passing 6 individual fields)
- `ConnectAsr` needs `asr_exit_tx.clone()` for the spawned task — pass as param

Sub-extraction opportunity: the 16 IPC message types could each be a separate
private method (`handle_join`, `handle_voice_server`, `handle_music_play`, etc.)
but this is optional. The initial extraction just moves the whole `match msg` block.

---

### Phase 5: Extract `on_audio_tick()`

The 20ms tick arm (lines 910-1160, ~250 lines) is the most complex single arm.
It touches `music`, `tts_playback_buffered`, `speaking_states`, `user_capture_states`,
`buffer_depth_*`, `voice_conn`, and both `Arc<Mutex>` refs.

It must be `async` because it calls `conn.send_rtp_frame().await`.

This is the hardest extraction because it reads/writes the most state. But since all
state is now on `&mut self`, the borrow checker is satisfied — one `&mut self` covers
all fields.

Signature:
```rust
impl AppState {
    async fn on_audio_tick(
        &mut self,
        dave: &Arc<Mutex<Option<DaveManager>>>,
        audio_send_state: &Arc<Mutex<Option<AudioSendState>>>,
        music_pcm_rx: &crossbeam::Receiver<Vec<i16>>,
        music_pcm_tx: &crossbeam::Sender<Vec<i16>>,
        music_event_tx: &mpsc::Sender<MusicEvent>,
    )
}
```

---

### Phase 6: Clean up

- Remove `#[allow(clippy::too_many_lines)]` from `main()`
- Move `AppState`, `PendingConnection`, `AsrSession`, `TryConnectOutcome` to a
  separate `state.rs` module if `main.rs` is still large
- Consider grouping the channel/Arc refs that get passed to every handler into a
  `SharedRefs` struct to reduce parameter noise
- Update test count in validation (currently 20)

---

## Extraction order rationale

Phases 2-3 first (voice events, music events, ASR exit) because they're the simplest
and build confidence that the `AppState` struct works. Phase 4 (IPC) is medium
difficulty. Phase 5 (tick) is last because it has the most coupling and benefits from
the pattern being established by earlier phases.

## Validation (every phase)

- `cargo test` — all 20 tests pass
- `cargo clippy` — zero warnings
- Manual smoke test after Phase 5 (full refactor complete)
