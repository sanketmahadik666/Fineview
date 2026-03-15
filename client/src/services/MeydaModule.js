/**
 * MeydaModule — Phase 2
 *
 * Wraps the meydaWorklet.js AudioWorkletProcessor.
 * Provides real-time spectral audio feature extraction running entirely
 * on the audio thread (zero main-thread overhead).
 *
 * Features extracted:
 *   - ZCR    (Zero Crossing Rate)   — correlates with consonant activity / voiced speech
 *   - RMS    (energy)               — raw loudness, complements VAD
 *   - centroid                      — spectral brightness / pitch proxy
 *   - flatness                      — noise vs tonal signal ratio
 *   - melEnergies[13]               — mel-band energies (MFCC precursor)
 *
 * Thread: Audio Thread (via AudioWorklet)
 * Processing: Edge / client-side
 */

export default class MeydaModule {
  constructor(options = {}) {
    this.audioContext = null;
    this.source = null;
    this.workletNode = null;
    this.isActive = false;

    this._latestFeatures = null;
    this._featureHistory = [];
    this._maxHistory = options.maxHistory || 60;

    this.onFeatures = null;
  }

  /**
   * Attach to an existing AudioContext and MediaStream source.
   * Call after VAD has already set up the AudioContext to share it.
   *
   * @param {AudioContext} audioContext  Shared audio context
   * @param {MediaStreamAudioSourceNode} source  Already-created source node
   */
  async init(audioContext, source) {
    this.audioContext = audioContext;
    this.source = source;

    try {
      await this.audioContext.audioWorklet.addModule('/meydaWorklet.js');

      this.workletNode = new AudioWorkletNode(this.audioContext, 'meyda-processor');

      this.workletNode.port.onmessage = (event) => {
        if (!this.isActive) return;
        if (event.data?.type === 'features') {
          this._latestFeatures = event.data.features;
          this._featureHistory.push({
            timestamp: Date.now(),
            ...event.data.features,
          });
          if (this._featureHistory.length > this._maxHistory) {
            this._featureHistory.shift();
          }
          if (this.onFeatures) this.onFeatures(event.data.features);
        }
      };

      this.source.connect(this.workletNode);
      return true;
    } catch (err) {
      console.error('[MeydaModule] Failed to initialize AudioWorklet:', err.message);
      return false;
    }
  }

  start() {
    this.isActive = true;
  }

  stop() {
    this.isActive = false;
  }

  destroy() {
    this.stop();
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
  }

  /**
   * Returns the most recently extracted feature frame.
   * @returns {object|null}
   */
  getLatestFeatures() {
    return this._latestFeatures;
  }

  /**
   * Returns rolling history of feature frames (up to maxHistory).
   * Useful for downstream ML inference or visualization.
   * @returns {Array}
   */
  getFeatureHistory() {
    return [...this._featureHistory];
  }

  /**
   * Compute aggregate stats over the history window.
   * Returns mean and variance for each scalar feature.
   */
  getStats() {
    const h = this._featureHistory;
    if (h.length === 0) return null;

    const keys = ['zcr', 'rms', 'centroid', 'flatness'];
    const stats = {};

    for (const key of keys) {
      const vals = h.map((f) => f[key]).filter((v) => v !== undefined);
      if (vals.length === 0) continue;
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const variance =
        vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
      stats[key] = { mean, variance, stdDev: Math.sqrt(variance) };
    }

    return stats;
  }
}
