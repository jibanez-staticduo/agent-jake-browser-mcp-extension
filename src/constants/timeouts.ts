/**
 * Timeout constants used throughout the extension.
 * Centralizes magic numbers for easier maintenance.
 */

export const TIMEOUTS = {
  /** Duration to show element highlight overlay (ms) */
  HIGHLIGHT_DURATION: 2000,

  /** Time to wait for DOM stability check (ms) */
  DOM_STABILITY_MS: 500,

  /** Maximum wait for debugger commands (ms) */
  DEBUGGER_COMMAND: 25000,

  /** Popup polling interval (ms) */
  POLLING_INTERVAL: 2000,

  /** Keep-alive alarm interval (minutes) */
  KEEPALIVE_MINUTES: 0.2,

  /** WebSocket reconnect delay (ms) */
  WS_RECONNECT_DELAY: 1000,

  /** Request timeout for MCP messages (ms) */
  REQUEST_TIMEOUT: 30000,

  /**
   * Longest a command waits for a page to load (ms). Kept 10 s under REQUEST_TIMEOUT, the
   * server's own cut, so the extension still has time to answer: connect, attach the
   * debugger and install the WebAuthn guard run after it.
   */
  TAB_LOAD_WAIT: 20000,
} as const;

export type TimeoutKey = keyof typeof TIMEOUTS;
