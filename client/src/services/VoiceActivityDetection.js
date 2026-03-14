/**
 * VoiceActivityDetection (VAD) Service — AudioWorklet Version
 * 
 * Replaces main-thread requestAnimationFrame & AnalyserNode with an AudioWorklet
 * that executes entirely off the main thread.
 * 
 * Upgrades:
 *   ✅ AudioWorklet implementation (audio thread)
 *   ✅ No requestAnimationFrame loop in main thread
 *   ✅ Event-driven architecture
 * 
 * Processing: Edge (client-side, zero server cost)
 * Thread: Audio Thread
 */

class VoiceActivityDetection {
  constructor(options = {}) {
    this.threshold = options.threshold || 0.015;
    this.silenceDelay = options.silenceDelay || 800;

    this.audioContext = null;
    this.source = null;
    this.workletNode = null;
    this.mediaStream = null;
    this.isActive = false;
    this.isSpeaking = false;

    this._smoothedEnergy = 0;

    // Speaking duration tracking
    this._speechStartTime = 0;
    this.totalSpeakingTime = 0;

    // Callbacks
    this.onSpeechStart = null;
    this.onSpeechEnd = null;
    this.onEnergyLevel = null;
  }

  /**
   * Initialize VAD with a MediaStream and load AudioWorklet.
   * @param {MediaStream} stream
   */
  async init(stream) {
    this.mediaStream = stream;
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    // Load the worklet script from public directory
    await this.audioContext.audioWorklet.addModule('/vadWorklet.js');

    this.source = this.audioContext.createMediaStreamSource(stream);
    
    this.workletNode = new AudioWorkletNode(this.audioContext, 'vad-processor', {
      processorOptions: {
        threshold: this.threshold,
        silenceDelay: this.silenceDelay,
      }
    });

    // Handle messages from the audio thread
    this.workletNode.port.onmessage = (event) => {
      if (!this.isActive) return;

      const { type, energy } = event.data;
      
      if (type === 'energy') {
        this._smoothedEnergy = energy;
        if (this.onEnergyLevel) this.onEnergyLevel(energy);
      } else if (type === 'speech_start') {
        this.isSpeaking = true;
        this._speechStartTime = Date.now();
        this._smoothedEnergy = energy || this._smoothedEnergy;
        if (this.onEnergyLevel) this.onEnergyLevel(this._smoothedEnergy);
        if (this.onSpeechStart) this.onSpeechStart();
      } else if (type === 'speech_end') {
        this.totalSpeakingTime += Date.now() - this._speechStartTime;
        this.isSpeaking = false;
        if (this.onSpeechEnd) this.onSpeechEnd();
      }
    };

    // Connect source to worklet, but not to destination (no playback)
    this.source.connect(this.workletNode);
  }

  /**
   * Start detecting voice activity.
   */
  start() {
    if (!this.workletNode) {
      console.error('[VAD] Not initialized. Call init(stream) first.');
      return;
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
    this.isActive = true;
  }

  /**
   * Stop detecting voice activity.
   */
  stop() {
    this.isActive = false;
    if (this.isSpeaking) {
      this.totalSpeakingTime += Date.now() - this._speechStartTime;
      this.isSpeaking = false;
    }
    if (this.audioContext && this.audioContext.state === 'running') {
      this.audioContext.suspend();
    }
  }

  /**
   * Unused for AudioWorklet but kept for compatibility with useInterview hook
   */
  enableDegradedMode() {
    if (this.workletNode) {
      // Could increase smoothing factor or silence delay if needed
    }
  }

  disableDegradedMode() {
  }

  /**
   * Clean up all resources.
   */
  destroy() {
    this.stop();
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
    }
    this.audioContext = null;
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
      isDegraded: false,
    };
  }
}

export default VoiceActivityDetection;
