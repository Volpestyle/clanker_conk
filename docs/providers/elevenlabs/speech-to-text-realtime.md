# Realtime

GET /v1/speech-to-text/realtime

Realtime speech-to-text transcription service. This WebSocket API enables streaming audio input and receiving transcription results.

## Event Flow
- Audio chunks are sent as `input_audio_chunk` messages
- Transcription results are streamed back in various formats (partial, committed, with timestamps)
- Supports manual commit or VAD-based automatic commit strategies

Authentication is done either by providing a valid API key in the `xi-api-key` header or by providing a valid token in the `token` query parameter. Tokens can be generated from the [single use token endpoint](/docs/api-reference/tokens/create). Use tokens if you want to transcribe audio from the client side.

Reference: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime

## AsyncAPI Specification

```yaml
asyncapi: 2.6.0
info:
  title: V 1 Speech To Text Realtime
  version: subpackage_v1SpeechToTextRealtime.v1SpeechToTextRealtime
  description: >-
    Realtime speech-to-text transcription service. This WebSocket API enables
    streaming audio input and receiving transcription results.


    ## Event Flow

    - Audio chunks are sent as `input_audio_chunk` messages

    - Transcription results are streamed back in various formats (partial,
    committed, with timestamps)

    - Supports manual commit or VAD-based automatic commit strategies


    Authentication is done either by providing a valid API key in the
    `xi-api-key` header or by providing a valid token in the `token` query
    parameter. Tokens can be generated from the [single use token
    endpoint](/docs/api-reference/tokens/create). Use tokens if you want to
    transcribe audio from the client side.
channels:
  /v1/speech-to-text/realtime:
    description: >-
      Realtime speech-to-text transcription service. This WebSocket API enables
      streaming audio input and receiving transcription results.


      ## Event Flow

      - Audio chunks are sent as `input_audio_chunk` messages

      - Transcription results are streamed back in various formats (partial,
      committed, with timestamps)

      - Supports manual commit or VAD-based automatic commit strategies


      Authentication is done either by providing a valid API key in the
      `xi-api-key` header or by providing a valid token in the `token` query
      parameter. Tokens can be generated from the [single use token
      endpoint](/docs/api-reference/tokens/create). Use tokens if you want to
      transcribe audio from the client side.
    bindings:
      ws:
        query:
          type: object
          properties:
            model_id:
              type: string
            token:
              type: string
            include_timestamps:
              type: boolean
              default: false
            include_language_detection:
              type: boolean
              default: false
            audio_format:
              $ref: '#/components/schemas/type_:AudioFormatEnum'
            language_code:
              type: string
            commit_strategy:
              $ref: >-
                #/components/schemas/type_v1SpeechToTextRealtime:TextToSpeechCommitStrategy
            vad_silence_threshold_secs:
              type: number
              format: double
              default: 1.5
            vad_threshold:
              type: number
              format: double
              default: 0.4
            min_speech_duration_ms:
              type: integer
              default: 100
            min_silence_duration_ms:
              type: integer
              default: 100
            enable_logging:
              type: boolean
              default: true
        headers:
          type: object
          properties:
            xi-api-key:
              type: string
    publish:
      operationId: v-1-speech-to-text-realtime-publish
      summary: Server message
      message:
        name: subscribe
        payload:
          $ref: >-
            #/components/schemas/type_v1SpeechToTextRealtime:receiveTranscription
    subscribe:
      operationId: v-1-speech-to-text-realtime-subscribe
      summary: Client message
      message:
        name: publish
        payload:
          $ref: '#/components/schemas/type_:InputAudioChunkPayload'
servers:
  Production:
    url: wss://api.elevenlabs.io/
    protocol: wss
    x-default: true
  Production US:
    url: wss://api.us.elevenlabs.io/
    protocol: wss
  Production EU:
    url: wss://api.eu.residency.elevenlabs.io/
    protocol: wss
  Production India:
    url: wss://api.in.residency.elevenlabs.io/
    protocol: wss
components:
  schemas:
    type_:AudioFormatEnum:
      type: string
      enum:
        - pcm_8000
        - pcm_16000
        - pcm_22050
        - pcm_24000
        - pcm_44100
        - pcm_48000
        - ulaw_8000
      default: pcm_16000
      description: Audio encoding format for speech-to-text.
      title: AudioFormatEnum
    type_v1SpeechToTextRealtime:TextToSpeechCommitStrategy:
      type: string
      enum:
        - manual
        - vad
      default: manual
      description: Strategy for committing transcriptions.
      title: TextToSpeechCommitStrategy
    type_:SessionStartedPayloadConfigCommitStrategy:
      type: string
      enum:
        - manual
        - vad
      description: Strategy for committing transcriptions.
      title: SessionStartedPayloadConfigCommitStrategy
    type_:SessionStartedPayloadConfig:
      type: object
      properties:
        sample_rate:
          type: integer
          description: Sample rate of the audio in Hz.
        audio_format:
          $ref: '#/components/schemas/type_:AudioFormatEnum'
        language_code:
          type: string
          description: Language code in ISO 639-1 or ISO 639-3 format.
        commit_strategy:
          $ref: '#/components/schemas/type_:SessionStartedPayloadConfigCommitStrategy'
          description: Strategy for committing transcriptions.
        vad_silence_threshold_secs:
          type: number
          format: double
          description: Silence threshold in seconds.
        vad_threshold:
          type: number
          format: double
          description: Threshold for voice activity detection.
        min_speech_duration_ms:
          type: integer
          description: Minimum speech duration in milliseconds.
        min_silence_duration_ms:
          type: integer
          description: Minimum silence duration in milliseconds.
        model_id:
          type: string
          description: ID of the model to use for transcription.
        enable_logging:
          type: boolean
          description: >-
            When enable_logging is set to false zero retention mode will be used
            for the request. This will mean history features are unavailable for
            this request. Zero retention mode may only be used by enterprise
            customers.
        include_timestamps:
          type: boolean
          description: >-
            Whether the session will include word-level timestamps in the
            committed transcript.
        include_language_detection:
          type: boolean
          description: >-
            Whether the session will include language detection in the committed
            transcript.
      description: Configuration for the transcription session.
      title: SessionStartedPayloadConfig
    type_:SessionStartedPayload:
      type: object
      properties:
        message_type:
          type: string
          enum:
            - session_started
          description: The message type identifier.
        session_id:
          type: string
          description: Unique identifier for the session.
        config:
          $ref: '#/components/schemas/type_:SessionStartedPayloadConfig'
          description: Configuration for the transcription session.
      required:
        - message_type
        - session_id
        - config
      description: Payload sent when the transcription session is successfully started.
      title: SessionStartedPayload
    type_:PartialTranscriptPayload:
      type: object
      properties:
        message_type:
          type: string
          enum:
            - partial_transcript
          description: The message type identifier.
        text:
          type: string
          description: Partial transcription text.
      required:
        - message_type
        - text
      description: Payload for partial transcription results that may change.
      title: PartialTranscriptPayload
    type_:CommittedTranscriptPayload:
      type: object
      properties:
        message_type:
          type: string
          enum:
            - committed_transcript
          description: The message type identifier.
        text:
          type: string
          description: Committed transcription text.
      required:
        - message_type
        - text
      description: Payload for committed transcription results.
      title: CommittedTranscriptPayload
    type_:TranscriptionWordType:
      type: string
      enum:
        - word
        - spacing
      description: The type of word.
      title: TranscriptionWordType
    type_:TranscriptionWord:
      type: object
      properties:
        text:
          type: string
          description: The transcribed word.
        start:
          type: number
          format: double
          description: Start time in seconds.
        end:
          type: number
          format: double
          description: End time in seconds.
        type:
          $ref: '#/components/schemas/type_:TranscriptionWordType'
          description: The type of word.
        speaker_id:
          type: string
          description: The ID of the speaker if available.
        logprob:
          type: number
          format: double
          description: Confidence score for this word.
        characters:
          type: array
          items:
            type: string
          description: The characters in the word.
      description: Word-level transcription data with timing information.
      title: TranscriptionWord
    type_:CommittedTranscriptWithTimestampsPayload:
      type: object
      properties:
        message_type:
          type: string
          enum:
            - committed_transcript_with_timestamps
          description: The message type identifier.
        text:
          type: string
          description: Committed transcription text.
        language_code:
          type: string
          description: Detected or specified language code.
        words:
          type: array
          items:
            $ref: '#/components/schemas/type_:TranscriptionWord'
          description: Word-level information with timestamps.
      required:
        - message_type
        - text
      description: Payload for committed transcription results with word-level timestamps.
      title: CommittedTranscriptWithTimestampsPayload
    type_:ScribeErrorPayload:
      type: object
      properties:
        message_type:
          type: string
          enum:
            - error
          description: The message type identifier.
        error:
          type: string
          description: Error message describing what went wrong.
      required:
        - message_type
        - error
      description: Payload for error events during transcription.
      title: ScribeErrorPayload
    type_:ScribeAuthErrorPayload:
      type: object
      properties:
        message_type:
          type: string
          enum:
            - auth_error
          description: The message type identifier.
        error:
          type: string
          description: Authentication error details.
      required:
        - message_type
        - error
      description: Payload for authentication errors.
      title: ScribeAuthErrorPayload
    type_:ScribeQuotaExceededErrorPayload:
      type: object
      properties:
        message_type:
          type: string
          enum:
            - quota_exceeded
          description: The message type identifier.
        error:
          type: string
          description: Quota exceeded error details.
      required:
        - message_type
        - error
      description: Payload for quota exceeded errors.
      title: ScribeQuotaExceededErrorPayload
    type_:ScribeThrottledErrorPayload:
      type: object
      properties:
        message_type:
          type: string
          enum:
            - commit_throttled
          description: The message type identifier.
        error:
          type: string
          description: Throttled error details.
      required:
        - message_type
        - error
      description: Payload for throttled errors.
      title: ScribeThrottledErrorPayload
    type_:ScribeUnacceptedTermsErrorPayload:
      type: object
      properties:
        message_type:
          type: string
          enum:
            - unaccepted_terms
          description: The message type identifier.
        error:
          type: string
          description: Unaccepted terms error details.
      required:
        - message_type
        - error
      description: Payload for unaccepted terms errors.
      title: ScribeUnacceptedTermsErrorPayload
    type_:ScribeRateLimitedErrorPayload:
      type: object
      properties:
        message_type:
          type: string
          enum:
            - rate_limited
          description: The message type identifier.
        error:
          type: string
          description: Rate limited error details.
      required:
        - message_type
        - error
      description: Payload for rate limited errors.
      title: ScribeRateLimitedErrorPayload
    type_:ScribeQueueOverflowErrorPayload:
      type: object
      properties:
        message_type:
          type: string
          enum:
            - queue_overflow
          description: The message type identifier.
        error:
          type: string
          description: Queue overflow error details.
      required:
        - message_type
        - error
      description: Payload for queue overflow errors.
      title: ScribeQueueOverflowErrorPayload
    type_:ScribeResourceExhaustedErrorPayload:
      type: object
      properties:
        message_type:
          type: string
          enum:
            - resource_exhausted
          description: The message type identifier.
        error:
          type: string
          description: Resource exhausted error details.
      required:
        - message_type
        - error
      description: Payload for resource exhausted errors.
      title: ScribeResourceExhaustedErrorPayload
    type_:ScribeSessionTimeLimitExceededErrorPayload:
      type: object
      properties:
        message_type:
          type: string
          enum:
            - session_time_limit_exceeded
          description: The message type identifier.
        error:
          type: string
          description: Session time limit exceeded error details.
      required:
        - message_type
        - error
      description: Payload for session time limit exceeded errors.
      title: ScribeSessionTimeLimitExceededErrorPayload
    type_:ScribeInputErrorPayload:
      type: object
      properties:
        message_type:
          type: string
          enum:
            - input_error
          description: The message type identifier.
        error:
          type: string
          description: Input error details.
      required:
        - message_type
        - error
      description: Payload for input errors.
      title: ScribeInputErrorPayload
    type_:ScribeChunkSizeExceededErrorPayload:
      type: object
      properties:
        message_type:
          type: string
          enum:
            - chunk_size_exceeded
          description: The message type identifier.
        error:
          type: string
          description: Chunk size exceeded error details.
      required:
        - message_type
        - error
      description: Payload for chunk size exceeded errors.
      title: ScribeChunkSizeExceededErrorPayload
    type_:ScribeInsufficientAudioActivityErrorPayload:
      type: object
      properties:
        message_type:
          type: string
          enum:
            - insufficient_audio_activity
          description: The message type identifier.
        error:
          type: string
          description: Insufficient audio activity error details.
      required:
        - message_type
        - error
      description: Payload for insufficient audio activity errors.
      title: ScribeInsufficientAudioActivityErrorPayload
    type_:ScribeTranscriberErrorPayload:
      type: object
      properties:
        message_type:
          type: string
          enum:
            - transcriber_error
          description: The message type identifier.
        error:
          type: string
          description: Transcriber error details.
      required:
        - message_type
        - error
      description: Payload for transcriber errors.
      title: ScribeTranscriberErrorPayload
    type_v1SpeechToTextRealtime:receiveTranscription:
      oneOf:
        - $ref: '#/components/schemas/type_:SessionStartedPayload'
        - $ref: '#/components/schemas/type_:PartialTranscriptPayload'
        - $ref: '#/components/schemas/type_:CommittedTranscriptPayload'
        - $ref: '#/components/schemas/type_:CommittedTranscriptWithTimestampsPayload'
        - $ref: '#/components/schemas/type_:ScribeErrorPayload'
        - $ref: '#/components/schemas/type_:ScribeAuthErrorPayload'
        - $ref: '#/components/schemas/type_:ScribeQuotaExceededErrorPayload'
        - $ref: '#/components/schemas/type_:ScribeThrottledErrorPayload'
        - $ref: '#/components/schemas/type_:ScribeUnacceptedTermsErrorPayload'
        - $ref: '#/components/schemas/type_:ScribeRateLimitedErrorPayload'
        - $ref: '#/components/schemas/type_:ScribeQueueOverflowErrorPayload'
        - $ref: '#/components/schemas/type_:ScribeResourceExhaustedErrorPayload'
        - $ref: >-
            #/components/schemas/type_:ScribeSessionTimeLimitExceededErrorPayload
        - $ref: '#/components/schemas/type_:ScribeInputErrorPayload'
        - $ref: '#/components/schemas/type_:ScribeChunkSizeExceededErrorPayload'
        - $ref: >-
            #/components/schemas/type_:ScribeInsufficientAudioActivityErrorPayload
        - $ref: '#/components/schemas/type_:ScribeTranscriberErrorPayload'
      description: Receive transcription results from the WebSocket
      title: receiveTranscription
    type_:InputAudioChunkPayload:
      type: object
      properties:
        message_type:
          type: string
          enum:
            - input_audio_chunk
          description: The message type identifier.
        audio_base_64:
          type: string
          description: Base64-encoded audio data.
        commit:
          type: boolean
          description: Whether to commit the transcription after this chunk.
        sample_rate:
          type: integer
          description: Sample rate of the audio in Hz.
        previous_text:
          type: string
          description: >-
            Send text context to the model. Can only be sent alongside the first
            audio chunk. If sent in a subsequent chunk, an error will be
            returned.
      required:
        - message_type
        - audio_base_64
        - commit
        - sample_rate
      description: Payload for sending audio chunks from client to server.
      title: InputAudioChunkPayload

```