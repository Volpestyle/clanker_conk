import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type OpenAI from "openai";
import { openRealtimeSocket } from "../voice/realtimeClientCore.ts";
import {
  DEFAULT_ELEVENLABS_BASE_URL,
  normalizeElevenLabsBaseUrl
} from "../voice/realtimeProviderNormalization.ts";
import { clampNumber, normalizeInlineText } from "./llmHelpers.ts";
import type { LlmActionStore, LlmTrace } from "./serviceShared.ts";

type AudioServiceProvider = "openai" | "elevenlabs";
type OpenRealtimeSocketFn = typeof openRealtimeSocket;

export type AudioServiceDeps = {
  openai: OpenAI | null;
  elevenLabsApiKey?: string | null;
  store: LlmActionStore;
  fetchFn?: typeof fetch;
  openWebSocket?: OpenRealtimeSocketFn;
};

type TranscriptionTextResponse = {
  text: string;
};

type ResolvedAudioBytes = {
  audioBuffer: Buffer;
  fileName: string;
};

type ResolvedPcmInput = {
  pcmBuffer: Buffer;
  sampleRateHz: number;
};

function isTranscriptionTextResponse(value: unknown): value is TranscriptionTextResponse {
  return Boolean(value) && typeof value === "object" && "text" in value && typeof value.text === "string";
}

function normalizeAudioProvider(value: unknown, fallback: AudioServiceProvider = "openai"): AudioServiceProvider {
  const normalized = String(value || fallback || "")
    .trim()
    .toLowerCase();
  return normalized === "elevenlabs" ? "elevenlabs" : "openai";
}

function resolveFetchFn(deps: AudioServiceDeps) {
  return deps.fetchFn ?? fetch;
}

function resolveOpenWebSocket(deps: AudioServiceDeps): OpenRealtimeSocketFn {
  return deps.openWebSocket ?? openRealtimeSocket;
}

async function resolveAudioBytes({
  filePath,
  audioBytes = null,
  fileName = "audio.wav"
}: {
  filePath?: string | null;
  audioBytes?: Buffer | Uint8Array | ArrayBuffer | null;
  fileName?: string;
}): Promise<ResolvedAudioBytes> {
  const filePathText = String(filePath || "").trim();
  const resolvedFileName = String(fileName || "").trim() || "audio.wav";
  const resolvedAudioBuffer = Buffer.isBuffer(audioBytes)
    ? audioBytes
    : audioBytes instanceof Uint8Array
      ? Buffer.from(audioBytes)
      : audioBytes instanceof ArrayBuffer
        ? Buffer.from(audioBytes)
        : filePathText
          ? await readFile(filePathText)
          : null;
  if (!resolvedAudioBuffer?.length) {
    throw new Error("ASR transcription requires non-empty audio bytes or file path.");
  }
  return {
    audioBuffer: resolvedAudioBuffer,
    fileName: basename(filePathText) || resolvedFileName
  };
}

function looksLikeWavBuffer(audioBuffer: Buffer) {
  return audioBuffer.length >= 12 &&
    audioBuffer.toString("ascii", 0, 4) === "RIFF" &&
    audioBuffer.toString("ascii", 8, 12) === "WAVE";
}

function parsePcm16MonoWavBuffer(audioBuffer: Buffer): ResolvedPcmInput | null {
  if (!looksLikeWavBuffer(audioBuffer)) {
    return null;
  }

  let sampleRateHz = 0;
  let audioFormat = 0;
  let channelCount = 0;
  let bitsPerSample = 0;
  let dataOffset = 0;
  let dataLength = 0;
  let offset = 12;

  while (offset + 8 <= audioBuffer.length) {
    const chunkId = audioBuffer.toString("ascii", offset, offset + 4);
    const chunkLength = audioBuffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = Math.min(audioBuffer.length, chunkStart + chunkLength);

    if (chunkId === "fmt " && chunkStart + 16 <= audioBuffer.length) {
      audioFormat = audioBuffer.readUInt16LE(chunkStart);
      channelCount = audioBuffer.readUInt16LE(chunkStart + 2);
      sampleRateHz = audioBuffer.readUInt32LE(chunkStart + 4);
      bitsPerSample = audioBuffer.readUInt16LE(chunkStart + 14);
    } else if (chunkId === "data") {
      dataOffset = chunkStart;
      dataLength = Math.max(0, chunkEnd - chunkStart);
    }

    offset = chunkStart + chunkLength + (chunkLength % 2);
  }

  if (!sampleRateHz || !dataOffset || !dataLength) {
    throw new Error("ElevenLabs transcription requires PCM16 mono audio.");
  }
  if (audioFormat !== 1 || channelCount !== 1 || bitsPerSample !== 16) {
    throw new Error("ElevenLabs transcription requires PCM16 mono audio.");
  }

  return {
    pcmBuffer: audioBuffer.subarray(dataOffset, dataOffset + dataLength),
    sampleRateHz
  };
}

