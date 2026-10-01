/**
 * Connection state management for graceful offline handling.
 * Provides detailed connection states, exponential backoff, and error tracking.
 */

export enum ConnectionState {
  /** Initial state - not yet connected */
  DISCONNECTED = 'disconnected',
  /** Actively trying to connect */
  CONNECTING = 'connecting',
  /** Successfully connected */
  CONNECTED = 'connected',
  /** Connection lost, waiting to retry */
  RECONNECTING = 'reconnecting',
  /** Too many failures, stopped retrying */
  FAILED = 'failed',
  /** Network appears to be offline */
  OFFLINE = 'offline',
}

export interface ConnectionError {
  code: string;
  message: string;
  timestamp: number;
  isRecoverable: boolean;
}

export interface ConnectionInfo {
  state: ConnectionState;
  lastError: ConnectionError | null;
  reconnectAttempt: number;
  nextReconnectAt: number | null;
  connectedSince: number | null;
}

export interface BackoffConfig {
  /** Initial delay in ms */
  initialDelay: number;
  /** Maximum delay in ms */
  maxDelay: number;
  /** Multiplier for each attempt */
  multiplier: number;
  /** Max attempts before giving up (0 = unlimited) */
  maxAttempts: number;
  /** Add random jitter to delay */
  jitter: boolean;
}

const DEFAULT_BACKOFF: BackoffConfig = {
  initialDelay: 1000,    // 1 second
  maxDelay: 60000,       // 1 minute max
  multiplier: 2,
  maxAttempts: 0,        // Unlimited
  jitter: true,
};

/**
 * Error codes for categorizing connection failures.
 */
export const ErrorCodes = {
  NETWORK_ERROR: 'NETWORK_ERROR',
  SERVER_ERROR: 'SERVER_ERROR',
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  WEBSOCKET_ERROR: 'WEBSOCKET_ERROR',
  TIMEOUT: 'TIMEOUT',
  UNKNOWN: 'UNKNOWN',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

/**
 * Connection state manager with exponential backoff.
 */
export class ConnectionStateManager {
  private state: ConnectionState = ConnectionState.DISCONNECTED;
  private lastError: ConnectionError | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectedSince: number | null = null;
  private backoffConfig: BackoffConfig;
  private listeners: Set<(info: ConnectionInfo) => void> = new Set();
  private networkListener: (() => void) | null = null;

  constructor(config: Partial<BackoffConfig> = {}) {
    this.backoffConfig = { ...DEFAULT_BACKOFF, ...config };
    this.setupNetworkListener();
  }

  /**
   * Set up network online/offline listener.
   */
  private setupNetworkListener(): void {
    // In Chrome extension service worker, navigator.onLine and online/offline events work
    if (typeof navigator !== 'undefined') {
      this.networkListener = () => {
        if (navigator.onLine && this.state === ConnectionState.OFFLINE) {
          // Network came back online, attempt reconnect
          this.setState(ConnectionState.RECONNECTING);
          this.notifyListeners();
        } else if (!navigator.onLine) {
          this.setState(ConnectionState.OFFLINE);
          this.clearReconnectTimer();
          this.notifyListeners();
        }
      };

      // Check if addEventListener is available (it is in service workers)
      if (typeof globalThis.addEventListener === 'function') {
        globalThis.addEventListener('online', this.networkListener);
        globalThis.addEventListener('offline', this.networkListener);
      }
    }
  }

  /**
   * Clean up listeners.
   */
  destroy(): void {
    this.clearReconnectTimer();
    if (this.networkListener && typeof globalThis.removeEventListener === 'function') {
      globalThis.removeEventListener('online', this.networkListener);
      globalThis.removeEventListener('offline', this.networkListener);
    }
  }

  /**
   * Mark connection as attempting to connect.
   */
  setConnecting(): void {
    this.setState(ConnectionState.CONNECTING);
    this.notifyListeners();
  }

  /**
   * Mark connection as established.
   */
  setConnected(): void {
    this.setState(ConnectionState.CONNECTED);
    this.reconnectAttempt = 0;
    this.lastError = null;
    this.connectedSince = Date.now();
    this.clearReconnectTimer();
    this.notifyListeners();
  }

  /**
   * Mark connection as disconnected (intentional).
   */
  setDisconnected(): void {
    this.setState(ConnectionState.DISCONNECTED);
    this.reconnectAttempt = 0;
    this.lastError = null;
    this.connectedSince = null;
    this.clearReconnectTimer();
    this.notifyListeners();
  }

  /**
   * Handle a connection error and optionally schedule reconnect.
   */
  handleError(
    code: ErrorCode,
    message: string,
    scheduleReconnect = true
  ): { shouldRetry: boolean; delay: number | null } {
    const isRecoverable = this.isRecoverableError(code);

    this.lastError = {
      code,
      message,
      timestamp: Date.now(),
      isRecoverable,
    };

    // Check if network is offline
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.setState(ConnectionState.OFFLINE);
      this.notifyListeners();
      return { shouldRetry: false, delay: null };
    }

    // Non-recoverable errors (like auth expired) - don't retry
    if (!isRecoverable) {
      this.setState(ConnectionState.FAILED);
      this.clearReconnectTimer();
      this.notifyListeners();
      return { shouldRetry: false, delay: null };
    }

    this.reconnectAttempt++;

    // Check max attempts
    if (this.backoffConfig.maxAttempts > 0 &&
        this.reconnectAttempt >= this.backoffConfig.maxAttempts) {
      this.setState(ConnectionState.FAILED);
      this.notifyListeners();
      return { shouldRetry: false, delay: null };
    }

    // Calculate backoff delay
    const delay = this.calculateBackoff();

    this.setState(ConnectionState.RECONNECTING);

    if (scheduleReconnect) {
      // Return delay but don't schedule here - let caller handle it
    }

    this.notifyListeners();
    return { shouldRetry: true, delay };
  }

  /**
   * Schedule a reconnection attempt.
   */
  scheduleReconnect(callback: () => Promise<void>, delay: number): void {
    this.clearReconnectTimer();

    console.log(`[ConnectionState] Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempt})`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await callback();
      } catch (error) {
        // Error will be handled by the callback
        console.error('[ConnectionState] Reconnect callback error:', error);
      }
    }, delay);

    this.notifyListeners();
  }

  /**
   * Get the time until next reconnect attempt.
   */
  getNextReconnectAt(): number | null {
    if (this.reconnectTimer && this.state === ConnectionState.RECONNECTING) {
      const delay = this.calculateBackoff();
      // This is approximate since we don't track the exact scheduled time
      return Date.now() + delay;
    }
    return null;
  }

  /**
   * Calculate exponential backoff delay.
   */
  private calculateBackoff(): number {
    const { initialDelay, maxDelay, multiplier, jitter } = this.backoffConfig;

    // Exponential backoff: delay = initialDelay * multiplier^(attempt-1)
    let delay = initialDelay * Math.pow(multiplier, this.reconnectAttempt - 1);

    // Cap at max delay
    delay = Math.min(delay, maxDelay);

    // Add jitter (±25%)
    if (jitter) {
      const jitterRange = delay * 0.25;
      delay += (Math.random() * jitterRange * 2) - jitterRange;
    }

    return Math.round(delay);
  }

  /**
   * Check if an error is recoverable.
   */
  private isRecoverableError(code: ErrorCode): boolean {
    switch (code) {
      case ErrorCodes.AUTH_EXPIRED:
        // Auth issues require user action
        return false;
      case ErrorCodes.NETWORK_ERROR:
      case ErrorCodes.SERVER_ERROR:
      case ErrorCodes.WEBSOCKET_ERROR:
      case ErrorCodes.TIMEOUT:
      case ErrorCodes.RATE_LIMITED:
        // These can potentially recover
        return true;
      default:
        return true;
    }
  }

  /**
   * Clear reconnect timer.
   */
  clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Reset for a new connection attempt.
   */
  reset(): void {
    this.reconnectAttempt = 0;
    this.lastError = null;
    this.clearReconnectTimer();
    this.setState(ConnectionState.DISCONNECTED);
    this.notifyListeners();
  }

  /**
   * Get current connection info.
   */
  getInfo(): ConnectionInfo {
    return {
      state: this.state,
      lastError: this.lastError,
      reconnectAttempt: this.reconnectAttempt,
      nextReconnectAt: this.state === ConnectionState.RECONNECTING ? this.getNextReconnectAt() : null,
      connectedSince: this.connectedSince,
    };
  }

  /**
   * Get current state.
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Check if currently connected.
   */
  isConnected(): boolean {
    return this.state === ConnectionState.CONNECTED;
  }

  /**
   * Check if connection is being attempted.
   */
  isConnecting(): boolean {
    return this.state === ConnectionState.CONNECTING ||
           this.state === ConnectionState.RECONNECTING;
  }

  /**
   * Set state.
   */
  private setState(state: ConnectionState): void {
    if (this.state !== state) {
      console.log(`[ConnectionState] ${this.state} -> ${state}`);
      this.state = state;
    }
  }

  /**
   * Subscribe to connection info changes.
   */
  subscribe(listener: (info: ConnectionInfo) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Notify all listeners.
   */
  private notifyListeners(): void {
    const info = this.getInfo();
    this.listeners.forEach(listener => listener(info));
  }
}

