import {
  VOICE_SILENCE_GATE_ACTIVE_RATIO_MAX,
  VOICE_SILENCE_GATE_ACTIVE_SAMPLE_MIN_ABS,
  VOICE_SILENCE_GATE_MIN_CLIP_MS,
  VOICE_SILENCE_GATE_PEAK_MAX,
  VOICE_SILENCE_GATE_RMS_MAX
} from "./voiceSessionManager.constants.ts";

export type MonoPcmSignalAnalysis = {
  sampleCount: number;
  rms: number;
  peak: number;
  activeSampleRatio: number;
};

export type PcmSilenceGateEvaluation = MonoPcmSignalAnalysis & {
  clipDurationMs: number;
  drop: boolean;
};

type PcmBufferLike = Buffer | Uint8Array | ArrayBuffer | ArrayLike<number> | null | undefined;

function getPcmByteLength(pcmBuffer: PcmBufferLike) {
  if (!pcmBuffer) return 0;
  if (Buffer.isBuffer(pcmBuffer) || pcmBuffer instanceof Uint8Array) {
    return pcmBuffer.length;
  }
  if (pcmBuffer instanceof ArrayBuffer) {
    return pcmBuffer.byteLength;
  }
  return Math.max(0, Number(pcmBuffer.length) || 0);
}

function toPcmBuffer(pcmBuffer: PcmBufferLike) {
  if (Buffer.isBuffer(pcmBuffer)) return pcmBuffer;
  if (pcmBuffer instanceof Uint8Array) return Buffer.from(pcmBuffer);
  if (pcmBuffer instanceof ArrayBuffer) return Buffer.from(new Uint8Array(pcmBuffer));
  return Buffer.from(pcmBuffer || []);
}

export function estimatePcm16MonoDurationMs(pcmByteLength: number, sampleRateHz = 24000) {
  const normalizedBytes = Math.max(0, Number(pcmByteLength) || 0);
  const normalizedRate = Math.max(1, Number(sampleRateHz) || 24000);
  return Math.round((normalizedBytes / (2 * normalizedRate)) * 1000);
}

export function estimateDiscordPcmPlaybackDurationMs(pcmByteLength: number) {
  const normalizedBytes = Math.max(0, Number(pcmByteLength) || 0);
  const bytesPerSecond = 48_000 * 2 * 2;
  return Math.round((normalizedBytes / bytesPerSecond) * 1000);
}

export function analyzeMonoPcmSignal(pcmBuffer: PcmBufferLike): MonoPcmSignalAnalysis {
  const buffer = toPcmBuffer(pcmBuffer);
  const evenByteLength = Math.max(0, buffer.length - (buffer.length % 2));
  if (evenByteLength <= 0) {
    return {
      sampleCount: 0,
      rms: 0,
      peak: 0,
      activeSampleRatio: 0
    };
  }

  let sumSquares = 0;
  let peakAbs = 0;
  let activeSamples = 0;
  const sampleCount = evenByteLength / 2;
  for (let offset = 0; offset < evenByteLength; offset += 2) {
    const sample = buffer.readInt16LE(offset);
    const absSample = Math.abs(sample);
    sumSquares += sample * sample;
    if (absSample > peakAbs) {
      peakAbs = absSample;
    }
    if (absSample >= VOICE_SILENCE_GATE_ACTIVE_SAMPLE_MIN_ABS) {
      activeSamples += 1;
    }
  }

  const rmsAbs = Math.sqrt(sumSquares / sampleCount);
  return {
    sampleCount,
    rms: rmsAbs / 32768,
    peak: peakAbs / 32768,
    activeSampleRatio: activeSamples / sampleCount
  };
}

export function evaluatePcmSilenceGate({
  pcmBuffer,
  sampleRateHz = 24000
}: {
  pcmBuffer: PcmBufferLike;
  sampleRateHz?: number;
}): PcmSilenceGateEvaluation {
  const clipDurationMs = estimatePcm16MonoDurationMs(getPcmByteLength(pcmBuffer), sampleRateHz);
  const signal = analyzeMonoPcmSignal(pcmBuffer);
  const eligibleForGate = clipDurationMs >= VOICE_SILENCE_GATE_MIN_CLIP_MS;
  const nearSilentSignal =
    signal.rms <= VOICE_SILENCE_GATE_RMS_MAX &&
    signal.peak <= VOICE_SILENCE_GATE_PEAK_MAX &&
    signal.activeSampleRatio <= VOICE_SILENCE_GATE_ACTIVE_RATIO_MAX;

  return {
    clipDurationMs,
    ...signal,
    drop: Boolean(eligibleForGate && nearSilentSignal)
  };
}
