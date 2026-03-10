/**
 * SocketService
 * 
 * Handles real-time communication between the client and server
 * using WebSocket (native). For production, this can be upgraded
 * to Socket.IO for automatic reconnection and room support.
 * 
 * Responsibilities:
 *   - Send speech transcripts to server
 *   - Send monitoring events to server
 *   - Receive AI questions/responses from server
 *   - Handle connection lifecycle
 */

class SocketService {
  constructor(serverUrl) {
    this.serverUrl = serverUrl || 'ws://localhost:3001';
    this.socket = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 2000; // ms

    // Message handlers
    this._handlers = {};

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
        console.log('[SocketService] Connected to', this.serverUrl);
        if (this.onConnect) this.onConnect();
      };

      this.socket.onclose = (event) => {
        this.isConnected = false;
        console.log('[SocketService] Disconnected:', event.code);
        if (this.onDisconnect) this.onDisconnect(event);
        this._attemptReconnect();
      };

      this.socket.onerror = (error) => {
        console.error('[SocketService] Error:', error);
        if (this.onError) this.onError(error);
      };

      this.socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this._dispatch(message.type, message.payload);
        } catch (err) {
          console.warn('[SocketService] Failed to parse message:', event.data);
        }
      };
    } catch (err) {
      console.error('[SocketService] Connection failed:', err);
    }
  }

  /**
   * Disconnect from the server.
   */
  disconnect() {
    this.maxReconnectAttempts = 0; // Prevent auto-reconnect
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.isConnected = false;
  }

  /**
   * Send a message to the server.
   * @param {string} type - Message type
   * @param {object} payload - Message data
   */
  send(type, payload = {}) {
    if (!this.isConnected || !this.socket) {
      console.warn('[SocketService] Not connected. Message queued:', type);
      return false;
    }

    const message = JSON.stringify({ type, payload, timestamp: Date.now() });
    this.socket.send(message);
    return true;
  }

  /**
   * Send a transcript segment to the server.
   */
  sendTranscript(text, isFinal = false) {
    return this.send('transcript', { text, isFinal });
  }

  /**
   * Send a monitoring event to the server.
   */
  sendMonitoringEvent(event) {
    return this.send('monitoring_event', event);
  }

  /**
   * Register a handler for a message type.
   * @param {string} type - Message type to listen for
   * @param {function} handler - Handler function
   */
  on(type, handler) {
    if (!this._handlers[type]) {
      this._handlers[type] = [];
    }
    this._handlers[type].push(handler);
  }

  /**
   * Remove a handler for a message type.
   */
  off(type, handler) {
    if (this._handlers[type]) {
      this._handlers[type] = this._handlers[type].filter((h) => h !== handler);
    }
  }

  // --- Internal ---

  _dispatch(type, payload) {
    const handlers = this._handlers[type];
    if (handlers) {
      handlers.forEach((handler) => handler(payload));
    }
  }

  _attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn('[SocketService] Max reconnect attempts reached.');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * this.reconnectAttempts;
    console.log(`[SocketService] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
    
    setTimeout(() => {
      if (!this.isConnected) {
        this.connect();
      }
    }, delay);
  }
}

export default SocketService;
