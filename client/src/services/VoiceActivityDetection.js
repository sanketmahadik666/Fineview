/**
 * VoiceActivityDetection (VAD) Service — v2 (Production-Grade)
 * 
 * Lightweight client-side Voice Activity Detection using the Web Audio API.
 * 
 * v2 Upgrades (from Use-Case Strategy Matrix):
 *   ✅ Timestamp-based smoothing (frame-rate independent)
 *   ✅ Degraded mode support (fftSize 256 for low-end devices)
 *   ✅ Reusable Float32Array buffer (no per-frame allocation)
 *   ✅ Speaking duration tracking
 *   ✅ AudioWorklet-ready structure for production swap
 * 
 * Processing: Edge (client-side, zero server cost)
 * Thread: Main thread via rAF (< 0.02ms/frame)
 * Bandwidth saving: Filters silence before any server communication
 */

class VoiceActivityDetection {
  constructor(options = {}) {
    this.threshold = options.threshold || 0.015;
    this.silenceDelay = options.silenceDelay || 800;
    this.degradedFftSize = options.degradedFftSize || 256;
    this.normalFftSize = options.normalFftSize || 512;

    this.audioContext = null;
    this.analyser = null;
    this.source = null;
    this.mediaStream = null;
    this.isActive = false;
    this.isSpeaking = false;
    this.isDegraded = false;

    // Reusable buffer (avoid per-frame allocation — ref: Performance Guide §1.3)
    this._dataArray = null;

    this._animFrameId = null;
    this._silenceTimer = null;
    this._smoothedEnergy = 0;
    this._lastTimestamp = 0;

    // Speaking duration tracking
    this._speechStartTime = 0;
    this.totalSpeakingTime = 0;

    // Callbacks
    this.onSpeechStart = null;
    this.onSpeechEnd = null;
    this.onEnergyLevel = null;
  }

  /**
   * Initialize VAD with a MediaStream (from getUserMedia).
   * @param {MediaStream} stream
   * @param {boolean} degraded - start in degraded mode
   */
  async init(stream, degraded = false) {
    this.mediaStream = stream;
    this.isDegraded = degraded;
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

    this.source = this.audioContext.createMediaStreamSource(stream);
    this.analyser = this.audioContext.createAnalyser();
    
    const fftSize = degraded ? this.degradedFftSize : this.normalFftSize;
    this.analyser.fftSize = fftSize;
    this.analyser.smoothingTimeConstant = 0.85;

    this.source.connect(this.analyser);
    // NOT connected to destination — no audio playback

    // Pre-allocate reusable buffer
    this._dataArray = new Float32Array(fftSize);
  }

  /**
   * Start detecting voice activity.
   */
  start() {
    if (!this.analyser) {
      console.error('[VAD] Not initialized. Call init(stream) first.');
      return;
    }
    this.isActive = true;
    this._lastTimestamp = 0;
    this._detect(performance.now());
  }

  /**
   * Stop detecting voice activity.
   */
  stop() {
    this.isActive = false;
    if (this._animFrameId) {
      cancelAnimationFrame(this._animFrameId);
      this._animFrameId = null;
    }
    if (this._silenceTimer) {
      clearTimeout(this._silenceTimer);
      this._silenceTimer = null;
    }
    // Finalize speaking duration if still speaking
    if (this.isSpeaking) {
      this.totalSpeakingTime += Date.now() - this._speechStartTime;
      this.isSpeaking = false;
    }
  }

  /**
   * Switch to degraded mode (smaller fftSize = less CPU).
   * Called by adaptive degradation system.
   */
  enableDegradedMode() {
    if (this.isDegraded) return;
    this.isDegraded = true;
    this.analyser.fftSize = this.degradedFftSize;
    this._dataArray = new Float32Array(this.degradedFftSize);
  }

  /**
   * Return to full mode.
   */
  disableDegradedMode() {
    if (!this.isDegraded) return;
    this.isDegraded = false;
    this.analyser.fftSize = this.normalFftSize;
    this._dataArray = new Float32Array(this.normalFftSize);
  }

  /**
   * Clean up all resources.
   */
  destroy() {
    this.stop();
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
    }
    this.audioContext = null;
    this.analyser = null;
    this.source = null;
    this._dataArray = null;
  }

  /**
   * Get speaking statistics.
   */
  getStats() {
    let currentSpeaking = 0;
    if (this.isSpeaking) {
      currentSpeaking = Date.now() - this._speechStartTime;
    }
    return {
      totalSpeakingTime: this.totalSpeakingTime + currentSpeaking,
      isSpeaking: this.isSpeaking,
      currentEnergy: this._smoothedEnergy,
      isDegraded: this.isDegraded,
    };
  }

  /**
   * Internal detection loop using requestAnimationFrame.
   * 
   * Key design (from rAF docs):
   *   - Uses DOMHighResTimeStamp for frame-rate-independent smoothing
   *   - Auto-pauses when tab is hidden (desired behavior — saves CPU)
   *   - Reuses pre-allocated Float32Array (no GC pressure)
   */
  _detect(timestamp) {
    if (!this.isActive) return;

    // Frame-rate independent smoothing (ref: rAF MDN docs)
    const deltaTime = this._lastTimestamp ? (timestamp - this._lastTimestamp) : 16.67;
    this._lastTimestamp = timestamp;

    // Reuse pre-allocated buffer
    this.analyser.getFloatTimeDomainData(this._dataArray);

    // Calculate RMS energy
    let sumSquares = 0;
    const len = this._dataArray.length;
    for (let i = 0; i < len; i++) {
      const sample = this._dataArray[i];
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / len);

    // Time-scaled exponential smoothing
    // At 60fps (dt=16.67ms), alpha ≈ 0.33 → responsive
    // At 30fps (dt=33.33ms), alpha ≈ 0.67 → catches up
    const alpha = Math.min(deltaTime / 50, 1);
    this._smoothedEnergy = this._smoothedEnergy * (1 - alpha) + rms * alpha;

    if (this.onEnergyLevel) {
      this.onEnergyLevel(this._smoothedEnergy);
    }

    if (this._smoothedEnergy > this.threshold) {
      // Voice detected
      if (this._silenceTimer) {
        clearTimeout(this._silenceTimer);
        this._silenceTimer = null;
      }

      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this._speechStartTime = Date.now();
        if (this.onSpeechStart) this.onSpeechStart();
      }
    } else {
      // Below threshold — potential silence
      if (this.isSpeaking && !this._silenceTimer) {
        this._silenceTimer = setTimeout(() => {
          this.totalSpeakingTime += Date.now() - this._speechStartTime;
          this.isSpeaking = false;
          if (this.onSpeechEnd) this.onSpeechEnd();
          this._silenceTimer = null;
        }, this.silenceDelay);
      }
    }

    this._animFrameId = requestAnimationFrame((ts) => this._detect(ts));
  }
}

export default VoiceActivityDetection;
