/**
 * SocketService — v2 (Production-Grade)
 * 
 * v2 Upgrades (from Use-Case Strategy Matrix):
 *   ✅ Message batching — buffers monitoring events, flushes every 3s
 *   ✅ Offline queue — stores unsent messages during disconnection
 *   ✅ Heartbeat ping — detects silent disconnections (15s interval)
 *   ✅ Exponential backoff — proper reconnection with jitter
 *   ✅ Metrics — tracks messages sent, bytes transferred
 * 
 * Bandwidth SLO: < 1.5 Mbps (we send ~2KB/min text, ~100B/event)
 */

class SocketService {
  constructor(serverUrl) {
    this.serverUrl = serverUrl || 'ws://localhost:3001';
    this.socket = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 2000;

    // Message batching (ref: Strategy Matrix §5)
    this._eventBuffer = [];
    this._batchInterval = 3000; // flush every 3s
    this._batchTimerId = null;

    // Offline queue — messages buffered while disconnected
    this._offlineQueue = [];
    this._maxQueueSize = 100;

    // Heartbeat — detect silent disconnections
    this._heartbeatInterval = 15000;
    this._heartbeatId = null;
    this._lastPong = 0;

    // Message handlers
    this._handlers = {};

    // Metrics
    this.metrics = {
      messagesSent: 0,
      bytesSent: 0,
      messagesReceived: 0,
      batchesFlushed: 0,
      reconnections: 0,
    };

    // Callbacks
    this.onConnect = null;
    this.onDisconnect = null;
    this.onError = null;
  }

  /**
   * Connect to the WebSocket server.
   */
  connect() {
    try {
      this.socket = new WebSocket(this.serverUrl);

      this.socket.onopen = () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this._lastPong = Date.now();
        console.log('[SocketService] Connected to', this.serverUrl);

        // Flush offline queue
        this._flushOfflineQueue();

        // Start heartbeat
        this._startHeartbeat();

        // Start event batching
        this._startBatching();

        if (this.onConnect) this.onConnect();
      };

      this.socket.onclose = (event) => {
        this.isConnected = false;
        this._stopHeartbeat();
        this._stopBatching();
        console.log('[SocketService] Disconnected:', event.code);
        if (this.onDisconnect) this.onDisconnect(event);
        this._attemptReconnect();
      };

      this.socket.onerror = (error) => {
        console.error('[SocketService] Error:', error);
        if (this.onError) this.onError(error);
      };

      this.socket.onmessage = (event) => {
        this.metrics.messagesReceived++;
        try {
          const message = JSON.parse(event.data);
          // Handle heartbeat pong
          if (message.type === 'pong') {
            this._lastPong = Date.now();
            return;
          }
          this._dispatch(message.type, message.payload);
        } catch (err) {
          console.warn('[SocketService] Failed to parse message:', event.data);
        }
      };
    } catch (err) {
      console.error('[SocketService] Connection failed:', err);
    }
  }

  disconnect() {
    this.maxReconnectAttempts = 0;
    this._stopHeartbeat();
    this._stopBatching();
    // Flush remaining buffered events
    this._flushEventBuffer();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.isConnected = false;
  }

  /**
   * Send a message directly (not batched).
   */
  send(type, payload = {}) {
    const message = JSON.stringify({ type, payload, timestamp: Date.now() });

    if (!this.isConnected || !this.socket) {
      this._queueOffline(message);
      return false;
    }

    this.socket.send(message);
    this.metrics.messagesSent++;
    this.metrics.bytesSent += message.length;
    return true;
  }

  /**
   * Send transcript — sent immediately (latency-sensitive).
   */
  sendTranscript(text, isFinal = false) {
    return this.send('transcript', { text, isFinal });
  }

  /**
   * Queue a monitoring event for batched sending.
   * Events are flushed every 3 seconds to reduce WebSocket chatter.
   */
  sendMonitoringEvent(event) {
    this._eventBuffer.push(event);
  }

  /**
   * Register handler.
   */
  on(type, handler) {
    if (!this._handlers[type]) this._handlers[type] = [];
    this._handlers[type].push(handler);
  }

  off(type, handler) {
    if (this._handlers[type]) {
      this._handlers[type] = this._handlers[type].filter((h) => h !== handler);
    }
  }

  getMetrics() {
    return { ...this.metrics };
  }

  // --- Batching ---

  _startBatching() {
    this._batchTimerId = setInterval(() => this._flushEventBuffer(), this._batchInterval);
  }

  _stopBatching() {
    if (this._batchTimerId) {
      clearInterval(this._batchTimerId);
      this._batchTimerId = null;
    }
  }

  _flushEventBuffer() {
    if (this._eventBuffer.length === 0) return;

    const batch = this._eventBuffer.splice(0); // Take all and clear
    this.send('monitoring_batch', { events: batch, count: batch.length });
    this.metrics.batchesFlushed++;
  }

  // --- Offline Queue ---

  _queueOffline(message) {
    if (this._offlineQueue.length >= this._maxQueueSize) {
      this._offlineQueue.shift(); // Drop oldest if full
    }
    this._offlineQueue.push(message);
  }

  _flushOfflineQueue() {
    if (this._offlineQueue.length === 0) return;
    console.log(`[SocketService] Flushing ${this._offlineQueue.length} queued messages`);
    const queue = this._offlineQueue.splice(0);
    queue.forEach((msg) => {
      if (this.socket && this.isConnected) {
        this.socket.send(msg);
        this.metrics.messagesSent++;
        this.metrics.bytesSent += msg.length;
      }
    });
  }

  // --- Heartbeat ---

  _startHeartbeat() {
    this._heartbeatId = setInterval(() => {
      if (!this.isConnected) return;

      // Check if server responded to last ping
      const elapsed = Date.now() - this._lastPong;
      if (elapsed > this._heartbeatInterval * 2) {
        console.warn('[SocketService] Heartbeat timeout — closing connection');
        this.socket.close();
        return;
      }

      this.send('ping', {});
    }, this._heartbeatInterval);
  }

  _stopHeartbeat() {
    if (this._heartbeatId) {
      clearInterval(this._heartbeatId);
      this._heartbeatId = null;
    }
  }

  // --- Internal ---

  _dispatch(type, payload) {
    const handlers = this._handlers[type];
    if (handlers) handlers.forEach((h) => h(payload));
  }

  _attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn('[SocketService] Max reconnect attempts reached.');
      return;
    }

    this.reconnectAttempts++;
    this.metrics.reconnections++;
    // Exponential backoff with jitter
    const jitter = Math.random() * 500;
    const delay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1) + jitter;
    console.log(`[SocketService] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      if (!this.isConnected) this.connect();
    }, delay);
  }
}

export default SocketService;
