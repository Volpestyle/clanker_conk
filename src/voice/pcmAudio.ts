function clamp16(value) {
  return Math.max(-32768, Math.min(32767, value));
}

export function downmixStereo16ToMono16(input) {
  const frameCount = Math.floor(input.length / 4);
  if (frameCount <= 0) return Buffer.alloc(0);

  const output = Buffer.alloc(frameCount * 2);
  for (let i = 0; i < frameCount; i += 1) {
    const left = input.readInt16LE(i * 4);
    const right = input.readInt16LE(i * 4 + 2);
    const mixed = clamp16(Math.round((left + right) / 2));
    output.writeInt16LE(mixed, i * 2);
  }
  return output;
}

export function resampleMono16(input, inputSampleRate, outputSampleRate) {
  const inRate = Number(inputSampleRate) || 0;
  const outRate = Number(outputSampleRate) || 0;
  if (inRate <= 0 || outRate <= 0) return Buffer.alloc(0);
  if (inRate === outRate) return Buffer.from(input);

  const inputSamples = Math.floor(input.length / 2);
  if (inputSamples <= 1) return Buffer.alloc(0);

  const ratio = inRate / outRate;
  const outputSamples = Math.max(1, Math.floor(inputSamples / ratio));
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i += 1) {
    const sourcePosition = i * ratio;
    const sourceIndex = Math.floor(sourcePosition);
    const nextIndex = Math.min(sourceIndex + 1, inputSamples - 1);
    const fraction = sourcePosition - sourceIndex;

    const s0 = input.readInt16LE(sourceIndex * 2);
    const s1 = input.readInt16LE(nextIndex * 2);
    const sample = clamp16(Math.round(s0 + fraction * (s1 - s0)));
    output.writeInt16LE(sample, i * 2);
  }

  return output;
}

export function mono16ToStereo16(input) {
  const sampleCount = Math.floor(input.length / 2);
  if (sampleCount <= 0) return Buffer.alloc(0);

  const output = Buffer.alloc(sampleCount * 4);
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = input.readInt16LE(i * 2);
    output.writeInt16LE(sample, i * 4);
    output.writeInt16LE(sample, i * 4 + 2);
  }

  return output;
}

export function convertDiscordPcmToXaiInput(discordPcm, outputSampleRate = 24000) {
  const mono48k = downmixStereo16ToMono16(discordPcm);
  if (!mono48k.length) return Buffer.alloc(0);
  const normalizedOutputRate = Math.max(8000, Math.min(48000, Number(outputSampleRate) || 24000));
  return resampleMono16(mono48k, 48000, normalizedOutputRate);
}

export function convertXaiOutputToDiscordPcm(xaiPcm, inputSampleRate = 24000) {
  const mono48k = resampleMono16(xaiPcm, inputSampleRate, 48000);
  if (!mono48k.length) return Buffer.alloc(0);
  return mono16ToStereo16(mono48k);
}
