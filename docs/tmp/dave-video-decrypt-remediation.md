# DAVE Video Decrypt Failure — Investigation & Remediation

## Status: Persistent H264 decoder working, DAVE packet loss causing visual corruption

The persistent H264 decoder pipeline is fully functional end-to-end. The bot sees the screen, identifies content accurately, and responds in real time. The remaining quality issue is upstream: ~45-55% of video RTP packets fail DAVE decryption, causing H264 reference frame corruption that manifests as visual artifacts in the decoded frames.

## What's Working

- **Persistent H264 decoder** in clankvox decodes non-IDR P-frames via OpenH264 with error concealment (`ERROR_CON_SLICE_COPY_CROSS_IDR`)
- **Raw API bypass** — OpenH264 Rust wrapper treats `dsDataErrorConcealed` (state 32) as fatal, but it means "decoded with concealment." We call the C API directly and accept concealed frames
- **JPEG encoding** via turbojpeg, base64 IPC to TypeScript, direct ingest to vision model — no ffmpeg subprocess
- **Frame diff scoring** (coarse luma grid, EMA smoothing, scene cut detection) for smart commentary triggers
- **Rate-limited emission** at configured FPS (default 2) while feeding every frame to the decoder to maintain reference state

## The Problem: DAVE Video Decrypt Failures

Consistent ~45-55% failure rate on video frame DAVE decryption across all sessions observed:

```
dave_video_decrypt_ok=1279  dave_video_decrypt_fail=1521  success_pct=45
```

The error: `no valid cryptor manager could be found for VIDEO`

### What this causes

When the decoder loses P-frames to DAVE failures, subsequent P-frames that reference the lost frames produce concealed (corrupted) output. The artifacts accumulate and persist until an IDR keyframe arrives (which Discord rarely sends). The bot sees "massive graphical corruption" and "abstract art" — it can identify the application but not fine details.

### What we know

- **Audio decrypts at 99%+** on the same DAVE session — keys and cipher manager are correct
- **Frame assembly is correct** — `has_marker=true` on all failures, nonces are monotonic
- **Primary vs alternate candidate doesn't matter** — both fail at the same rate
- **Not server-specific** — same failure rate across different Discord voice servers
- **The failure is at AES-GCM tag verification** — not nonce replay or generation mismatch
- **Pattern:** failures come in bursts of 3-10 consecutive packets, suggesting temporal correlation (possibly related to sender-side DAVE key rotation or RTP extension changes)

### Hypotheses to investigate

1. **Sender encrypts video differently from how we reassemble.** Video frames are multi-packet (FU-A fragments). If the sender encrypts the complete frame but we're attempting decryption on a slightly different reassembly (e.g., different RTP header extension handling between fragments), the AEAD tag won't verify.

2. **Supplemental data / unencrypted ranges mismatch.** H264 has codec-specific unencrypted ranges (NAL headers). The `davey` crate's `parse_frame` might disagree with the sender's `validate_encrypted_frame` on where unencrypted ranges are, especially for large multi-slice access units.

3. **RTP extension stripping inconsistency.** The decryption input (AAD for AES-GCM) includes the RTP header. If some packets have extensions that others don't, or if extension stripping is inconsistent across fragments of the same frame, the AAD mismatch causes tag verification failure.

4. **Nonce window issue with interleaved audio/video.** Audio at 50fps advances `newest_processed_nonce` rapidly. Video nonces that arrive late might fall outside the davey crate's `MAX_MISSING_NONCES=1000` window. But this seems unlikely given the window size.

## Remediation Options

### Option A: Fork/patch davey crate (diagnostic)

Add per-attempt logging inside `decrypt_impl` to identify exactly which step fails:
- `can_process_nonce` rejection?
- `get_cipher` returning None?
- AES-GCM tag verification failure?
- Which generation/epoch is being tried?

This is the critical diagnostic gap — we know decryption fails but not why.

### Option B: Increase IDR keyframe frequency

If we can get Discord to send IDR frames every 2-4 seconds instead of never, the decoder can resync from corruption much faster. Options:
- Send PLI/FIR more aggressively (currently every ~5s via decoder reset)
- Use the `fixed_keyframe_interval` experiment flag that Discord advertises in session ready
- Investigate if there's a signaling mechanism to request keyframe interval

### Option C: Tolerate corruption, improve downstream handling

The decoder already produces frames even with ~45% packet loss. The visual quality is degraded but often still recognizable. Options:
- Add a corruption score to the JPEG output based on concealment ratio
- Skip sending heavily-corrupted frames to the vision model (they waste tokens and confuse the brain)
- Add prompt guidance telling the model to expect some visual artifacts from the stream codec

### Option D: Investigate DAVE nonce/AAD construction

Capture raw RTP packets (pre and post DAVE) for a successful and failed decrypt of adjacent frames. Compare:
- RTP header bytes (used as AAD)
- Extension presence and content
- Frame reassembly byte boundaries
- DAVE trailer structure (nonce, supplemental size, magic marker)

## Key Files

| File | Role |
|------|------|
| `src/voice/clankvox/src/video_decoder.rs` | Persistent H264 decoder with raw OpenH264 API, error concealment, YUV→RGB→JPEG |
| `src/voice/clankvox/src/capture_supervisor.rs` | H264 path routing, decoder lifecycle, rate-limited JPEG emission |
| `src/voice/clankvox/src/ipc.rs` | `DecodedVideoFrame` IPC message variant |
| `src/voice/clankvox/src/dave.rs` | DAVE decrypt wrapper, diagnostic logging |
| `src/voice/clankvox/src/voice_conn.rs` | Frame depacketization, NAL diagnostics, DAVE decrypt dispatch |
| `src/voice/sessionLifecycle.ts` | `onDecodedVideoFrame` handler, JPEG ingest to vision model |
| `src/voice/clankvoxClient.ts` | `decoded_video_frame` IPC parser |
| `davey` crate (external, `~/.cargo/registry/src/.../davey-0.1.2/`) | DAVE protocol implementation |

## Bugs Found During This Session

1. **Case mismatch** (`capture_supervisor.rs`): `codec == "h264"` vs `VideoCodecKind::H264::as_str()` returning `"H264"`. Fixed with `eq_ignore_ascii_case`.
2. **OpenH264 wrapper overly strict**: `NativeErrorExt::ok()` treats any non-zero `DECODING_STATE` as error, including `dsDataErrorConcealed` (32) which means "decoded with concealment." Fixed by calling raw C API directly.
