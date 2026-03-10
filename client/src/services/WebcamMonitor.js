/**
 * WebcamMonitor Service — v2 (Production-Grade)
 * 
 * v2 Upgrades (from Use-Case Strategy Matrix):
 *   ✅ Web Worker offloading — frame analysis runs off main thread
 *   ✅ Transferable ArrayBuffer — zero-copy pixel data transfer
 *   ✅ Event log cap (500 max) — prevents memory leak
 *   ✅ Frame timing metrics — tracks actual vs target fps
 *   ✅ Only sends state CHANGES to server (not every frame)
 * 
 * Processing: Edge (client-side), Worker thread
 * INP impact: Zero — all heavy work runs in Worker
 */

class WebcamMonitor {
  constructor(options = {}) {
    this.pollInterval = options.pollInterval || 1000;
    this.degradedPollInterval = options.degradedPollInterval || 5000;
    this.maxEvents = options.maxEvents || 500;
    this.isDegraded = false;

    this.videoElement = null;
    this.canvasElement = null;
    this.canvasCtx = null;
    this.mediaStream = null;
    this.isActive = false;
    this._intervalId = null;
    this._worker = null;

    // State
    this.faceDetected = false;
    this.faceCount = 0;
    this.isLookingAway = false;

    // Performance metrics
    this._frameCount = 0;
    this._startTime = 0;

    // Event log (capped)
    this.events = [];

    // Callbacks
    this.onFaceDetected = null;
    this.onFaceLost = null;
    this.onMultipleFaces = null;
    this.onMonitoringEvent = null;
  }

  /**
   * Initialize with video/canvas elements.
   * Spawns the Web Worker for off-thread analysis.
   */
  async init(videoEl, canvasEl) {
    this.videoElement = videoEl;
    this.canvasElement = canvasEl;
    this.canvasCtx = canvasEl.getContext('2d', { willReadFrequently: true });

    // Spawn dedicated worker (ref: MDN Web Workers)
    try {
      this._worker = new Worker(
        new URL('./webcamWorker.js', import.meta.url),
        { type: 'module' }
      );
      this._worker.onmessage = (e) => this._handleWorkerResult(e.data);
      this._worker.onerror = (err) => {
        console.error('[WebcamMonitor] Worker error:', err);
        // Fallback: run on main thread if worker fails
        this._worker = null;
      };
    } catch (err) {
      console.warn('[WebcamMonitor] Worker not supported, using main thread fallback');
      this._worker = null;
    }

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
    this._frameCount = 0;
    this._startTime = Date.now();

    const interval = this.isDegraded ? this.degradedPollInterval : this.pollInterval;
    this._intervalId = setInterval(() => this._captureAndAnalyze(), interval);
    this._logEvent('monitoring_started', { degraded: this.isDegraded });
  }

  stop() {
    this.isActive = false;
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    this._logEvent('monitoring_stopped', {
      framesAnalyzed: this._frameCount,
      duration: Date.now() - this._startTime,
    });
  }

  enableDegradedMode() {
    if (this.isDegraded) return;
    this.isDegraded = true;
    if (this.isActive) { this.stop(); this.start(); }
    this._logEvent('degraded_mode_enabled', {});
  }

  disableDegradedMode() {
    if (!this.isDegraded) return;
    this.isDegraded = false;
    if (this.isActive) { this.stop(); this.start(); }
    this._logEvent('degraded_mode_disabled', {});
  }

  destroy() {
    this.stop();
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
  }

  getEvents() {
    return [...this.events];
  }

  getStats() {
    const elapsed = (Date.now() - this._startTime) / 1000;
    return {
      framesAnalyzed: this._frameCount,
      actualFps: elapsed > 0 ? (this._frameCount / elapsed).toFixed(2) : 0,
      targetFps: this.isDegraded ? 0.2 : 1,
      isDegraded: this.isDegraded,
      faceDetected: this.faceDetected,
      eventCount: this.events.length,
    };
  }

  // --- Internal ---

