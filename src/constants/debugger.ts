/**
 * Chrome Debugger API constants.
 */

export const DEBUGGER = {
  /** Chrome DevTools Protocol version */
  PROTOCOL_VERSION: '1.3',

  /** Storage key for persisting connected tab ID */
  STORAGE_KEY: 'connectedTabId',
  /** Tab id the connected tab got through auto-attach (the user's own tab), not through the agent. Survives a service-worker restart. */
  AUTO_ATTACHED_KEY: 'autoAttachedTabId',

  /** Domains to enable after attaching debugger */
  DOMAINS: ['Page', 'DOM', 'Runtime'] as const,
} as const;

export type DebuggerDomain = (typeof DEBUGGER.DOMAINS)[number];
