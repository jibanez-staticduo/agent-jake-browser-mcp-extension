/**
 * WebSocket client for connecting to browser-mcp server.
 * Handles connection lifecycle, reconnection, and message routing.
 */

import { CONFIG } from '@/types/config';
import { log } from '@/utils/logger';
import { buildDisplayUrl, buildWsUrl, getEffectiveConfig, serverRequiresToken } from '@/config/runtime';
import { logConnection, logError } from './activity-log';
import type { IncomingMessage, OutgoingMessage } from '@/types/messages';

type MessageHandler = (message: IncomingMessage) => Promise<OutgoingMessage>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ConnectionAttempt {
  resolve: (connected: boolean) => void;
  reject: (error: unknown) => void;
}

export class WebSocketClient {
  private socket: WebSocket | null = null;
  private messageHandler: MessageHandler | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private connectionAttempt: ConnectionAttempt | null = null;
  private shouldReconnect = true;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private effectiveUrl = '';
  private awaitingTokenUrl = '';

  isAwaitingToken(): boolean {
    return this.awaitingTokenUrl !== '';
  }

  /** Endpoint last attempted, without handshake credentials. */
  getEffectiveUrl(): string {
    return this.effectiveUrl;
  }

  /**
   * Set the handler for incoming tool requests.
   */
  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * Reset reconnect counter (call when user initiates new connection).
   */
  resetReconnectAttempts(): void {
    this.reconnectAttempts = 0;
    log.info('[WS] Reconnect attempts counter reset');
  }

  /**
   * Connect to the browser-mcp WebSocket server.
   *
   * The endpoint comes from the runtime config (chrome.storage overrides
   * win over build-time defaults) and the handshake query always carries
   * `connectionId`, plus `token` when one is available. Returns false while
   * waiting for credentials or another connection attempt and when disconnected
   * before the attempt completes.
   */
  async connect(): Promise<boolean> {
    log.info(`[WS] connect() called, current state: ${this.socket?.readyState ?? 'no socket'}, attempts: ${this.reconnectAttempts}`);

    if (this.socket?.readyState === WebSocket.OPEN) {
      log.debug('[WS] Already connected');
      return true;
    }

    if (this.connectionAttempt) {
      log.debug('[WS] Connection in progress');
      return false;
    }

    this.shouldReconnect = true;
    return new Promise<boolean>((resolve, reject) => {
      const attempt = { resolve, reject };
      this.connectionAttempt = attempt;
      this.openSocket(attempt).catch((error) => this.failConnection(attempt, error));
    });
  }

  private completeConnection(attempt: ConnectionAttempt, connected: boolean): void {
    if (this.connectionAttempt !== attempt) return;
    this.connectionAttempt = null;
    attempt.resolve(connected);
  }

  private failConnection(attempt: ConnectionAttempt, error: unknown): void {
    if (this.connectionAttempt !== attempt) return;
    this.connectionAttempt = null;
    attempt.reject(error);
  }

