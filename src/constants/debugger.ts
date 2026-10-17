/**
 * Chrome Debugger API constants.
 */

export const DEBUGGER = {
  /** Chrome DevTools Protocol version */
  PROTOCOL_VERSION: '1.3',

  /** Tabs the agent drives, so a service-worker restart picks them up again (was one tab: INFRA-907). */
  STORAGE_KEY: 'drivenTabIds',
  /** Of those, the ones reached by auto-attach (the user's own tab) rather than chosen by the agent. */
  AUTO_ATTACHED_KEY: 'autoAttachedTabIds',

  /** Domains to enable after attaching debugger */
  DOMAINS: ['Page', 'DOM', 'Runtime'] as const,
} as const;

export type DebuggerDomain = (typeof DEBUGGER.DOMAINS)[number];
