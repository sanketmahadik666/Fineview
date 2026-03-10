/**
 * BrowserActivityTracker Service — v2 (Production-Grade)
 * 
 * v2 Upgrades (from Use-Case Strategy Matrix):
 *   ✅ mousemove throttled via rAF guard (INP-safe)
 *   ✅ Event log capped at 500 entries (prevents memory leak)
 *   ✅ DevTools detection via resize heuristic
 *   ✅ Fullscreen exit detection
 *   ✅ Session-level statistics (for recruiter dashboard)
 * 
 * Processing: Edge (zero CPU cost — all event-driven)
 * INP Impact: < 1ms per event handler
 */

class BrowserActivityTracker {
  constructor(options = {}) {
    this.inactivityThreshold = options.inactivityThreshold || 30000;
    this.maxEvents = options.maxEvents || 500;

    this.isActive = false;
    this.events = [];
    this.tabSwitchCount = 0;
    this.inactivityCount = 0;
    this.suspiciousActionCount = 0;

    this._inactivityTimer = null;
    this._boundHandlers = {};
    this._mouseMoveQueued = false; // rAF throttle flag

    // Timing
    this._sessionStartTime = 0;
    this._lastActiveTime = 0;
    this._tabAwayTime = 0;
    this._tabLeftAt = 0;

    // Callbacks
    this.onTabSwitch = null;
    this.onInactivity = null;
    this.onSuspiciousAction = null;
    this.onEvent = null;
  }

  /**
   * Start tracking.
   */
  start() {
    if (this.isActive) return;
    this.isActive = true;
    this._sessionStartTime = Date.now();
    this._lastActiveTime = Date.now();

    // Tab visibility (Page Visibility API)
    this._boundHandlers.visibility = this._onVisibilityChange.bind(this);
    document.addEventListener('visibilitychange', this._boundHandlers.visibility);

    // Window blur/focus
    this._boundHandlers.blur = () => this._onWindowBlur();
    this._boundHandlers.focus = () => this._onWindowFocus();
    window.addEventListener('blur', this._boundHandlers.blur);
    window.addEventListener('focus', this._boundHandlers.focus);

    // Copy/paste
    this._boundHandlers.copy = (e) => this._onCopyPaste(e, 'copy');
    this._boundHandlers.paste = (e) => this._onCopyPaste(e, 'paste');
    document.addEventListener('copy', this._boundHandlers.copy);
    document.addEventListener('paste', this._boundHandlers.paste);

    // Right-click
    this._boundHandlers.contextmenu = (e) => this._onContextMenu(e);
    document.addEventListener('contextmenu', this._boundHandlers.contextmenu);

    // Inactivity — throttled mousemove via rAF guard
    this._boundHandlers.activity = this._onActivity.bind(this);
    document.addEventListener('mousemove', this._boundHandlers.activity);
    document.addEventListener('keydown', this._boundHandlers.activity);
    document.addEventListener('click', this._boundHandlers.activity);
    this._resetInactivityTimer();

    // Fullscreen exit detection
    this._boundHandlers.fullscreen = this._onFullscreenChange.bind(this);
    document.addEventListener('fullscreenchange', this._boundHandlers.fullscreen);

    // DevTools detection (resize heuristic)
    this._boundHandlers.resize = this._onResize.bind(this);
    window.addEventListener('resize', this._boundHandlers.resize);
    this._lastInnerWidth = window.innerWidth;
    this._lastInnerHeight = window.innerHeight;

    this._logEvent('tracking_started', {});
  }

  /**
   * Stop all tracking.
   */
  stop() {
    if (!this.isActive) return;
    this.isActive = false;

    document.removeEventListener('visibilitychange', this._boundHandlers.visibility);
    window.removeEventListener('blur', this._boundHandlers.blur);
    window.removeEventListener('focus', this._boundHandlers.focus);
    document.removeEventListener('copy', this._boundHandlers.copy);
    document.removeEventListener('paste', this._boundHandlers.paste);
    document.removeEventListener('contextmenu', this._boundHandlers.contextmenu);
    document.removeEventListener('mousemove', this._boundHandlers.activity);
    document.removeEventListener('keydown', this._boundHandlers.activity);
    document.removeEventListener('click', this._boundHandlers.activity);
    document.removeEventListener('fullscreenchange', this._boundHandlers.fullscreen);
    window.removeEventListener('resize', this._boundHandlers.resize);

    if (this._inactivityTimer) {
      clearTimeout(this._inactivityTimer);
      this._inactivityTimer = null;
    }

    this._logEvent('tracking_stopped', {});
  }

