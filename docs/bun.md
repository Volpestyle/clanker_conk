The crash chain:                                                                                                                                                                                                                                                                                                              1. When audio arrives from OpenAI, ensureBotAudioPlaybackReady creates a new PassThrough stream and immediately passes it to Discord.js's                      createAudioResource(stream, { inputType: StreamType.Raw }).
  2. Discord.js voice internally calls pipeline([passthrough, opusEncoder], noop) (Node.js stream.pipeline) to pipe the raw PCM through an Opus encoder.
  3. In Bun, stream.pipeline() detects the initially-empty PassThrough as closed/ended and fires a "Premature close" error via end-of-stream — this is a Bun
  compatibility bug with Node.js streams.
  4. The playStream emits 'error' → Discord.js's onStreamError handler fires → audioPlayer.emit("error", ...).
  5. There is no 'error' listener on session.audioPlayer (only a stateChange listener at voiceSessionManager.ts:3314). In Node.js EventEmitter, an unhandled
  'error' event crashes the process.
  6. The subsequent bot_audio_stream_lifecycle event=close source=lazy_init entries (×3) are the same pattern repeating — each new audio chunk creates a new
  stream, which immediately dies.