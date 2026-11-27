export const SETUP_INSTANCES = {
  nas: {
    name: 'NAS',
    origin: 'https://agent-browser.staticduo.com',
    wsUrl: 'wss://agent-browser.staticduo.com/ws',
    baseUrl: 'https://litellm.staticduo.com/v1',
    mcpUrl: 'https://agentgateway.staticduo.com/jake/mcp',
  },
  defend: {
    name: 'Defend (Fedora)',
    origin: 'https://agent-browser.defend.tech',
    wsUrl: 'wss://agent-browser.defend.tech/ws',
    baseUrl: 'https://litellm.defend.tech/v1',
    mcpUrl: 'https://agentgateway.staticduo.com/jake-defend/mcp',
  },
  ari: {
    name: 'Ari',
    origin: 'https://opencode-ari.staticduo.com',
    wsUrl: 'wss://opencode-ari.staticduo.com/browser-ws',
    baseUrl: 'https://litellm.staticduo.com/v1',
    mcpUrl: 'https://agentgateway.staticduo.com/jake/mcp',
  },
} as const;

export type SetupInstance = keyof typeof SETUP_INSTANCES;

export function isSetupInstance(value: unknown): value is SetupInstance {
  return typeof value === 'string' && Object.hasOwn(SETUP_INSTANCES, value);
}

export type SetupPairingInfo = {
  state: 'idle' | 'starting' | 'pending' | 'approved' | 'expired' | 'error';
  instance?: SetupInstance;
  error?: string;
};