  /**
   * Capture frame and send to Worker via Transferable ArrayBuffer.
   * Main thread cost: only drawImage + getImageData (~1ms).
   * Analysis cost: ZERO on main thread (runs in worker).
   */
  _captureAndAnalyze() {
    if (!this.videoElement || this.videoElement.readyState < 2) return;

    const w = this.canvasElement.width;
    const h = this.canvasElement.height;
    this.canvasCtx.drawImage(this.videoElement, 0, 0, w, h);
    const imageData = this.canvasCtx.getImageData(0, 0, w, h);

    this._frameCount++;

    if (this._worker) {
      // Send to worker via Transferable (zero-copy)
      const buffer = imageData.data.buffer;
      this._worker.postMessage(
        { buffer, width: w, height: h },
        [buffer]  // Transfer ownership — zero-copy!
      );
    } else {
      // Fallback: main thread analysis
      this._analyzeOnMainThread(imageData.data, w, h);
    }
  }

  /**
   * Handle result from Worker.
   */
  _handleWorkerResult(data) {
    if (data.type === 'init_success') {
      console.log('[WebcamMonitor] MediaPipe initialized off-thread.');
      return;
    }
    if (data.type === 'init_error') {
      console.error('[WebcamMonitor] MediaPipe failed:', data.error);
      return;
    }
    
    if (data.type === 'analysis_result') {
      const { faceDetected, faceCount, isLookingAway } = data;
      this._updateFaceState(faceDetected, faceCount, isLookingAway);
    }
  }

  /**
   * Fallback: run analysis on main thread (if Worker unavailable).
   */
  _analyzeOnMainThread(data, w, h) {
    const centerX = w / 2;
    const centerY = h / 2;
    const regionSize = Math.min(w, h) * 0.3;
    let skinPixels = 0;
    let totalPixels = 0;

    const startY = Math.max(0, Math.floor(centerY - regionSize));
    const endY = Math.min(h, Math.floor(centerY + regionSize));
    const startX = Math.max(0, Math.floor(centerX - regionSize));
    const endX = Math.min(w, Math.floor(centerX + regionSize));

    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const idx = (y * w + x) * 4;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        if (r > 95 && g > 40 && b > 20 && r > g && r > b &&
            Math.abs(r - g) > 15 && r - b > 15) {
          skinPixels++;
        }
        totalPixels++;
      }
    }

    const skinRatio = totalPixels > 0 ? skinPixels / totalPixels : 0;
    this._updateFaceState(skinRatio > 0.15, skinRatio > 0.15 ? 1 : 0);
  }

  /**
   * Update face state — only fires callbacks on STATE CHANGES.
   * This means we only send events to the server when something changes,
   * not every frame (bandwidth optimization from strategy matrix).
   */
  _updateFaceState(detected, count, lookingAway = false) {
    // Face Presences
    if (detected && !this.faceDetected) {
      this.faceDetected = true;
      this.faceCount = count;
      this._logEvent('face_detected', { count });
      if (this.onFaceDetected) this.onFaceDetected(count);
    } else if (!detected && this.faceDetected) {
      this.faceDetected = false;
      this.faceCount = 0;
      this._logEvent('face_lost', {});
      if (this.onFaceLost) this.onFaceLost();
    }

    // Multiple faces trigger
    if (detected && count > 1 && this.faceCount !== count) {
      this.faceCount = count;
      this._logEvent('multiple_faces', { count });
      if (this.onMultipleFaces) this.onMultipleFaces(count);
    } else if (detected && count === 1 && this.faceCount > 1) {
      this.faceCount = 1; // returned to normal
    }

    // Gaze tracking
    if (detected && lookingAway && !this.isLookingAway) {
      this.isLookingAway = true;
      this._logEvent('looking_away', { message: 'Candidate appears to be looking away from the screen' });
    } else if (detected && !lookingAway && this.isLookingAway) {
      this.isLookingAway = false;
      this._logEvent('gaze_returned', {});
    }
  }

  /**
   * Log event with cap to prevent memory leak.
   */
  _logEvent(type, data) {
    const event = { type, timestamp: Date.now(), ...data };

    // Cap events to prevent unbounded growth
    if (this.events.length >= this.maxEvents) {
      this.events.shift(); // Remove oldest
    }
    this.events.push(event);

    if (this.onMonitoringEvent) this.onMonitoringEvent(event);
  }
}

export default WebcamMonitor;
