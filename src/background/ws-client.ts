/**
 * WebSocket client for connecting to browser-mcp server.
 * Handles connection lifecycle, reconnection, and message routing.
 */

import { CONFIG } from '@/types/config';
import { log } from '@/utils/logger';
import { logConnection, logError } from './activity-log';
import type { IncomingMessage, OutgoingMessage } from '@/types/messages';

type MessageHandler = (message: IncomingMessage) => Promise<OutgoingMessage>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class WebSocketClient {
  private socket: WebSocket | null = null;
  private messageHandler: MessageHandler | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private isConnecting = false;
  private shouldReconnect = true;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private port: number = CONFIG.WS_PORT) {}

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
   */
  async connect(): Promise<void> {
    log.info(`[WS] connect() called, current state: ${this.socket?.readyState ?? 'no socket'}, attempts: ${this.reconnectAttempts}`);

    if (this.socket?.readyState === WebSocket.OPEN) {
      log.debug('[WS] Already connected');
      return;
    }

    if (this.isConnecting) {
      log.debug('[WS] Connection in progress');
      return;
    }

    this.isConnecting = true;
    this.shouldReconnect = true;

    return new Promise((resolve, reject) => {
      try {
        const protocol = CONFIG.WS_SECURE ? 'wss' : 'ws';
        const defaultPort = CONFIG.WS_SECURE ? 443 : 80;
        const portSuffix = this.port === defaultPort ? '' : `:${this.port}`;
        const path = CONFIG.WS_PATH ? `/${CONFIG.WS_PATH.replace(/^\/+/ , '')}` : '';
        const url = `${protocol}://${CONFIG.WS_HOST}${portSuffix}${path}`;
        log.info(`Connecting to ${url}`);

        this.socket = new WebSocket(url);

        this.socket.onopen = () => {
          log.info('WebSocket connected');
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          logConnection('ws_connect', `Connected to browser-mcp on port ${this.port}`, true, { port: this.port });
          this.startHeartbeat();
          resolve();
        };

        this.socket.onclose = (event) => {
          log.info(`WebSocket closed: ${event.code} ${event.reason}`);
          this.isConnecting = false;
          this.stopHeartbeat();
          this.socket = null;
          logConnection('ws_close', `WebSocket closed: ${event.code} ${event.reason || 'No reason'}`, true, { code: event.code, reason: event.reason });
          this.handleDisconnect();
        };

        this.socket.onerror = (error) => {
          log.error('WebSocket error:', error);
          this.isConnecting = false;
          logError('ws_error', 'WebSocket connection error', { error: String(error) });
          if (this.reconnectAttempts === 0) {
            reject(new Error('Failed to connect to browser-mcp'));
          }
        };

        this.socket.onmessage = (event) => {
          this.handleMessage(event.data);
        };
      } catch (error) {
        this.isConnecting = false;
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the server.
   */
  disconnect(): void {
    this.shouldReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopHeartbeat();

    if (this.socket) {
      this.socket.close(1000, 'Client disconnect');
      this.socket = null;
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
   * Check if connected.
   */
  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Check if a connection attempt or scheduled reconnect is already pending.
   */
  isReconnecting(): boolean {
    return this.isConnecting || this.reconnectTimer !== null;
  }

  /**
   * Send a response back to the server.
   */
  send(message: OutgoingMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      log.error('Cannot send: not connected');
      return;
    }

    const data = JSON.stringify(message);
    log.debug('Sending:', data);
    this.socket.send(data);
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
  private async handleMessage(data: string): Promise<void> {
    let messageId: string | undefined;

    try {
      const message = JSON.parse(data) as IncomingMessage;
      messageId = message.id;
      log.info('[WS] Received message:', message.type, message.id);

      if (!this.messageHandler) {
        log.error('No message handler set');
        this.send({
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
      this.send(response);
    } catch (error) {
      log.error('[WS] Failed to handle message:', error);
      // Send error response back to server so it doesn't timeout
      if (messageId) {
        this.send({
          id: messageId,
          success: false,
          error: {
            code: 'HANDLER_ERROR',
            message: error instanceof Error ? error.message : String(error),
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
