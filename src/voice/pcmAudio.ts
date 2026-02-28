function clamp16(value) {
  return Math.max(-32768, Math.min(32767, value));
}

function toAlignedInt16Samples(input) {
  const source = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const evenByteLength = source.length - (source.length % 2);
  if (evenByteLength <= 0) {
    return new Int16Array(0);
  }

  const view = source.subarray(0, evenByteLength);
  if (view.byteOffset % 2 === 0) {
    return new Int16Array(view.buffer, view.byteOffset, evenByteLength / 2);
  }

  const aligned = Buffer.from(view);
  return new Int16Array(aligned.buffer, aligned.byteOffset, aligned.length / 2);
}

function int16ArrayToBuffer(samples) {
  if (!samples.length) return Buffer.alloc(0);
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

function downmixStereo16ToMono16(input) {
  const stereoSamples = toAlignedInt16Samples(input);
  const frameCount = Math.floor(stereoSamples.length / 2);
  if (frameCount <= 0) return Buffer.alloc(0);

  const monoSamples = new Int16Array(frameCount);
  for (let index = 0; index < frameCount; index += 1) {
    const left = stereoSamples[index * 2];
    const right = stereoSamples[index * 2 + 1];
    monoSamples[index] = clamp16(Math.round((left + right) / 2));
  }

  return int16ArrayToBuffer(monoSamples);
}

function resampleMono16(input, inputSampleRate, outputSampleRate) {
  const inRate = Number(inputSampleRate) || 0;
  const outRate = Number(outputSampleRate) || 0;
  if (inRate <= 0 || outRate <= 0) return Buffer.alloc(0);

  const inputSamples = toAlignedInt16Samples(input);
  if (inputSamples.length <= 0) return Buffer.alloc(0);
  if (inRate === outRate) return int16ArrayToBuffer(inputSamples);
  if (inputSamples.length <= 1) return Buffer.alloc(0);

  const ratio = inRate / outRate;
  const outputSampleCount = Math.max(1, Math.floor(inputSamples.length / ratio));
  const outputSamples = new Int16Array(outputSampleCount);

  for (let index = 0; index < outputSampleCount; index += 1) {
    const sourcePosition = index * ratio;
    const sourceIndex = Math.floor(sourcePosition);
    const nextIndex = Math.min(sourceIndex + 1, inputSamples.length - 1);
    const fraction = sourcePosition - sourceIndex;

    const first = inputSamples[sourceIndex];
    const second = inputSamples[nextIndex];
    outputSamples[index] = clamp16(Math.round(first + fraction * (second - first)));
  }

  return int16ArrayToBuffer(outputSamples);
}

function mono16ToStereo16(input) {
  const inputSamples = toAlignedInt16Samples(input);
  const sampleCount = inputSamples.length;
  if (sampleCount <= 0) return Buffer.alloc(0);

  const outputSamples = new Int16Array(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = inputSamples[index];
    outputSamples[index * 2] = sample;
    outputSamples[index * 2 + 1] = sample;
  }

  return int16ArrayToBuffer(outputSamples);
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
