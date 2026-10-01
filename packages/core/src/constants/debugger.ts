/**
 * Chrome Debugger API constants.
 */

export const DEBUGGER = {
  /** Chrome DevTools Protocol version */
  PROTOCOL_VERSION: '1.3',

  /** Storage key for persisting connected tab ID */
  STORAGE_KEY: 'connectedTabId',

  /** Domains to enable after attaching debugger */
  DOMAINS: ['Page', 'DOM', 'Runtime'] as const,
} as const;

export type DebuggerDomain = (typeof DEBUGGER.DOMAINS)[number];
