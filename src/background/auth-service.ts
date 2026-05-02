/**
 * Authentication service for managing user session.
 * Handles login/logout, token persistence, and session management.
 * Implements graceful offline handling with exponential backoff.
 */

import { apiClient, AuthUser, LoginResponse } from './api-client';
import { logActivity } from './activity-log';
import { reverbClient } from './reverb-client';
import {
  ConnectionStateManager,
  ConnectionState,
  ConnectionInfo,
  ErrorCodes,
  parseHttpError,
  getStateMessage,
} from './connection-state';

const STORAGE_KEYS = {
  TOKEN: 'auth_token',
  USER: 'auth_user',
  SESSION_ID: 'session_id',
} as const;

const HEARTBEAT_INTERVAL_MS = 25000; // 25 seconds (server expects 30s)
const HEARTBEAT_FAILURE_THRESHOLD = 2; // Mark offline after 2 consecutive failures

export interface AuthState {
  isAuthenticated: boolean;
  user: AuthUser | null;
  /** Combined connection state (true only if both HTTP and Reverb connected) */
  isConnected: boolean;
  /** Reverb WebSocket connection state for SERVER indicator */
  connectionState: ConnectionState;
  /** User-friendly status message */
  statusMessage: string;
  /** Number of reconnect attempts */
  reconnectAttempt: number;
  /** Last error if any */
  lastError: string | null;
}

/**
 * Authentication service class.
 * Implements graceful offline handling with automatic reconnection.
 */
class AuthService {
  private user: AuthUser | null = null;
  private sessionId: string | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatFailures = 0;
  private connectionState: ConnectionStateManager;
  private listeners: Set<(state: AuthState) => void> = new Set();

  constructor() {
    // Initialize connection state manager with backoff config
    this.connectionState = new ConnectionStateManager({
      initialDelay: 2000,    // Start with 2 seconds
      maxDelay: 60000,       // Max 1 minute
      multiplier: 1.5,       // Gentler exponential growth
      maxAttempts: 0,        // Unlimited retries
      jitter: true,          // Add randomness
    });

    // Subscribe to connection state changes
    this.connectionState.subscribe(() => this.notifyListeners());
  }

  /**
   * Initialize the auth service - restore session from storage.
   */
  async initialize(): Promise<void> {
    try {
      const stored = await chrome.storage.local.get([
        STORAGE_KEYS.TOKEN,
        STORAGE_KEYS.USER,
        STORAGE_KEYS.SESSION_ID,
      ]);

      if (stored[STORAGE_KEYS.TOKEN] && stored[STORAGE_KEYS.USER]) {
        apiClient.setToken(stored[STORAGE_KEYS.TOKEN] as string);
        this.user = stored[STORAGE_KEYS.USER] as AuthUser;
        this.sessionId = (stored[STORAGE_KEYS.SESSION_ID] as string | undefined) || this.generateSessionId();

        // Verify token is still valid
        const result = await apiClient.getUser();
        if (result.success && result.data) {
          this.user = result.data;
          await this.connectToServer();
          logActivity({
            type: 'auth',
            action: 'session_restored',
            description: `Session restored for ${this.user.email}`,
            success: true,
          });
        } else {
          // Token invalid, clear session
          await this.clearSession();
          logActivity({
            type: 'auth',
            action: 'session_expired',
            description: 'Previous session expired',
            success: false,
          });
        }
      }
    } catch (error) {
      console.error('[AuthService] Failed to initialize:', error);
      await this.clearSession();
    }

    this.notifyListeners();
  }

