export function createAnalyser(context: AudioContext, stream: MediaStream) {
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  return { source, analyser };
}

export function readRms(analyser?: AnalyserNode) {
  if (!analyser) return 0;
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  const sum = samples.reduce((total, sample) => total + sample * sample, 0);
  return Math.min(1, Math.sqrt(sum / samples.length));
}
