/**
 * VoiceActivityDetection (VAD) Service
 * 
 * Lightweight client-side Voice Activity Detection using the Web Audio API.
 * Detects when the candidate is speaking vs. silent by analyzing audio
 * energy levels in real-time.
 * 
 * This runs entirely on the client (Edge Processing) per our Adaptive-Hybrid
 * Architecture (PRD 3.2.1) to filter out silence before sending data
 * to the server, saving bandwidth.
 * 
 * For production, this can be swapped with Silero VAD (ONNX model).
 */

class VoiceActivityDetection {
  constructor(options = {}) {
    this.threshold = options.threshold || 0.015;  // Energy threshold for speech
    this.smoothingFactor = options.smoothingFactor || 0.95;
    this.silenceDelay = options.silenceDelay || 800; // ms of silence before "stopped speaking"

    this.audioContext = null;
    this.analyser = null;
    this.mediaStream = null;
    this.isActive = false;
    this.isSpeaking = false;

    this._animFrameId = null;
    this._silenceTimer = null;
    this._smoothedEnergy = 0;

    // Callbacks
    this.onSpeechStart = null;   // () => {}
    this.onSpeechEnd = null;     // () => {}
    this.onEnergyLevel = null;   // (energy: number) => {}
  }

  /**
   * Initialize VAD with a MediaStream (from getUserMedia).
   * @param {MediaStream} stream - Audio stream from the microphone
   */
  async init(stream) {
    this.mediaStream = stream;
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    const source = this.audioContext.createMediaStreamSource(stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = this.smoothingFactor;
    
    source.connect(this.analyser);
    // Do NOT connect analyser to destination (we don't want to play back)
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
    this._detect();
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
  }

  /**
   * Internal detection loop using requestAnimationFrame.
   */
  _detect() {
    if (!this.isActive) return;

    const dataArray = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(dataArray);

    // Calculate RMS energy
    let sumSquares = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sumSquares += dataArray[i] * dataArray[i];
    }
    const rms = Math.sqrt(sumSquares / dataArray.length);

    // Smooth the energy level
    this._smoothedEnergy = this._smoothedEnergy * 0.8 + rms * 0.2;

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
        if (this.onSpeechStart) this.onSpeechStart();
      }
    } else {
      // Below threshold - potential silence
      if (this.isSpeaking && !this._silenceTimer) {
        this._silenceTimer = setTimeout(() => {
          this.isSpeaking = false;
          if (this.onSpeechEnd) this.onSpeechEnd();
          this._silenceTimer = null;
        }, this.silenceDelay);
      }
    }

    this._animFrameId = requestAnimationFrame(() => this._detect());
  }
}

export default VoiceActivityDetection;
