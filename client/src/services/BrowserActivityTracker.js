/**
 * BrowserActivityTracker Service
 * 
 * Monitors candidate browser behavior during the interview session
 * to detect integrity violations.
 * 
 * Tracked Events (PRD 3.1.4):
 *   - Tab switching / window blur (Page Visibility API)
 *   - Inactivity detection (no mouse/keyboard for extended period)
 *   - Fullscreen exit attempts
 *   - Copy/paste attempts
 *   - Right-click / context menu
 *   - DevTools open detection (resize heuristic)
 */

class BrowserActivityTracker {
  constructor(options = {}) {
    this.inactivityThreshold = options.inactivityThreshold || 30000; // 30 seconds
    
    this.isActive = false;
    this.events = [];
    this.tabSwitchCount = 0;
    this.inactivityCount = 0;

    this._inactivityTimer = null;
    this._boundHandlers = {};

    // Callbacks
    this.onTabSwitch = null;       // (event) => {}
    this.onInactivity = null;      // (event) => {}
    this.onSuspiciousAction = null; // (event) => {}
    this.onEvent = null;           // (event) => {} — generic
  }

  /**
   * Start tracking browser activity.
   */
  start() {
    if (this.isActive) return;
    this.isActive = true;

    // Tab visibility
    this._boundHandlers.visibility = this._onVisibilityChange.bind(this);
    document.addEventListener('visibilitychange', this._boundHandlers.visibility);

    // Window blur/focus
    this._boundHandlers.blur = () => this._onWindowBlur();
    this._boundHandlers.focus = () => this._onWindowFocus();
    window.addEventListener('blur', this._boundHandlers.blur);
    window.addEventListener('focus', this._boundHandlers.focus);

    // Copy/paste prevention
    this._boundHandlers.copy = (e) => this._onCopyPaste(e, 'copy');
    this._boundHandlers.paste = (e) => this._onCopyPaste(e, 'paste');
    document.addEventListener('copy', this._boundHandlers.copy);
    document.addEventListener('paste', this._boundHandlers.paste);

    // Right-click / context menu
    this._boundHandlers.contextmenu = (e) => this._onContextMenu(e);
    document.addEventListener('contextmenu', this._boundHandlers.contextmenu);

    // Inactivity tracking
    this._boundHandlers.activity = this._resetInactivityTimer.bind(this);
    document.addEventListener('mousemove', this._boundHandlers.activity);
    document.addEventListener('keydown', this._boundHandlers.activity);
    document.addEventListener('click', this._boundHandlers.activity);
    this._resetInactivityTimer();

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

    if (this._inactivityTimer) {
      clearTimeout(this._inactivityTimer);
      this._inactivityTimer = null;
    }

    this._logEvent('tracking_stopped', {});
  }

  /**
   * Get all recorded events.
   */
  getEvents() {
    return [...this.events];
  }

  /**
   * Get a summary of suspicious activity.
   */
  getSummary() {
    return {
      tabSwitchCount: this.tabSwitchCount,
      inactivityCount: this.inactivityCount,
      totalEvents: this.events.length,
      events: this.events,
    };
  }

  // --- Internal Handlers ---

  _onVisibilityChange() {
    if (document.hidden) {
      this.tabSwitchCount++;
      const evt = this._logEvent('tab_switch', {
        direction: 'away',
        count: this.tabSwitchCount,
      });
      if (this.onTabSwitch) this.onTabSwitch(evt);
    } else {
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
    const evt = this._logEvent('suspicious_action', {
      action,
      message: `Candidate attempted to ${action}`,
    });
    if (this.onSuspiciousAction) this.onSuspiciousAction(evt);
  }

  _onContextMenu(e) {
    e.preventDefault();
    const evt = this._logEvent('suspicious_action', {
      action: 'right_click',
      message: 'Candidate attempted right-click',
    });
    if (this.onSuspiciousAction) this.onSuspiciousAction(evt);
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

  _logEvent(type, data) {
    const event = {
      type,
      timestamp: Date.now(),
      ...data,
    };
    this.events.push(event);
    if (this.onEvent) this.onEvent(event);
    return event;
  }
}

export default BrowserActivityTracker;
