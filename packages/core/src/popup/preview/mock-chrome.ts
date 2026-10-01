/**
 * Chrome API mock for standalone preview mode.
 * Installs a fake `chrome` global before Vue mounts,
 * so Pinia stores work without the real extension runtime.
 */
import type { ActivityEntry, ActivityLogResponse, AuthState, LoginResponse, Status } from '../types';
import {
  MOCK_AUTH_AUTHENTICATED,
  MOCK_AUTH_UNAUTHENTICATED,
  MOCK_TABS,
  createMockActivities,
  createMockStatus,
} from './mock-data';

// --- Reactive preview state (mutated by StateController) ---
export const previewState = {
  authenticated: false,
  connected: false,
  connectedTabId: null as number | null,
  activities: [] as ActivityEntry[],
};

// Counter for generating unique activity IDs
let activityCounter = 100;

/** Add a mock activity entry and return its ID */
export function addMockActivity(entry: Omit<ActivityEntry, 'id' | 'timestamp'>): string {
  const id = `act-${++activityCounter}`;
  previewState.activities.unshift({
    ...entry,
    id,
    timestamp: Date.now(),
  });
  return id;
}

/** Clear all mock activities */
export function clearMockActivities(): void {
  previewState.activities = [];
}

/** Reset state to defaults */
export function resetPreviewState(): void {
  previewState.authenticated = false;
  previewState.connected = false;
  previewState.connectedTabId = null;
  previewState.activities = [];
}

/** Populate with sample activities */
export function seedActivities(): void {
  previewState.activities = createMockActivities();
}

// --- Message handler (routes chrome.runtime.sendMessage calls) ---

function handleMessage(msg: { action: string; payload?: unknown }): unknown {
  switch (msg.action) {
    case 'getAuthState': {
      if (previewState.authenticated) {
        return { ...MOCK_AUTH_AUTHENTICATED } satisfies AuthState;
      }
      return { ...MOCK_AUTH_UNAUTHENTICATED } satisfies AuthState;
    }

    case 'login': {
      previewState.authenticated = true;
      return { success: true, user: MOCK_AUTH_AUTHENTICATED.user ?? undefined } satisfies LoginResponse;
    }

    case 'logout': {
      previewState.authenticated = false;
      previewState.connected = false;
      previewState.connectedTabId = null;
      return { success: true };
    }

    case 'getStatus': {
      return createMockStatus(previewState.connected, previewState.connectedTabId) satisfies Status;
    }

    case 'connectTab': {
      const payload = msg.payload as { tabId: number } | undefined;
      const tabId = payload?.tabId ?? MOCK_TABS[0].id;
      previewState.connected = true;
      previewState.connectedTabId = tabId;
      addMockActivity({
        type: 'connection',
        action: 'connect',
        description: `Connected to tab ${tabId}`,
        success: true,
        durationMs: 95,
      });
      return { success: true };
    }

    case 'disconnectTab': {
      previewState.connected = false;
      previewState.connectedTabId = null;
      addMockActivity({
        type: 'connection',
        action: 'disconnect',
        description: 'Disconnected from tab',
        success: true,
      });
      return { success: true };
    }

    case 'getActivity': {
      const payload = msg.payload as { limit?: number } | undefined;
      const limit = payload?.limit;
      const activities = limit
        ? previewState.activities.slice(0, limit)
        : previewState.activities;
      return {
        activities,
        total: previewState.activities.length,
      } satisfies ActivityLogResponse;
    }

    case 'clearActivity': {
      previewState.activities = [];
      return { success: true };
    }

    default:
      console.warn(`[mock-chrome] Unhandled message action: ${msg.action}`);
      return { success: true };
  }
}

// --- Install mock chrome global ---

export function installMockChrome(): void {
  const storage = new Map<string, unknown>();

  const mockChrome = {
    runtime: {
      sendMessage(
        message: { action: string; payload?: unknown },
        callback?: (response: unknown) => void,
      ): void {
        // Simulate async response
        const result = handleMessage(message);
        if (callback) {
          setTimeout(() => callback(result), 10);
        }
      },
      onMessage: {
        addListener(_fn: Function): void { /* no-op for preview */ },
        removeListener(_fn: Function): void { /* no-op */ },
      },
      lastError: null as chrome.runtime.LastError | null,
      getManifest() {
        return { version: '0.0.0-preview' };
      },
      onInstalled: {
        addListener(_fn: Function): void { /* no-op */ },
      },
    },

    storage: {
      local: {
        async get(keys: string | string[]): Promise<Record<string, unknown>> {
          const keyList = typeof keys === 'string' ? [keys] : keys;
          const result: Record<string, unknown> = {};
          for (const k of keyList) {
            if (storage.has(k)) result[k] = storage.get(k);
          }
          return result;
        },
        async set(items: Record<string, unknown>): Promise<void> {
          Object.entries(items).forEach(([k, v]) => storage.set(k, v));
        },
        async remove(keys: string | string[]): Promise<void> {
          const keyList = typeof keys === 'string' ? [keys] : keys;
          keyList.forEach(k => storage.delete(k));
        },
      },
    },

    tabs: {
      async get(tabId: number) {
        const tab = MOCK_TABS.find(t => t.id === tabId);
        return tab ?? { id: tabId, url: '', title: 'Unknown Tab', active: false, windowId: 1 };
      },
      async query(_options: unknown) {
        return MOCK_TABS;
      },
      async update(_tabId: number, _props: unknown) { /* no-op */ },
      async create(_options: unknown) { return { id: 999 }; },
      async remove(_tabId: number) { /* no-op */ },
      async reload(_tabId: number) { /* no-op */ },
      async goBack(_tabId: number) { /* no-op */ },
      async goForward(_tabId: number) { /* no-op */ },
      async sendMessage(_tabId: number, _msg: unknown) { return {}; },
      onCreated: {
        addListener(_fn: Function) { /* no-op */ },
        removeListener(_fn: Function) { /* no-op */ },
      },
      onUpdated: {
        addListener(_fn: Function) { /* no-op */ },
        removeListener(_fn: Function) { /* no-op */ },
      },
    },

    windows: {
      async update(_windowId: number, _options: unknown) { /* no-op */ },
    },

    alarms: {
      create() { /* no-op */ },
      clear() { /* no-op */ },
      async get(_name: string) { return null; },
      onAlarm: {
        addListener(_fn: Function) { /* no-op */ },
      },
    },

    scripting: {
      async executeScript() { return [{ result: true }]; },
    },

    devtools: {
      inspectedWindow: { tabId: 1 },
    },
  };

  // Install globally
  (window as any).chrome = mockChrome;
}
