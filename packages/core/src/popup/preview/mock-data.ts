/**
 * Mock data fixtures for standalone preview mode.
 * Uses the same types as production popup components.
 */
import type { AuthUser, AuthState, TabInfo, ActivityEntry, Status } from '../types';

export const MOCK_USER: AuthUser = {
  id: 1,
  name: 'Jake Dev',
  email: 'jake@example.com',
};

export const MOCK_AUTH_AUTHENTICATED: AuthState = {
  isAuthenticated: true,
  user: MOCK_USER,
  isConnected: true,
  connectionState: 'connected',
  statusMessage: 'Connected to Reverb',
};

export const MOCK_AUTH_UNAUTHENTICATED: AuthState = {
  isAuthenticated: false,
  user: null,
  isConnected: false,
};

export const MOCK_TABS: TabInfo[] = [
  {
    id: 101,
    url: 'https://example.com/dashboard',
    title: 'Example Dashboard',
    active: true,
    connected: false,
    favIconUrl: '',
    windowId: 1,
  },
  {
    id: 102,
    url: 'https://github.com/SnakeO/agent-jake',
    title: 'GitHub - Agent Jake',
    active: false,
    connected: false,
    favIconUrl: '',
    windowId: 1,
  },
  {
    id: 103,
    url: 'https://docs.example.com',
    title: 'API Documentation',
    active: false,
    connected: false,
    favIconUrl: '',
    windowId: 1,
  },
];

export function createMockActivities(): ActivityEntry[] {
  const now = Date.now();
  return [
    {
      id: 'act-1',
      timestamp: now - 60000,
      type: 'auth',
      action: 'login',
      description: 'Authenticated as jake@example.com',
      success: true,
      durationMs: 340,
    },
    {
      id: 'act-2',
      timestamp: now - 50000,
      type: 'connection',
      action: 'connect',
      description: 'Connected to tab 101 (Example Dashboard)',
      success: true,
      durationMs: 120,
    },
    {
      id: 'act-3',
      timestamp: now - 40000,
      type: 'tool',
      action: 'browser_navigate',
      description: 'Navigated to https://example.com/dashboard',
      success: true,
      durationMs: 850,
    },
    {
      id: 'act-4',
      timestamp: now - 30000,
      type: 'tool',
      action: 'browser_snapshot',
      description: 'Generated accessibility snapshot (42 nodes)',
      success: true,
      durationMs: 320,
    },
    {
      id: 'act-5',
      timestamp: now - 20000,
      type: 'tool',
      action: 'browser_click',
      description: 'Clicked element ref s1e42',
      success: true,
      durationMs: 45,
    },
    {
      id: 'act-6',
      timestamp: now - 10000,
      type: 'error',
      action: 'browser_type',
      description: 'Element ref s1e99 not found in snapshot',
      success: false,
      details: { ref: 's1e99', error: 'Element not found' },
    },
  ];
}

export function createMockStatus(connected: boolean, tabId: number | null): Status {
  const tabs = MOCK_TABS.map(t => ({
    ...t,
    connected: connected && t.id === tabId,
  }));

  return {
    connected,
    tabId,
    tabs,
  };
}