  /** Read runtime config and register handlers for the current attempt. */
  private async openSocket(attempt: ConnectionAttempt): Promise<void> {
    const cfg = await getEffectiveConfig();
    if (this.connectionAttempt !== attempt) return;

    const displayUrl = buildDisplayUrl(cfg);
    this.effectiveUrl = displayUrl;
    // The legacy loopback build default uses a dedicated WS port without HTTP.
    // Other destinations probe auth metadata, with WS-only 426 handled by runtime.
    const legacyLocalDefault = cfg.source === 'build' && !cfg.secure && cfg.scheme === 'ws'
      && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(cfg.hostname);
    const waitingForToken = !cfg.token && !legacyLocalDefault
      && (this.awaitingTokenUrl === displayUrl || await serverRequiresToken(cfg) === true);
    if (this.connectionAttempt !== attempt) return;

    if (waitingForToken) {
      this.awaitingTokenUrl = displayUrl;
      this.shouldReconnect = false;
      log.info('[WS] Server requires authentication; waiting for pairing or a configured token');
      this.completeConnection(attempt, false);
      return;
    }
    this.awaitingTokenUrl = '';

    log.info(`Connecting to ${displayUrl}`);
    const socket = new WebSocket(buildWsUrl(cfg));
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket || this.connectionAttempt !== attempt) return;
      log.info('WebSocket connected');
      this.reconnectAttempts = 0;
      logConnection('ws_connect', `Connected to browser-mcp at ${displayUrl}`, true, { url: displayUrl });
      this.startHeartbeat();
      this.completeConnection(attempt, true);
    };

    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      log.info(`WebSocket closed: ${event.code} ${event.reason}`);
      this.stopHeartbeat();
      this.socket = null;
      logConnection('ws_close', `WebSocket closed: ${event.code} ${event.reason || 'No reason'}`, true, { code: event.code, reason: event.reason });
      this.failConnection(attempt, new Error(`WebSocket closed before connecting (code ${event.code})`));
      this.handleDisconnect();
    };

    socket.onerror = () => {
      if (this.socket !== socket) return;
      const diagnostic = cfg.token
        ? 'WebSocket connection failed; check server availability and the configured token or pair again'
        : 'WebSocket connection failed; check server availability';
      log.error(diagnostic);
      logError('ws_error', diagnostic);
      this.failConnection(attempt, new Error(diagnostic));
    };

    socket.onmessage = (event) => {
      this.handleMessage(socket, event.data);
    };
  }

  /**
   * Disconnect from the server.
   */
  disconnect(): void {
    if (this.connectionAttempt) this.completeConnection(this.connectionAttempt, false);
    this.awaitingTokenUrl = '';
    this.shouldReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopHeartbeat();

    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.close(1000, 'Client disconnect');
    }

    // Reject all pending requests
    const pendingCount = this.pendingRequests.size;
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('WebSocket disconnected'));
    }
    this.pendingRequests.clear();

    log.info('Disconnected');
    logConnection('ws_disconnect', 'WebSocket disconnected by client', true, { pendingRequestsCancelled: pendingCount });
  }

  /**
   * Reconnect immediately with the current runtime config.
   * Call after ajb.serverUrl / ajb.token changed (popup save, pairing approved).
   */
  async reload(): Promise<void> {
    log.info('[WS] reload() - reconnecting with current runtime config');
    this.disconnect();
    this.reconnectAttempts = 0;
    await this.connect();
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Check if a connection attempt or scheduled reconnect is already pending.
   */
  isReconnecting(): boolean {
    return this.connectionAttempt !== null || this.reconnectTimer !== null;
  }

  /**
   * Send a response back to the server.
   */
  send(message: OutgoingMessage): void {
    this.sendOnSocket(this.socket, message);
  }

  /** Send only while the destination is still the active socket. */
  private sendOnSocket(socket: WebSocket | null, message: OutgoingMessage): void {
    if (socket !== this.socket) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      log.error('Cannot send: not connected');
      return;
    }

    const data = JSON.stringify(message);
    log.debug('[WS] Sending response');
    socket.send(data);
  }

  /**
   * Send lightweight traffic so proxies do not close the upgraded connection as idle.
   */
  sendHeartbeat(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), CONFIG.WS_HEARTBEAT_INTERVAL_MS);
    this.sendHeartbeat();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Handle incoming WebSocket message.
   */
  private async handleMessage(socket: WebSocket, data: string): Promise<void> {
    if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) return;

    let messageId: string | undefined;
    let secret = false;

    try {
      const message = JSON.parse(data) as IncomingMessage;
      messageId = message.id;
      secret = message.type === 'browser_read_secret' || (message.type === 'browser_type' && message.payload?.secret === true);
      log.info('[WS] Received message:', message.type, message.id);

      if (!this.messageHandler) {
        log.error('No message handler set');
        this.sendOnSocket(socket, {
          id: message.id,
          success: false,
          error: {
            code: 'NO_HANDLER',
            message: 'No message handler configured',
          },
        });
        return;
      }

      log.info('[WS] Calling message handler for:', message.type);
      const response = await this.messageHandler(message);
      log.info('[WS] Message handler returned, sending response');
      this.sendOnSocket(socket, response);
    } catch (error) {
      log.error('[WS] Failed to handle message:', secret ? 'Secret typing failed' : error);
      // Send error response back to server so it doesn't timeout
      if (messageId) {
        this.sendOnSocket(socket, {
          id: messageId,
          success: false,
          error: {
            code: 'HANDLER_ERROR',
            message: secret ? 'Secret typing failed' : error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }

  /**
   * Handle disconnection with auto-reconnect.
   * Uses fixed 5-second interval, no exponential backoff.
   * Retries indefinitely when MAX_RECONNECT_ATTEMPTS is 0.
   */
  private handleDisconnect(): void {
    log.info(`[WS] handleDisconnect() - shouldReconnect: ${this.shouldReconnect}, attempts: ${this.reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS || 'unlimited'}`);

    if (!this.shouldReconnect) {
      return;
    }

    // Skip max attempts check if unlimited (0)
    if (CONFIG.MAX_RECONNECT_ATTEMPTS > 0 && this.reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
      log.error('[WS] Max reconnect attempts reached');
      logError('ws_reconnect_failed', `Max reconnect attempts reached (${CONFIG.MAX_RECONNECT_ATTEMPTS})`, { attempts: this.reconnectAttempts, maxAttempts: CONFIG.MAX_RECONNECT_ATTEMPTS });
      return;
    }

    this.reconnectAttempts++;
    // Fixed interval, no exponential backoff
    const delay = CONFIG.RECONNECT_INTERVAL_MS;

    log.info(`[WS] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);
    logConnection('ws_reconnecting', `Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`, true, { attempt: this.reconnectAttempts, delayMs: delay });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(error => {
        log.error('[WS] Reconnect failed:', error);
      });
    }, delay);
  }
}
