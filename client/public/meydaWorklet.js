/**
 * Meyda AudioWorklet Processor — Phase 2
 *
 * Extracts spectral audio features entirely on the audio thread.
 * Implements simplified DSP for:
 *   - Zero Crossing Rate (ZCR)
 *   - RMS energy
 *   - Spectral Centroid
 *   - Spectral Flatness
 *   - Simplified 13-band MFCC-lite (mel filterbank energies)
 *
 * Thread: Audio Thread (zero main-thread cost)
 * Output: postMessage to main thread at ~10Hz (every ~100ms)
 */

const FFT_SIZE = 512;
const SAMPLE_RATE = 48000;
const MEL_BANDS = 13;
const EMIT_EVERY = 5; // emit every N process() calls (~128 frames each at 48kHz ≈ ~2.7ms)

class MeydaProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._buffer = new Float32Array(FFT_SIZE);
    this._bufferFill = 0;
    this._callCount = 0;
    this._melFilters = this._buildMelFilterbank(MEL_BANDS, FFT_SIZE, SAMPLE_RATE);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0];

    for (let i = 0; i < channelData.length; i++) {
      this._buffer[this._bufferFill++] = channelData[i];
      if (this._bufferFill >= FFT_SIZE) {
        this._bufferFill = 0;
      }
    }

    this._callCount++;
    if (this._callCount % EMIT_EVERY !== 0) return true;

    const frame = this._buffer.slice();
    const features = this._extract(frame, channelData);
    this.port.postMessage({ type: 'features', features });

    return true;
  }

  _extract(frame, rawChunk) {
    const zcr = this._zcr(rawChunk);
    const rms = this._rms(frame);
    const spectrum = this._magnitudeSpectrum(frame);
    const centroid = this._spectralCentroid(spectrum);
    const flatness = this._spectralFlatness(spectrum);
    const melEnergies = this._melEnergies(spectrum);

    return { zcr, rms, centroid, flatness, melEnergies };
  }

  _rms(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    return Math.sqrt(sum / frame.length);
  }

  _zcr(frame) {
    let count = 0;
    for (let i = 1; i < frame.length; i++) {
      if ((frame[i] >= 0) !== (frame[i - 1] >= 0)) count++;
    }
    return count / (frame.length - 1);
  }

  /**
   * Simplified DFT magnitude spectrum (half spectrum, bins 0..N/2).
   * Uses a Hann window for spectral leakage reduction.
   */
  _magnitudeSpectrum(frame) {
    const N = frame.length;
    const half = N >> 1;
    const mag = new Float32Array(half);

    for (let k = 0; k < half; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) {
        const hann = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
        const angle = (2 * Math.PI * k * n) / N;
        re += hann * frame[n] * Math.cos(angle);
        im -= hann * frame[n] * Math.sin(angle);
      }
      mag[k] = Math.sqrt(re * re + im * im) / N;
    }
    return mag;
  }

  _spectralCentroid(mag) {
    let weightedSum = 0, totalMag = 0;
    for (let k = 0; k < mag.length; k++) {
      weightedSum += k * mag[k];
      totalMag += mag[k];
    }
    return totalMag > 0 ? weightedSum / totalMag : 0;
  }

  _spectralFlatness(mag) {
    let logSum = 0, sum = 0;
    const eps = 1e-10;
    for (let k = 0; k < mag.length; k++) {
      const v = Math.max(mag[k], eps);
      logSum += Math.log(v);
      sum += v;
    }
    const geometricMean = Math.exp(logSum / mag.length);
    const arithmeticMean = sum / mag.length;
    return arithmeticMean > 0 ? geometricMean / arithmeticMean : 0;
  }

  /**
   * Build triangular mel filterbank.
   * Returns array of MEL_BANDS filters, each a sparse {start, end, weights} descriptor.
   */
  _buildMelFilterbank(numBands, fftSize, sampleRate) {
    const freqToMel = (f) => 2595 * Math.log10(1 + f / 700);
    const melToFreq = (m) => 700 * (Math.pow(10, m / 2595) - 1);

    const minMel = freqToMel(20);
    const maxMel = freqToMel(sampleRate / 2);
    const melPoints = [];

    for (let i = 0; i <= numBands + 1; i++) {
      melPoints.push(melToFreq(minMel + (i * (maxMel - minMel)) / (numBands + 1)));
    }

    const binWidth = sampleRate / fftSize;
    const filters = [];

    for (let m = 1; m <= numBands; m++) {
      const fLow = melPoints[m - 1];
      const fCenter = melPoints[m];
      const fHigh = melPoints[m + 1];

      const bLow = Math.floor(fLow / binWidth);
      const bCenter = Math.floor(fCenter / binWidth);
      const bHigh = Math.min(Math.floor(fHigh / binWidth), fftSize / 2 - 1);

      const weights = new Float32Array(bHigh - bLow + 1);
      for (let k = bLow; k <= bHigh; k++) {
        if (k <= bCenter) {
          weights[k - bLow] = (k - bLow) / Math.max(bCenter - bLow, 1);
        } else {
          weights[k - bLow] = (bHigh - k) / Math.max(bHigh - bCenter, 1);
        }
      }
      filters.push({ start: bLow, weights });
    }
    return filters;
  }

  _melEnergies(mag) {
    return this._melFilters.map(({ start, weights }) => {
      let energy = 0;
      for (let i = 0; i < weights.length; i++) {
        const bin = start + i;
        if (bin < mag.length) energy += weights[i] * mag[bin];
      }
      return energy;
    });
  }
}

registerProcessor('meyda-processor', MeydaProcessor);