function normalizeElevenLabsInputSampleRate(sampleRateHz: unknown) {
  const supportedRates = [8000, 16000, 22050, 24000, 44100, 48000];
  const numeric = Math.max(8000, Math.round(Number(sampleRateHz) || 16000));
  if (supportedRates.includes(numeric)) return numeric;
  let best = supportedRates[0];
  let bestDistance = Math.abs(numeric - best);
  for (const candidate of supportedRates.slice(1)) {
    const distance = Math.abs(numeric - candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function normalizeElevenLabsOutputSampleRate(sampleRateHz: unknown) {
  const supportedRates = [8000, 16000, 22050, 24000, 32000, 44100, 48000];
  const numeric = Math.max(8000, Math.round(Number(sampleRateHz) || 24000));
  if (supportedRates.includes(numeric)) return numeric;
  let best = supportedRates[0];
  let bestDistance = Math.abs(numeric - best);
  for (const candidate of supportedRates.slice(1)) {
    const distance = Math.abs(numeric - candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function resolvePcmInputForElevenLabs({
  audioBuffer,
  sampleRateHz = 16000
}: {
  audioBuffer: Buffer;
  sampleRateHz?: number;
}): ResolvedPcmInput {
  const wav = parsePcm16MonoWavBuffer(audioBuffer);
  if (wav) {
    return {
      pcmBuffer: wav.pcmBuffer,
      sampleRateHz: normalizeElevenLabsInputSampleRate(wav.sampleRateHz)
    };
  }
  return {
    pcmBuffer: audioBuffer,
    sampleRateHz: normalizeElevenLabsInputSampleRate(sampleRateHz)
  };
}

function buildElevenLabsSpeechOutputFormat(responseFormat: string, sampleRateHz: number) {
  const normalizedFormat = String(responseFormat || "pcm").trim().toLowerCase();
  if (normalizedFormat !== "pcm") {
    throw new Error("ElevenLabs speech synthesis currently supports pcm output only.");
  }
  return `pcm_${normalizeElevenLabsOutputSampleRate(sampleRateHz)}`;
}

async function readResponseErrorText(response: Response) {
  try {
    return normalizeInlineText(await response.text(), 1200);
  } catch {
    return null;
  }
}

async function synthesizeSpeechWithElevenLabs(
  deps: AudioServiceDeps,
  {
    text,
    model = "eleven_multilingual_v2",
    voice = "",
    speed = 1,
    responseFormat = "pcm",
    sampleRateHz = 24000,
    baseUrl = DEFAULT_ELEVENLABS_BASE_URL,
    trace = { guildId: null, channelId: null, userId: null, source: null }
  }: {
    text: unknown;
    model?: string;
    voice?: string;
    speed?: number;
    responseFormat?: string;
    sampleRateHz?: number;
    baseUrl?: string;
    trace?: LlmTrace;
  }
) {
  const apiKey = String(deps.elevenLabsApiKey || "").trim();
  if (!apiKey) {
    throw new Error("Speech synthesis requires ELEVENLABS_API_KEY.");
  }

  const resolvedText = normalizeInlineText(text, 4000);
  if (!resolvedText) {
    throw new Error("Speech synthesis requires non-empty text.");
  }

  const resolvedVoiceId = String(voice || "").trim();
  if (!resolvedVoiceId) {
    throw new Error("ElevenLabs speech synthesis requires a configured voice ID.");
  }

  const resolvedModel = String(model || "eleven_multilingual_v2").trim() || "eleven_multilingual_v2";
  const resolvedSpeed = clampNumber(speed, 0.7, 1.2, 1);
  const resolvedSampleRateHz = normalizeElevenLabsOutputSampleRate(sampleRateHz);
  const outputFormat = buildElevenLabsSpeechOutputFormat(responseFormat, resolvedSampleRateHz);
  const fetchFn = resolveFetchFn(deps);
  const url = new URL(normalizeElevenLabsBaseUrl(baseUrl));
  url.pathname = `/v1/text-to-speech/${encodeURIComponent(resolvedVoiceId)}/stream`;
  url.searchParams.set("output_format", outputFormat);

  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey
      },
      body: JSON.stringify({
        text: resolvedText,
        model_id: resolvedModel,
        voice_settings: {
          speed: resolvedSpeed
        }
      })
    });
  } catch (error) {
    throw new Error(`ElevenLabs speech synthesis request failed: ${String((error as Error)?.message || error)}`);
  }

  if (!response.ok) {
    const detail = await readResponseErrorText(response);
    throw new Error(
      `ElevenLabs speech synthesis failed (${response.status}): ${String(detail || response.statusText || "unknown error")}`
    );
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  if (!audioBuffer.length) {
    throw new Error("Speech synthesis returned empty audio.");
  }

  deps.store.logAction({
    kind: "tts_call",
    guildId: trace.guildId,
    channelId: trace.channelId,
    userId: trace.userId,
    content: resolvedModel,
    metadata: {
      provider: "elevenlabs",
      model: resolvedModel,
      voice: resolvedVoiceId,
      speed: resolvedSpeed,
      responseFormat: "pcm",
      outputFormat,
      sampleRateHz: resolvedSampleRateHz,
      textChars: resolvedText.length,
      source: trace.source || "unknown"
    }
  });

  return {
    audioBuffer,
    model: resolvedModel,
    voice: resolvedVoiceId,
    speed: resolvedSpeed,
    responseFormat: "pcm"
  };
}

function chunkAudioBuffer(audioBuffer: Buffer, chunkSizeBytes: number) {
  const chunks: Buffer[] = [];
  const size = Math.max(1, Math.floor(chunkSizeBytes));
  for (let offset = 0; offset < audioBuffer.length; offset += size) {
    chunks.push(audioBuffer.subarray(offset, Math.min(audioBuffer.length, offset + size)));
  }
  return chunks.length > 0 ? chunks : [audioBuffer];
}

async function transcribeAudioWithElevenLabs(
  deps: AudioServiceDeps,
  {
    filePath,
    audioBytes = null,
    fileName = "audio.wav",
    model = "",
    language = "",
    prompt = "",
    sampleRateHz = 16000,
    baseUrl = DEFAULT_ELEVENLABS_BASE_URL,
    trace = { guildId: null, channelId: null, userId: null, source: null }
  }: {
    filePath?: string | null;
    audioBytes?: Buffer | Uint8Array | ArrayBuffer | null;
    fileName?: string;
    model?: string;
    language?: string;
    prompt?: string;
    sampleRateHz?: number;
    baseUrl?: string;
    trace?: LlmTrace;
  }
) {
  const apiKey = String(deps.elevenLabsApiKey || "").trim();
  if (!apiKey) {
    throw new Error("ASR fallback requires ELEVENLABS_API_KEY.");
  }

  const resolvedModel = String(model || "").trim();
  const resolvedLanguage = String(language || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .slice(0, 24);
  const resolvedPrompt = String(prompt || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);

  const { audioBuffer, fileName: resolvedFileName } = await resolveAudioBytes({
    filePath,
    audioBytes,
    fileName
  });
  const resolvedPcm = resolvePcmInputForElevenLabs({
    audioBuffer,
    sampleRateHz
  });
  if (!resolvedPcm.pcmBuffer.length) {
    throw new Error("ASR transcription requires non-empty PCM audio.");
  }

  const url = new URL(normalizeElevenLabsBaseUrl(baseUrl));
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = "/v1/speech-to-text/realtime";
  url.searchParams.set("audio_format", `pcm_${resolvedPcm.sampleRateHz}`);
  url.searchParams.set("commit_strategy", "manual");
  if (resolvedModel) {
    url.searchParams.set("model_id", resolvedModel);
  }
  if (resolvedLanguage) {
    url.searchParams.set("language_code", resolvedLanguage);
  }

  const ws = await resolveOpenWebSocket(deps)({
    url: url.toString(),
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey
    },
    timeoutMessage: "Timed out connecting to ElevenLabs realtime transcription after 10000ms.",
    connectErrorPrefix: "ElevenLabs realtime transcription connection failed"
  });

  const transcript = await new Promise<string>((resolve, reject) => {
    let settled = false;
    let latestPartialTranscript = "";

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
      try {
        ws.close(1000, "transcription_complete");
      } catch {
        // ignore best-effort close
      }
      fn();
    };

    const onMessage = (payload: unknown) => {
      let event: Record<string, unknown> | null = null;
      try {
        event = JSON.parse(String(payload || ""));
      } catch {
        return;
      }
      if (!event || typeof event !== "object") return;

      const messageType = String(event.message_type || "").trim().toLowerCase();
      if (!messageType || messageType === "session_started") {
        return;
      }

      if (messageType === "partial_transcript") {
        latestPartialTranscript = normalizeInlineText(event.text, 2000) || "";
        return;
      }

      if (messageType === "committed_transcript" || messageType === "committed_transcript_with_timestamps") {
        const transcriptText = normalizeInlineText(event.text, 2000) || "";
        settle(() => resolve(transcriptText));
        return;
      }

      if (
        messageType === "error" ||
        messageType === "auth_error" ||
        messageType === "quota_exceeded" ||
        messageType === "commit_throttled" ||
        messageType === "unaccepted_terms" ||
        messageType === "rate_limited" ||
        messageType === "queue_overflow" ||
        messageType === "resource_exhausted" ||
        messageType === "session_time_limit_exceeded" ||
        messageType === "input_error" ||
        messageType === "chunk_size_exceeded" ||
        messageType === "insufficient_audio_activity" ||
        messageType === "transcriber_error"
      ) {
        const errorText = normalizeInlineText(event.error, 800) || "Unknown ElevenLabs transcription error";
        settle(() => reject(new Error(`${messageType}: ${errorText}`)));
      }
    };

    const onError = (error: Error) => {
      settle(() => reject(new Error(`ElevenLabs realtime transcription socket error: ${String(error?.message || error)}`)));
    };

    const onClose = (code: number, reasonBuffer: Buffer) => {
      if (latestPartialTranscript) {
        settle(() => resolve(latestPartialTranscript));
        return;
      }
      const reason = normalizeInlineText(reasonBuffer?.toString?.(), 200) || null;
      settle(() => reject(new Error(
        `ElevenLabs realtime transcription closed before transcript (${code}${reason ? `: ${reason}` : ""})`
      )));
    };

    const timeout = setTimeout(() => {
      if (latestPartialTranscript) {
        settle(() => resolve(latestPartialTranscript));
        return;
      }
      settle(() => reject(new Error("ElevenLabs realtime transcription timed out waiting for a transcript.")));
    }, 15_000);

    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.on("close", onClose);

    const chunks = chunkAudioBuffer(
      resolvedPcm.pcmBuffer,
      Math.max(4096, resolvedPcm.sampleRateHz * 2)
    );

    try {
      for (const [index, chunk] of chunks.entries()) {
        const payload = {
          message_type: "input_audio_chunk",
          audio_base_64: chunk.toString("base64"),
          commit: index === chunks.length - 1,
          sample_rate: resolvedPcm.sampleRateHz,
          ...(index === 0 && resolvedPrompt ? { previous_text: resolvedPrompt } : {})
        };
        ws.send(JSON.stringify(payload));
      }
    } catch (error) {
      settle(() => reject(new Error(
        `Failed to send audio to ElevenLabs realtime transcription: ${String((error as Error)?.message || error)}`
      )));
    }
  });

  if (!transcript) {
    throw new Error("ASR returned empty transcript.");
  }

  deps.store.logAction({
    kind: "asr_call",
    guildId: trace.guildId,
    channelId: trace.channelId,
    userId: trace.userId,
    content: resolvedModel || "elevenlabs_realtime",
    metadata: {
      provider: "elevenlabs",
      model: resolvedModel || null,
      fileName: resolvedFileName,
      language: resolvedLanguage || null,
      prompt: resolvedPrompt || null,
      sampleRateHz: resolvedPcm.sampleRateHz,
      source: trace.source || "unknown"
    }
  });

  return transcript;
}

export function isAsrReady(
  deps: AudioServiceDeps,
  { provider = "openai" }: { provider?: string } = {}
) {
  const resolvedProvider = normalizeAudioProvider(provider, "openai");
  if (resolvedProvider === "elevenlabs") {
    return Boolean(String(deps.elevenLabsApiKey || "").trim());
  }
  return Boolean(deps.openai);
}

export function isSpeechSynthesisReady(
  deps: AudioServiceDeps,
  { provider = "openai" }: { provider?: string } = {}
) {
  const resolvedProvider = normalizeAudioProvider(provider, "openai");
  if (resolvedProvider === "elevenlabs") {
    return Boolean(String(deps.elevenLabsApiKey || "").trim());
  }
  return Boolean(deps.openai);
}

export async function transcribeAudio(
  deps: AudioServiceDeps,
  {
    filePath,
    audioBytes = null,
    fileName = "audio.wav",
    provider = "openai",
    model = "gpt-4o-mini-transcribe",
    language = "",
    prompt = "",
    sampleRateHz = 16000,
    baseUrl = DEFAULT_ELEVENLABS_BASE_URL,
    trace = { guildId: null, channelId: null, userId: null, source: null }
  }: {
    filePath?: string | null;
    audioBytes?: Buffer | Uint8Array | ArrayBuffer | null;
    fileName?: string;
    provider?: string;
    model?: string;
    language?: string;
    prompt?: string;
    sampleRateHz?: number;
    baseUrl?: string;
    trace?: LlmTrace;
  }
) {
  const resolvedProvider = normalizeAudioProvider(provider, "openai");
  if (resolvedProvider === "elevenlabs") {
    try {
      return await transcribeAudioWithElevenLabs(deps, {
        filePath,
        audioBytes,
        fileName,
        model,
        language,
        prompt,
        sampleRateHz,
        baseUrl,
        trace
      });
    } catch (error) {
      deps.store.logAction({
        kind: "asr_error",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: String((error as Error)?.message || error),
        metadata: {
          provider: "elevenlabs",
          model: String(model || "").trim() || null,
          language: String(language || "").trim() || null,
          prompt: String(prompt || "").trim() || null,
          source: trace.source || "unknown"
        }
      });
      throw error;
    }
  }

  if (!deps.openai) {
    throw new Error("ASR fallback requires OPENAI_API_KEY.");
  }

  const resolvedModel = String(model || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
  const resolvedLanguage = String(language || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .slice(0, 24);
  const resolvedPrompt = String(prompt || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);

  try {
    const { audioBuffer, fileName: resolvedFileName } = await resolveAudioBytes({
      filePath,
      audioBytes,
      fileName
    });
    const response = await deps.openai.audio.transcriptions.create({
      model: resolvedModel,
      file: new File([new Uint8Array(audioBuffer)], resolvedFileName),
      response_format: "json",
      ...(resolvedLanguage ? { language: resolvedLanguage } : {}),
      ...(resolvedPrompt ? { prompt: resolvedPrompt } : {})
    });
    const rawResponse: unknown = response;

    const text =
      typeof rawResponse === "string"
        ? rawResponse.trim()
        : isTranscriptionTextResponse(rawResponse)
          ? rawResponse.text.trim()
          : String(rawResponse || "").trim();
    if (!text) {
      throw new Error("ASR returned empty transcript.");
    }

    deps.store.logAction({
      kind: "asr_call",
      guildId: trace.guildId,
      channelId: trace.channelId,
      userId: trace.userId,
      content: resolvedModel,
      metadata: {
        provider: "openai",
        model: resolvedModel,
        language: resolvedLanguage || null,
        prompt: resolvedPrompt || null,
        source: trace.source || "unknown"
      }
    });

    return text;
  } catch (error) {
    deps.store.logAction({
      kind: "asr_error",
      guildId: trace.guildId,
      channelId: trace.channelId,
      userId: trace.userId,
      content: String((error as Error)?.message || error),
      metadata: {
        provider: "openai",
        model: resolvedModel,
        language: resolvedLanguage || null,
        prompt: resolvedPrompt || null,
        source: trace.source || "unknown"
      }
    });
    throw error;
  }
}

export async function synthesizeSpeech(
  deps: AudioServiceDeps,
  {
    text,
    provider = "openai",
    model = "gpt-4o-mini-tts",
    voice = "alloy",
    speed = 1,
    responseFormat = "pcm",
    sampleRateHz = 24000,
    baseUrl = DEFAULT_ELEVENLABS_BASE_URL,
    trace = { guildId: null, channelId: null, userId: null, source: null }
  }: {
    text: unknown;
    provider?: string;
    model?: string;
    voice?: string;
    speed?: number;
    responseFormat?: string;
    sampleRateHz?: number;
    baseUrl?: string;
    trace?: LlmTrace;
  }
) {
  const resolvedProvider = normalizeAudioProvider(provider, "openai");
  if (resolvedProvider === "elevenlabs") {
    try {
      return await synthesizeSpeechWithElevenLabs(deps, {
        text,
        model,
        voice,
        speed,
        responseFormat,
        sampleRateHz,
        baseUrl,
        trace
      });
    } catch (error) {
      deps.store.logAction({
        kind: "tts_error",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: String((error as Error)?.message || error),
        metadata: {
          provider: "elevenlabs",
          model: String(model || "").trim() || null,
          voice: String(voice || "").trim() || null,
          speed: clampNumber(speed, 0.7, 1.2, 1),
          responseFormat: "pcm",
          source: trace.source || "unknown"
        }
      });
      throw error;
    }
  }

  if (!deps.openai) {
    throw new Error("Speech synthesis requires OPENAI_API_KEY.");
  }

  const resolvedText = normalizeInlineText(text, 4000);
  if (!resolvedText) {
    throw new Error("Speech synthesis requires non-empty text.");
  }

  const resolvedModel = String(model || "gpt-4o-mini-tts").trim() || "gpt-4o-mini-tts";
  const resolvedVoice = String(voice || "alloy").trim() || "alloy";
  const normalizedFormat = String(responseFormat || "pcm").trim().toLowerCase();
  let resolvedFormat: "opus" | "pcm" | "mp3" | "aac" | "flac" | "wav" = "pcm";
  if (
    normalizedFormat === "opus" ||
    normalizedFormat === "pcm" ||
    normalizedFormat === "mp3" ||
    normalizedFormat === "aac" ||
    normalizedFormat === "flac" ||
    normalizedFormat === "wav"
  ) {
    resolvedFormat = normalizedFormat;
  }
  const resolvedSpeed = clampNumber(speed, 0.25, 2, 1);

  try {
    const response = await deps.openai.audio.speech.create({
      model: resolvedModel,
      voice: resolvedVoice,
      input: resolvedText,
      speed: resolvedSpeed,
      response_format: resolvedFormat
    });
    const audioBuffer = Buffer.from(await response.arrayBuffer());
    if (!audioBuffer.length) {
      throw new Error("Speech synthesis returned empty audio.");
    }

    deps.store.logAction({
      kind: "tts_call",
      guildId: trace.guildId,
      channelId: trace.channelId,
      userId: trace.userId,
      content: resolvedModel,
      metadata: {
        provider: "openai",
        model: resolvedModel,
        voice: resolvedVoice,
        speed: resolvedSpeed,
        responseFormat: resolvedFormat,
        textChars: resolvedText.length,
        source: trace.source || "unknown"
      }
    });

    return {
      audioBuffer,
      model: resolvedModel,
      voice: resolvedVoice,
      speed: resolvedSpeed,
      responseFormat: resolvedFormat
    };
  } catch (error) {
    deps.store.logAction({
      kind: "tts_error",
      guildId: trace.guildId,
      channelId: trace.channelId,
      userId: trace.userId,
      content: String((error as Error)?.message || error),
      metadata: {
        provider: "openai",
        model: resolvedModel,
        voice: resolvedVoice,
        speed: resolvedSpeed,
        responseFormat: resolvedFormat,
        source: trace.source || "unknown"
      }
    });
    throw error;
  }
}
