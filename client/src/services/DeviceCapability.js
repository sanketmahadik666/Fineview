/**
 * DeviceCapability Service
 * 
 * Verifies the candidate's device capabilities before and during the
 * interview session. This is the gatekeeper for the Adaptive Degradation
 * strategy (PRD 3.2.1).
 * 
 * Checks:
 *   - Browser support (WebRTC, MediaDevices, WebGL, WebSocket)
 *   - Microphone availability
 *   - Camera availability
 *   - Estimated hardware performance (via a simple benchmark)
 * 
 * Workflow (PRD 3.1.1):
 *   Candidate joins → System verifies device capability →
 *   Candidate grants permissions → Interview begins
 */

class DeviceCapability {
  constructor() {
    this.results = {
      browser: {},
      permissions: {},
      performance: {},
      overall: 'unknown', // 'high', 'medium', 'low', 'unsupported'
    };
  }

  /**
   * Run all capability checks.
   * @returns {object} Full results object
   */
  async checkAll() {
    this.results.browser = this._checkBrowserAPIs();
    this.results.permissions = await this._checkPermissions();
    this.results.performance = await this._benchmarkDevice();
    this.results.overall = this._computeOverallRating();
    return this.results;
  }

  /**
   * Check if the browser supports required APIs.
   */
  _checkBrowserAPIs() {
    return {
      webRTC: !!(
        window.RTCPeerConnection ||
        window.webkitRTCPeerConnection ||
        window.mozRTCPeerConnection
      ),
      mediaDevices: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      webGL: (() => {
        try {
          const canvas = document.createElement('canvas');
          return !!(
            canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
          );
        } catch (e) {
          return false;
        }
      })(),
      webSocket: !!window.WebSocket,
      speechRecognition: !!(
        window.SpeechRecognition || window.webkitSpeechRecognition
      ),
      audioContext: !!(window.AudioContext || window.webkitAudioContext),
    };
  }

  /**
   * Request and verify microphone and camera permissions.
   */
  async _checkPermissions() {
    const result = { microphone: false, camera: false };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });
      result.microphone = stream.getAudioTracks().length > 0;
      result.camera = stream.getVideoTracks().length > 0;
      // Release the stream immediately
      stream.getTracks().forEach((track) => track.stop());
    } catch (err) {
      console.warn('[DeviceCapability] Media permission denied:', err.message);
    }

    return result;
  }

  /**
   * Quick benchmark to estimate device performance class.
   * Runs a short computation and measures execution time.
   */
  async _benchmarkDevice() {
    const iterations = 1_000_000;
    const start = performance.now();
    
    // Simple computational benchmark
    let val = 0;
    for (let i = 0; i < iterations; i++) {
      val += Math.sqrt(i) * Math.sin(i);
    }
    
    const duration = performance.now() - start;

    // Classify:
    //   < 50ms  → high
    //   < 150ms → medium
    //   >= 150ms → low
    let tier = 'low';
    if (duration < 50) tier = 'high';
    else if (duration < 150) tier = 'medium';

    return {
      benchmarkTime: Math.round(duration),
      tier,
      hardwareConcurrency: navigator.hardwareConcurrency || 'unknown',
      deviceMemory: navigator.deviceMemory || 'unknown',
    };
  }

  /**
   * Compute an overall device rating.
   */
  _computeOverallRating() {
    const { browser, permissions, performance: perf } = this.results;

    // Must-have APIs
    if (!browser.mediaDevices || !browser.webSocket) {
      return 'unsupported';
    }

    // SpeechRecognition is required for the current UX (no text fallback yet)
    if (!browser.speechRecognition) {
      return 'unsupported';
    }

    // Must have permissions
    if (!permissions.microphone || !permissions.camera) {
      return 'unsupported';
    }

    // Performance tier drives the rest
    return perf.tier; // 'high', 'medium', or 'low'
  }

  /**
   * Should the system enable degraded monitoring mode?
   * @returns {boolean}
   */
  shouldDegrade() {
    return this.results.overall === 'low';
  }
}

export default DeviceCapability;