  /**
   * Login with email and password.
   */
  async login(email: string, password: string): Promise<LoginResponse> {
    const startTime = Date.now();

    try {
      const result = await apiClient.login(email, password);

      if (result.success && result.token && result.user) {
        this.user = result.user;
        this.sessionId = this.generateSessionId();

        // Persist to storage
        await chrome.storage.local.set({
          [STORAGE_KEYS.TOKEN]: result.token,
          [STORAGE_KEYS.USER]: result.user,
          [STORAGE_KEYS.SESSION_ID]: this.sessionId,
        });

        // Connect to server
        await this.connectToServer();

        logActivity({
          type: 'auth',
          action: 'login',
          description: `Signed in as ${result.user.email}`,
          success: true,
          durationMs: Date.now() - startTime,
        });

        this.notifyListeners();
        return result;
      }

      logActivity({
        type: 'auth',
        action: 'login_failed',
        description: result.error || 'Login failed',
        success: false,
        durationMs: Date.now() - startTime,
      });

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logActivity({
        type: 'auth',
        action: 'login_error',
        description: errorMsg,
        success: false,
        durationMs: Date.now() - startTime,
      });

      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Google login is not implemented by the bundled backend API client.
   */
  async googleLogin(): Promise<LoginResponse> {
    return {
      success: false,
      error: 'Google login is not configured for this extension build',
    };
  }

  /**
   * Logout and clear session.
   */
  async logout(): Promise<void> {
    const userEmail = this.user?.email;

    try {
      // Notify server of disconnect
      if (this.connectionState.isConnected()) {
        await apiClient.disconnect();
      }
    } catch (error) {
      console.error('[AuthService] Error during disconnect:', error);
    }

    await this.clearSession();

    logActivity({
      type: 'auth',
      action: 'logout',
      description: userEmail ? `Signed out from ${userEmail}` : 'Signed out',
      success: true,
    });

    this.notifyListeners();
  }

  /**
   * Connect to the Laravel server (mark online) and Reverb WebSocket.
   * Implements graceful error handling with automatic reconnection.
   */
  private async connectToServer(): Promise<void> {
    if (!this.sessionId || !this.user) return;

    this.connectionState.setConnecting();

    try {
      const result = await apiClient.connect(this.sessionId);

      if (result.success) {
        this.connectionState.setConnected();
        this.heartbeatFailures = 0;
        this.startHeartbeat();

        // Connect to Reverb WebSocket for receiving commands
        await reverbClient.connect(this.user.id);

        logActivity({
          type: 'connection',
          action: 'server_connected',
          description: 'Connected to Sortie server',
          success: true,
        });
      } else {
        // Handle connection failure
        this.handleConnectionError(result.status || 0, result.error || 'Connection failed');
      }
    } catch (error) {
      console.error('[AuthService] Failed to connect to server:', error);
      this.handleConnectionError(0, (error as Error).message);
    }
  }

  /**
   * Handle connection error with automatic reconnection.
   */
  private handleConnectionError(status: number, message: string): void {
    const { code, message: errorMessage } = parseHttpError(status, message);

    // Log the error
    logActivity({
      type: 'error',
      action: 'connection_error',
      description: errorMessage,
      success: false,
      details: { code, status },
    });

    // Handle error and get retry info
    const { shouldRetry, delay } = this.connectionState.handleError(code, errorMessage);

    if (shouldRetry && delay) {
      // Schedule reconnection
      this.connectionState.scheduleReconnect(async () => {
        await this.connectToServer();
      }, delay);

      logActivity({
        type: 'connection',
        action: 'reconnect_scheduled',
        description: `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.connectionState.getInfo().reconnectAttempt})`,
        success: true,
      });
    } else if (code === ErrorCodes.AUTH_EXPIRED) {
      // Auth expired - need user to re-login
      logActivity({
        type: 'auth',
        action: 'session_expired',
        description: 'Session expired. Please sign in again.',
        success: false,
      });
    }
  }

  /**
   * Start heartbeat to keep connection alive.
   * Implements failure tracking and automatic reconnection.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatFailures = 0;

    this.heartbeatInterval = setInterval(async () => {
      if (!this.sessionId) return;

      try {
        const result = await apiClient.heartbeat(this.sessionId);

        if (result.success) {
          // Reset failure counter on success
          this.heartbeatFailures = 0;

          // If we were reconnecting, mark as connected
          if (!this.connectionState.isConnected()) {
            this.connectionState.setConnected();
            logActivity({
              type: 'connection',
              action: 'reconnected',
              description: 'Connection restored',
              success: true,
            });
          }
        } else {
          this.heartbeatFailures++;
          console.warn(`[AuthService] Heartbeat failed (${this.heartbeatFailures}/${HEARTBEAT_FAILURE_THRESHOLD}):`, result.error);

          // Only mark as offline after threshold failures
          if (this.heartbeatFailures >= HEARTBEAT_FAILURE_THRESHOLD) {
            this.handleHeartbeatFailure(result.status || 0, result.error || 'Heartbeat failed');
          }
        }
      } catch (error) {
        this.heartbeatFailures++;
        console.error(`[AuthService] Heartbeat error (${this.heartbeatFailures}/${HEARTBEAT_FAILURE_THRESHOLD}):`, error);

        if (this.heartbeatFailures >= HEARTBEAT_FAILURE_THRESHOLD) {
          this.handleHeartbeatFailure(0, (error as Error).message);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Handle heartbeat failure - attempt reconnection.
   */
  private handleHeartbeatFailure(status: number, message: string): void {
    // Stop the heartbeat interval while we reconnect
    this.stopHeartbeat();

    // Handle like a connection error
    this.handleConnectionError(status, message);
  }

  /**
   * Stop heartbeat.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Clear session data.
   */
  private async clearSession(): Promise<void> {
    this.stopHeartbeat();

    // Reset connection state
    this.connectionState.setDisconnected();
    this.heartbeatFailures = 0;

    // Clear token FIRST to prevent any pending reconnects from succeeding
    apiClient.setToken(null);

    // Then disconnect from Reverb WebSocket
    await reverbClient.disconnect();

    this.user = null;
    this.sessionId = null;

    await chrome.storage.local.remove([
      STORAGE_KEYS.TOKEN,
      STORAGE_KEYS.USER,
      STORAGE_KEYS.SESSION_ID,
    ]);
  }

  /**
   * Generate a unique session ID.
   */
  private generateSessionId(): string {
    return `ext_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  /**
   * Get current auth state with detailed connection info.
   * Uses Reverb WebSocket state for the SERVER indicator.
   */
  getState(): AuthState {
    const reverbState = reverbClient.getConnectionState();
    const httpConnInfo = this.connectionState.getInfo();

    return {
      isAuthenticated: this.user !== null,
      user: this.user,
      // Combined: true only if both HTTP heartbeat and Reverb are connected
      isConnected: this.connectionState.isConnected() && reverbClient.isConnectedToReverb(),
      // Use Reverb state for SERVER indicator (what user cares about)
      connectionState: reverbState,
      statusMessage: getStateMessage(httpConnInfo),
      reconnectAttempt: httpConnInfo.reconnectAttempt,
      lastError: httpConnInfo.lastError?.message || null,
    };
  }

  /**
   * Check if user is authenticated.
   */
  isAuthenticated(): boolean {
    return this.user !== null;
  }

  /**
   * Get current user.
   */
  getUser(): AuthUser | null {
    return this.user;
  }

  /**
   * Get current session ID.
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Check if connected to server.
   */
  isConnectedToServer(): boolean {
    return this.connectionState.isConnected();
  }

  /**
   * Manually trigger reconnection attempt.
   */
  async reconnect(): Promise<void> {
    if (this.user && this.sessionId) {
      this.connectionState.reset();
      await this.connectToServer();
    }
  }

  /**
   * Subscribe to auth state changes.
   */
  subscribe(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Notify all listeners of state change.
   */
  private notifyListeners(): void {
    const state = this.getState();
    this.listeners.forEach(listener => listener(state));
  }
}

// Singleton instance
export const authService = new AuthService();
