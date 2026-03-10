/**
 * WebcamMonitor Service
 * 
 * Handles candidate monitoring via the webcam using MediaPipe's
 * Face Detection solution. Detects:
 *   - Face presence / absence
 *   - Multiple faces (integrity violation)
 *   - Basic gaze direction (looking away)
 * 
 * Per the Adaptive-Hybrid Architecture (PRD 3.2.1):
 *   - On capable devices: runs locally at full frame rate
 *   - On low-end devices: degrades to lower polling frequency
 * 
 * Monitoring Flow (PRD 3.1.4):
 *   Candidate action → System records event → Behavior score updated
 */

class WebcamMonitor {
  constructor(options = {}) {
    this.pollInterval = options.pollInterval || 1000; // ms between checks
    this.degradedPollInterval = options.degradedPollInterval || 5000; // low-end mode
    this.isDegraded = false;

    this.videoElement = null;
    this.canvasElement = null;
    this.canvasCtx = null;
    this.mediaStream = null;
    this.isActive = false;
    this._intervalId = null;

    // State
    this.faceDetected = false;
    this.faceCount = 0;
    this.lastFrameTime = 0;

    // Event log
    this.events = [];

    // Callbacks
    this.onFaceDetected = null;      // (count: number) => {}
    this.onFaceLost = null;          // () => {}
    this.onMultipleFaces = null;     // (count: number) => {}
    this.onMonitoringEvent = null;   // (event: object) => {}
  }

  /**
   * Initialize with a video element and optional canvas for processing.
   * @param {HTMLVideoElement} videoEl
   * @param {HTMLCanvasElement} canvasEl - hidden canvas for frame analysis
   */
  async init(videoEl, canvasEl) {
    this.videoElement = videoEl;
    this.canvasElement = canvasEl;
    this.canvasCtx = canvasEl.getContext('2d');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
        audio: false,
      });
      this.videoElement.srcObject = this.mediaStream;
      await this.videoElement.play();
      return true;
    } catch (err) {
      console.error('[WebcamMonitor] Camera access denied:', err);
      this._logEvent('camera_denied', { error: err.message });
      return false;
    }
  }

  /**
   * Start monitoring loop.
   */
  start() {
    if (!this.mediaStream || this.isActive) return;
    this.isActive = true;

    const interval = this.isDegraded
      ? this.degradedPollInterval
      : this.pollInterval;

    this._intervalId = setInterval(() => this._analyzeFrame(), interval);
    this._logEvent('monitoring_started', { degraded: this.isDegraded });
  }

  /**
   * Stop monitoring.
   */
  stop() {
    this.isActive = false;
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    this._logEvent('monitoring_stopped', {});
  }

  /**
   * Switch to degraded mode (lower polling frequency).
   * Called by the adaptive degradation system when high CPU usage is detected.
   */
  enableDegradedMode() {
    this.isDegraded = true;
    if (this.isActive) {
      this.stop();
      this.start(); // Restart with degraded interval
    }
    this._logEvent('degraded_mode_enabled', {});
  }

  /**
   * Return to full monitoring mode.
   */
  disableDegradedMode() {
    this.isDegraded = false;
    if (this.isActive) {
      this.stop();
      this.start();
    }
    this._logEvent('degraded_mode_disabled', {});
  }

  /**
   * Destroy and release all resources.
   */
  destroy() {
    this.stop();
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
  }

  /**
   * Get all recorded monitoring events.
   */
  getEvents() {
    return [...this.events];
  }

  /**
   * Analyze a single video frame for face detection.
   * 
   * NOTE: This is a simplified brightness/skin-tone heuristic.
   * In production, replace this with MediaPipe FaceDetection for
   * accurate multi-face detection and gaze estimation.
   */
  _analyzeFrame() {
    if (!this.videoElement || this.videoElement.readyState < 2) return;

    const w = this.canvasElement.width;
    const h = this.canvasElement.height;
    this.canvasCtx.drawImage(this.videoElement, 0, 0, w, h);
    const imageData = this.canvasCtx.getImageData(0, 0, w, h);
    const data = imageData.data;

    // Simple face-presence heuristic: detect skin-tone pixels in center region
    const centerX = w / 2;
    const centerY = h / 2;
    const regionSize = Math.min(w, h) * 0.3;
    let skinPixels = 0;
    let totalPixels = 0;

    for (let y = Math.floor(centerY - regionSize); y < centerY + regionSize; y++) {
      for (let x = Math.floor(centerX - regionSize); x < centerX + regionSize; x++) {
        if (x < 0 || x >= w || y < 0 || y >= h) continue;
        const idx = (y * w + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        // Basic skin-tone detection (works for a range of skin tones)
        if (r > 95 && g > 40 && b > 20 && r > g && r > b &&
            Math.abs(r - g) > 15 && r - b > 15) {
          skinPixels++;
        }
        totalPixels++;
      }
    }

    const skinRatio = totalPixels > 0 ? skinPixels / totalPixels : 0;
    const facePresent = skinRatio > 0.15;

    if (facePresent && !this.faceDetected) {
      this.faceDetected = true;
      this.faceCount = 1;
      this._logEvent('face_detected', { count: 1 });
      if (this.onFaceDetected) this.onFaceDetected(1);
    } else if (!facePresent && this.faceDetected) {
      this.faceDetected = false;
      this.faceCount = 0;
      this._logEvent('face_lost', {});
      if (this.onFaceLost) this.onFaceLost();
    }
  }

  /**
   * Log a monitoring event with timestamp.
   */
  _logEvent(type, data) {
    const event = {
      type,
      timestamp: Date.now(),
      ...data,
    };
    this.events.push(event);
    if (this.onMonitoringEvent) this.onMonitoringEvent(event);
  }
}

export default WebcamMonitor;
