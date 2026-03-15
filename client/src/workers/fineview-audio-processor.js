import Meyda from 'meyda';

const BUFFER_SIZE = 512;
const SAMPLE_RATE = 44100;
const WINDOW_SECONDS = 5;
const WINDOW_FRAMES = Math.ceil((SAMPLE_RATE / BUFFER_SIZE) * WINDOW_SECONDS);

class WindowAggregator {
  constructor() {
    this.frames = [];
  }

  push(features) {
    this.frames.push(features);
    if (this.frames.length >= WINDOW_FRAMES) {
      const out = this.summary();
      this.frames = [];
      return out;
    }
    return null;
  }

  summary() {
    const get = (k) => this.frames.map((f) => f[k]).filter((v) => v != null);
    const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

    const rms = get('rms');
    const energy = get('energy');
    const zcr = get('zcr');
    const flat = get('spectralFlatness');
    const cent = get('spectralCentroid');

    const mfccAll = this.frames.map((f) => f.mfcc || []);
    const mfcc_mean = Array.from({ length: 13 }, (_, i) =>
      avg(mfccAll.map((m) => m[i] || 0)),
    );

    const silenceRatio = rms.length
      ? rms.filter((v) => v < 0.02).length / rms.length
      : 0;

    return {
      rms_avg: avg(rms),
      rms_min: rms.length ? Math.min(...rms) : 0,
      rms_max: rms.length ? Math.max(...rms) : 0,
      energy_avg: avg(energy),
      zcr_avg: avg(zcr),
      spectralFlatness_avg: avg(flat),
      spectralCentroid_avg: avg(cent),
      mfcc_mean,
      silenceRatio,
      frameCount: this.frames.length,
    };
  }
}

class FineviewProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(BUFFER_SIZE);
    this.pos = 0;
    this.agg = new WindowAggregator();
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    for (let i = 0; i < input.length; i++) {
      this.buf[this.pos++] = input[i];
      if (this.pos === BUFFER_SIZE) {
        const features = Meyda.extract(
          [
            'rms',
            'energy',
            'zcr',
            'spectralCentroid',
            'spectralFlatness',
            'spectralSpread',
            'mfcc',
          ],
          this.buf,
        );
        const summary = this.agg.push(features);
        if (summary) {
          this.port.postMessage({ type: 'audioFeatures', summary });
        }
        this.pos = 0;
      }
    }
    return true;
  }
}

registerProcessor('fineview-audio-processor', FineviewProcessor);

