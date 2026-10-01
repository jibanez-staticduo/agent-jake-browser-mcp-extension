/**
 * Extension configuration constants.
 */

export const CONFIG = {
  // WebSocket connection to browser-mcp server
  // Default is LOCAL ONLY. The previous default pointed at a third-party host
  // (agent-browser.staticduo.com:443) and, with <all_urls> + debugger granted,
  // that hands full control of the browser to whoever runs that host. Do not
  // reintroduce a remote default.
  WS_PORT: Number(import.meta.env.VITE_WS_PORT ?? 8765),
  WS_HOST: import.meta.env.VITE_WS_HOST ?? '127.0.0.1',
  WS_PATH: import.meta.env.VITE_WS_PATH ?? '',
  WS_SECURE: (import.meta.env.VITE_WS_SECURE ?? 'false') === 'true',
  // Shared secret with the server (compiled in via VITE_WS_TOKEN).
  WS_TOKEN: import.meta.env.VITE_WS_TOKEN ?? '',

  // Reconnection settings
  RECONNECT_INTERVAL_MS: 5000,  // Check every 5 seconds (fixed, no backoff)
  MAX_RECONNECT_ATTEMPTS: 0,    // 0 = unlimited retries
  WS_HEARTBEAT_INTERVAL_MS: 25000,

  // Timeouts
  MESSAGE_TIMEOUT_MS: 30000,
  ELEMENT_WAIT_TIMEOUT_MS: 10000,
  DOM_STABILITY_MS: 500,

  // Retry settings
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 500,

  // Snapshot settings
  MAX_SNAPSHOT_AGE_MS: 30000,
  MAX_NAME_LENGTH: 500,

  // Error codes
  ERRORS: {
    NO_TAB: 'NO_CONNECTED_TAB',
    STALE_REF: 'STALE_ELEMENT_REF',
    NOT_FOUND: 'ELEMENT_NOT_FOUND',
    NOT_VISIBLE: 'ELEMENT_NOT_VISIBLE',
    NOT_CLICKABLE: 'ELEMENT_NOT_CLICKABLE',
    TIMEOUT: 'OPERATION_TIMEOUT',
    WS_DISCONNECTED: 'WEBSOCKET_DISCONNECTED',
  },
} as const;

export type ErrorCode = typeof CONFIG.ERRORS[keyof typeof CONFIG.ERRORS];