/**
 * Parse HTTP response into connection error.
 */
export function parseHttpError(status: number, message: string): { code: ErrorCode; message: string } {
  if (status === 401 || status === 403) {
    return { code: ErrorCodes.AUTH_EXPIRED, message: 'Authentication expired. Please sign in again.' };
  }
  if (status === 429) {
    return { code: ErrorCodes.RATE_LIMITED, message: 'Too many requests. Please wait a moment.' };
  }
  if (status >= 500) {
    return { code: ErrorCodes.SERVER_ERROR, message: message || 'Server error. Retrying...' };
  }
  if (status === 0 || !status) {
    return { code: ErrorCodes.NETWORK_ERROR, message: 'Network error. Check your connection.' };
  }
  return { code: ErrorCodes.UNKNOWN, message: message || 'Unknown error' };
}

/**
 * Get user-friendly message for connection state.
 */
export function getStateMessage(info: ConnectionInfo): string {
  switch (info.state) {
    case ConnectionState.CONNECTED:
      return 'Connected to server';
    case ConnectionState.CONNECTING:
      return 'Connecting...';
    case ConnectionState.RECONNECTING:
      return info.reconnectAttempt > 1
        ? `Reconnecting (attempt ${info.reconnectAttempt})...`
        : 'Reconnecting...';
    case ConnectionState.OFFLINE:
      return 'Network offline';
    case ConnectionState.FAILED:
      if (info.lastError?.code === ErrorCodes.AUTH_EXPIRED) {
        return 'Session expired';
      }
      return 'Connection failed';
    case ConnectionState.DISCONNECTED:
    default:
      return 'Disconnected';
  }
}
