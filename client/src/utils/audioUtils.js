export function toBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

export function floatToPcm16(float32) {
  const pcm = new Int16Array(float32.length);

  for (let i = 0; i < float32.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32[i]));
    pcm[i] = sample < 0 ? sample * 32768 : sample * 32767;
  }

  return pcm;
}

export function resample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;

  const ratio = fromRate / toRate;
  const output = new Float32Array(Math.floor(input.length / ratio));

  for (let i = 0; i < output.length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);

    let sum = 0;

    for (let j = start; j < Math.max(start + 1, end); j += 1) {
      sum += input[Math.min(j, input.length - 1)];
    }

    output[i] = sum / Math.max(1, end - start);
  }

  return output;
}