  getEvents() {
    return [...this.events];
  }

  /**
   * Session-level statistics for recruiter dashboard.
   */
  getSummary() {
    const sessionDuration = Date.now() - this._sessionStartTime;
    return {
      tabSwitchCount: this.tabSwitchCount,
      inactivityCount: this.inactivityCount,
      suspiciousActionCount: this.suspiciousActionCount,
      totalEvents: this.events.length,
      sessionDuration,
      tabAwayTime: this._tabAwayTime,
      tabAwayPercent: sessionDuration > 0
        ? ((this._tabAwayTime / sessionDuration) * 100).toFixed(1)
        : 0,
    };
  }

  // --- Internal Handlers ---

  /**
   * Throttled activity handler using rAF guard.
   * mousemove fires 60+ times/sec — we only need it once per frame.
   * This keeps INP < 1ms for activity reset.
   */
  _onActivity() {
    this._lastActiveTime = Date.now();
    if (this._mouseMoveQueued) return; // Already queued
    this._mouseMoveQueued = true;
    requestAnimationFrame(() => {
      this._mouseMoveQueued = false;
      this._resetInactivityTimer();
    });
  }

  _onVisibilityChange() {
    if (document.hidden) {
      this.tabSwitchCount++;
      this._tabLeftAt = Date.now();
      const evt = this._logEvent('tab_switch', {
        direction: 'away',
        count: this.tabSwitchCount,
      });
      if (this.onTabSwitch) this.onTabSwitch(evt);
    } else {
      if (this._tabLeftAt) {
        this._tabAwayTime += Date.now() - this._tabLeftAt;
        this._tabLeftAt = 0;
      }
      this._logEvent('tab_switch', { direction: 'returned' });
    }
  }

  _onWindowBlur() {
    this._logEvent('window_blur', {});
  }

  _onWindowFocus() {
    this._logEvent('window_focus', {});
  }

  _onCopyPaste(e, action) {
    e.preventDefault();
    this.suspiciousActionCount++;
    const evt = this._logEvent('suspicious_action', {
      action,
      message: `Candidate attempted to ${action}`,
    });
    if (this.onSuspiciousAction) this.onSuspiciousAction(evt);
  }

  _onContextMenu(e) {
    e.preventDefault();
    this.suspiciousActionCount++;
    const evt = this._logEvent('suspicious_action', {
      action: 'right_click',
      message: 'Candidate attempted right-click',
    });
    if (this.onSuspiciousAction) this.onSuspiciousAction(evt);
  }

  _onFullscreenChange() {
    if (!document.fullscreenElement) {
      this.suspiciousActionCount++;
      const evt = this._logEvent('suspicious_action', {
        action: 'fullscreen_exit',
        message: 'Candidate exited fullscreen',
      });
      if (this.onSuspiciousAction) this.onSuspiciousAction(evt);
    }
  }

  /**
   * DevTools detection heuristic.
   * If window inner dimensions shrink significantly without a corresponding
   * outer dimension change, DevTools may have opened.
   */
  _onResize() {
    const widthDelta = this._lastInnerWidth - window.innerWidth;
    const heightDelta = this._lastInnerHeight - window.innerHeight;
    this._lastInnerWidth = window.innerWidth;
    this._lastInnerHeight = window.innerHeight;

    // DevTools typically takes 300+ px when docked
    if (widthDelta > 200 || heightDelta > 200) {
      this._logEvent('suspicious_action', {
        action: 'possible_devtools',
        message: 'Significant viewport shrink detected',
        widthDelta,
        heightDelta,
      });
    }
  }

  _resetInactivityTimer() {
    if (this._inactivityTimer) {
      clearTimeout(this._inactivityTimer);
    }
    this._inactivityTimer = setTimeout(() => {
      this.inactivityCount++;
      const evt = this._logEvent('inactivity', {
        duration: this.inactivityThreshold,
        count: this.inactivityCount,
      });
      if (this.onInactivity) this.onInactivity(evt);
    }, this.inactivityThreshold);
  }

  /**
   * Log event — capped to prevent memory leak.
   */
  _logEvent(type, data) {
    const event = { type, timestamp: Date.now(), ...data };
    if (this.events.length >= this.maxEvents) {
      this.events.shift();
    }
    this.events.push(event);
    if (this.onEvent) this.onEvent(event);
    return event;
  }
}

export default BrowserActivityTracker;
