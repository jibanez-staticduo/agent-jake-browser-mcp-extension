import { beforeEach, describe, expect, it, vi } from 'vitest';

const store: Record<string, unknown> = {};

const mockChrome = {
  storage: {
    local: {
      get: vi.fn(async (keys?: string | string[] | null) => {
        const list = keys === undefined || keys === null
          ? Object.keys(store)
          : Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const key of list) {
          if (key in store) out[key] = store[key];
        }
        return out;
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(store, items);
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const key of list) delete store[key];
      }),
    },
  },
};

(globalThis as { chrome?: unknown }).chrome = mockChrome as unknown;

vi.mock('@/types/config', () => ({
  CONFIG: {
    WS_HOST: 'build.host',
    WS_PORT: 9999,
    WS_PATH: '',
    WS_SECURE: false,
    WS_TOKEN: 'buildtok',
  },
}));

import {
  buildWsUrl,
  ensureConnectionId,
  getEffectiveConfig,
  httpOrigin,
  parseWsUrl,
  STORAGE_KEYS,
} from '@/config/runtime';

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  vi.clearAllMocks();
});

describe('parseWsUrl', () => {
  it('parses a secure URL with default port and no path', () => {
    expect(parseWsUrl('wss://agent-browser.staticduo.com')).toEqual({
      secure: true,
      hostname: 'agent-browser.staticduo.com',
      port: 443,
      path: '',
    });
  });

  it('parses an insecure URL with explicit port and path', () => {
    expect(parseWsUrl('ws://192.168.1.5:8765/jake')).toEqual({
      secure: false,
      hostname: '192.168.1.5',
      port: 8765,
      path: '/jake',
    });
  });

  it('maps http/https to ws/wss and strips trailing slashes', () => {
    expect(parseWsUrl('https://example.com/mcp/')).toEqual({
      secure: true,
      hostname: 'example.com',
      port: 443,
      path: '/mcp',
    });
    expect(parseWsUrl('http://localhost:8765')?.secure).toBe(false);
  });

  it('treats a bare host as secure', () => {
    const parsed = parseWsUrl('browser.example.com');
    expect(parsed?.secure).toBe(true);
    expect(parsed?.hostname).toBe('browser.example.com');
  });

  it('rejects empty and malformed values', () => {
    expect(parseWsUrl('')).toBeNull();
    expect(parseWsUrl('   ')).toBeNull();
    expect(parseWsUrl('http://')).toBeNull();
    expect(parseWsUrl('ftp://host')).toBeNull();
  });
});

describe('getEffectiveConfig', () => {
  it('falls back to build defaults when nothing is stored', async () => {
    const cfg = await getEffectiveConfig();
    expect(cfg.hostname).toBe('build.host');
    expect(cfg.port).toBe(9999);
    expect(cfg.secure).toBe(false);
    expect(cfg.scheme).toBe('ws');
    expect(cfg.path).toBe('');
    expect(cfg.token).toBe('buildtok');
    expect(cfg.fromStorage).toBe(false);
    expect(cfg.connectionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('uses the stored server URL when valid', async () => {
    store[STORAGE_KEYS.serverUrl] = 'wss://agent-browser.staticduo.com/jake';
    const cfg = await getEffectiveConfig();
    expect(cfg.hostname).toBe('agent-browser.staticduo.com');
    expect(cfg.port).toBe(443);
    expect(cfg.secure).toBe(true);
    expect(cfg.scheme).toBe('wss');
    expect(cfg.path).toBe('/jake');
    expect(cfg.fromStorage).toBe(true);
  });

  it('ignores an unparseable stored URL and keeps build defaults', async () => {
    store[STORAGE_KEYS.serverUrl] = 'http://';
    const cfg = await getEffectiveConfig();
    expect(cfg.hostname).toBe('build.host');
    expect(cfg.fromStorage).toBe(false);
  });

  it('applies token precedence: stored value > stored empty > build default', async () => {
    store[STORAGE_KEYS.token] = 'pairtok';
    expect((await getEffectiveConfig()).token).toBe('pairtok');

    store[STORAGE_KEYS.token] = '';
    expect((await getEffectiveConfig()).token).toBe('');

    delete store[STORAGE_KEYS.token];
    expect((await getEffectiveConfig()).token).toBe('buildtok');
  });
});

describe('ensureConnectionId', () => {
  it('generates the UUID once and reuses it afterwards', async () => {
    const first = await ensureConnectionId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(store[STORAGE_KEYS.connectionId]).toBe(first);

    const setCallsBefore = (mockChrome.storage.local.set as ReturnType<typeof vi.fn>).mock.calls.length;
    const second = await ensureConnectionId();
    expect(second).toBe(first);
    const setCallsAfter = (mockChrome.storage.local.set as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(setCallsAfter).toBe(setCallsBefore);
  });
});

describe('buildWsUrl / httpOrigin', () => {
  it('adds token and connectionId query params, URL-encoded', async () => {
    store[STORAGE_KEYS.serverUrl] = 'wss://agent-browser.staticduo.com';
    store[STORAGE_KEYS.token] = 'a&b=c';
    store[STORAGE_KEYS.connectionId] = 'cid-123';
    const cfg = await getEffectiveConfig();
    const url = buildWsUrl(cfg);
    expect(url.startsWith('wss://agent-browser.staticduo.com?')).toBe(true);
    expect(url).toContain('token=a%26b%3Dc');
    expect(url).toContain('connectionId=cid-123');
  });

  it('omits the token param when there is no token but keeps connectionId', async () => {
    store[STORAGE_KEYS.token] = '';
    store[STORAGE_KEYS.connectionId] = 'cid-open';
    const cfg = await getEffectiveConfig();
    const url = buildWsUrl(cfg);
    expect(url).not.toContain('token=');
    expect(url).toContain('connectionId=cid-open');
  });

  it('keeps non-default ports and the path', async () => {
    store[STORAGE_KEYS.serverUrl] = 'ws://192.168.1.5:8765/jake';
    store[STORAGE_KEYS.token] = '';
    store[STORAGE_KEYS.connectionId] = 'cid-lan';
    const cfg = await getEffectiveConfig();
    expect(buildWsUrl(cfg).startsWith('ws://192.168.1.5:8765/jake?')).toBe(true);
  });

  it('derives the http origin with the matching scheme and port rules', async () => {
    store[STORAGE_KEYS.serverUrl] = 'wss://pair.example.com';
    store[STORAGE_KEYS.connectionId] = 'cid-1';
    expect(httpOrigin(await getEffectiveConfig())).toBe('https://pair.example.com');

    store[STORAGE_KEYS.serverUrl] = 'ws://lan.local:8765';
    expect(httpOrigin(await getEffectiveConfig())).toBe('http://lan.local:8765');
  });
});
