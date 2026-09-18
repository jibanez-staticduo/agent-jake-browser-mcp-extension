import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  runtime: {
    getURL: (path: string) => `chrome-extension://test-id/${path}`,
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

type RuntimeModule = typeof import('@/config/runtime');

async function loadRuntime(): Promise<RuntimeModule> {
  vi.resetModules();
  return await import('@/config/runtime');
}

const fetchMock = vi.fn();

function bundleResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: async () => body,
  });
}

function throwingJson(status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  });
}

/** Default: no packaged config.json (fetch of a missing extension resource). */
function missingBundle() {
  fetchMock.mockImplementation(() => Promise.reject(new Error('not found')));
}

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  missingBundle();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseWsUrl', () => {
  it('parses a secure URL with default port and no path', async () => {
    const { parseWsUrl } = await loadRuntime();
    expect(parseWsUrl('wss://agent-browser.staticduo.com')).toEqual({
      secure: true,
      hostname: 'agent-browser.staticduo.com',
      port: 443,
      path: '',
    });
  });

  it('parses an insecure URL with explicit port and path', async () => {
    const { parseWsUrl } = await loadRuntime();
    expect(parseWsUrl('ws://192.168.1.5:8765/jake')).toEqual({
      secure: false,
      hostname: '192.168.1.5',
      port: 8765,
      path: '/jake',
    });
  });

  it('maps http/https to ws/wss and strips trailing slashes', async () => {
    const { parseWsUrl } = await loadRuntime();
    expect(parseWsUrl('https://example.com/mcp/')).toEqual({
      secure: true,
      hostname: 'example.com',
      port: 443,
      path: '/mcp',
    });
    expect(parseWsUrl('http://localhost:8765')?.secure).toBe(false);
  });

  it('treats a bare host as secure', async () => {
    const { parseWsUrl } = await loadRuntime();
    const parsed = parseWsUrl('browser.example.com');
    expect(parsed?.secure).toBe(true);
    expect(parsed?.hostname).toBe('browser.example.com');
  });

  it('rejects empty and malformed values', async () => {
    const { parseWsUrl } = await loadRuntime();
    expect(parseWsUrl('')).toBeNull();
    expect(parseWsUrl('   ')).toBeNull();
    expect(parseWsUrl('http://')).toBeNull();
    expect(parseWsUrl('ftp://host')).toBeNull();
  });
});

describe('precedence: storage > config.json > build', () => {
  it('uses build defaults when storage is empty and there is no config.json', async () => {
    const { getEffectiveConfig } = await loadRuntime();
    const cfg = await getEffectiveConfig();
    expect(cfg.hostname).toBe('build.host');
    expect(cfg.port).toBe(9999);
    expect(cfg.secure).toBe(false);
    expect(cfg.scheme).toBe('ws');
    expect(cfg.path).toBe('');
    expect(cfg.token).toBe('buildtok');
    expect(cfg.source).toBe('build');
    expect(cfg.fromStorage).toBe(false);
    expect(cfg.connectionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('uses the packaged config.json when storage has no server URL', async () => {
    const { getEffectiveConfig } = await loadRuntime();
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('config.json')) {
        return bundleResponse({ version: 1, wsUrl: 'wss://embedded.example.com/mcp' });
      }
      return Promise.reject(new Error('unexpected fetch'));
    });
    const cfg = await getEffectiveConfig();
    expect(cfg.hostname).toBe('embedded.example.com');
    expect(cfg.port).toBe(443);
    expect(cfg.secure).toBe(true);
    expect(cfg.scheme).toBe('wss');
    expect(cfg.path).toBe('/mcp');
    expect(cfg.source).toBe('config.json');
    expect(cfg.fromStorage).toBe(false);
  });

  it('prefers the manual storage override over a valid config.json', async () => {
    const { getEffectiveConfig, STORAGE_KEYS } = await loadRuntime();
    store[STORAGE_KEYS.serverUrl] = 'ws://manual.local:1234';
    fetchMock.mockImplementation(() =>
      bundleResponse({ version: 1, wsUrl: 'wss://embedded.example.com' }));
    const cfg = await getEffectiveConfig();
    expect(cfg.hostname).toBe('manual.local');
    expect(cfg.port).toBe(1234);
    expect(cfg.source).toBe('manual');
    expect(cfg.fromStorage).toBe(true);
  });
});

describe('config.json fallbacks (all silent, never reject)', () => {
  const invalidCases: Array<[string, unknown]> = [
    ['non-1 version', { version: 2, wsUrl: 'wss://embedded.example.com' }],
    ['missing version', { wsUrl: 'wss://embedded.example.com' }],
    ['non-ws wsUrl', { version: 1, wsUrl: 'https://embedded.example.com' }],
    ['garbage wsUrl', { version: 1, wsUrl: '::not a url::' }],
    ['missing wsUrl', { version: 1 }],
    ['null wsUrl', { version: 1, wsUrl: null }],
  ];

  it.each(invalidCases)('falls back to build for %s', async (_label, body) => {
    const { getEffectiveConfig } = await loadRuntime();
    fetchMock.mockImplementation(() => bundleResponse(body));
    const cfg = await getEffectiveConfig();
    expect(cfg.hostname).toBe('build.host');
    expect(cfg.source).toBe('build');
  });

  it('falls back to build when config.json is malformed JSON', async () => {
    const { getEffectiveConfig } = await loadRuntime();
    fetchMock.mockImplementation(() => throwingJson());
    const cfg = await getEffectiveConfig();
    expect(cfg.source).toBe('build');
  });

  it('falls back to build when config.json returns HTTP error status', async () => {
    const { getEffectiveConfig } = await loadRuntime();
    fetchMock.mockImplementation(() => bundleResponse({}, 404));
    const cfg = await getEffectiveConfig();
    expect(cfg.source).toBe('build');
  });
});

describe('config.json load caching', () => {
  it('fetches config.json once per service-worker lifetime', async () => {
    const { getEffectiveConfig } = await loadRuntime();
    fetchMock.mockImplementation(() =>
      bundleResponse({ version: 1, wsUrl: 'wss://embedded.example.com' }));
    await getEffectiveConfig();
    await getEffectiveConfig();
    const bundleFetches = fetchMock.mock.calls.filter(
      (call) => String(call[0]).includes('config.json'),
    );
    expect(bundleFetches).toHaveLength(1);
  });

  it('caches negative results too', async () => {
    const { getEffectiveConfig } = await loadRuntime();
    await getEffectiveConfig();
    await getEffectiveConfig();
    const bundleFetches = fetchMock.mock.calls.filter(
      (call) => String(call[0]).includes('config.json'),
    );
    expect(bundleFetches).toHaveLength(1);
  });
});

describe('getEffectiveConfig token', () => {
  it('applies token precedence: stored value > stored empty > build default', async () => {
    const { getEffectiveConfig, STORAGE_KEYS } = await loadRuntime();
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
    const { ensureConnectionId, STORAGE_KEYS } = await loadRuntime();
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
    const { getEffectiveConfig, buildWsUrl, STORAGE_KEYS } = await loadRuntime();
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
    const { getEffectiveConfig, buildWsUrl, STORAGE_KEYS } = await loadRuntime();
    store[STORAGE_KEYS.token] = '';
    store[STORAGE_KEYS.connectionId] = 'cid-open';
    const cfg = await getEffectiveConfig();
    const url = buildWsUrl(cfg);
    expect(url).not.toContain('token=');
    expect(url).toContain('connectionId=cid-open');
  });

  it('keeps non-default ports and the path', async () => {
    const { getEffectiveConfig, buildWsUrl, STORAGE_KEYS } = await loadRuntime();
    store[STORAGE_KEYS.serverUrl] = 'ws://192.168.1.5:8765/jake';
    store[STORAGE_KEYS.token] = '';
    store[STORAGE_KEYS.connectionId] = 'cid-lan';
    const cfg = await getEffectiveConfig();
    expect(buildWsUrl(cfg).startsWith('ws://192.168.1.5:8765/jake?')).toBe(true);
  });

  it('derives the http origin with the matching scheme and port rules', async () => {
    const { getEffectiveConfig, httpOrigin, STORAGE_KEYS } = await loadRuntime();
    store[STORAGE_KEYS.serverUrl] = 'wss://pair.example.com';
    store[STORAGE_KEYS.connectionId] = 'cid-1';
    expect(httpOrigin(await getEffectiveConfig())).toBe('https://pair.example.com');

    store[STORAGE_KEYS.serverUrl] = 'ws://lan.local:8765';
    expect(httpOrigin(await getEffectiveConfig())).toBe('http://lan.local:8765');
  });

  it('derives the http origin from config.json when that is the source', async () => {
    const { getEffectiveConfig, httpOrigin, STORAGE_KEYS } = await loadRuntime();
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('config.json')) {
        return bundleResponse({ version: 1, wsUrl: 'wss://embedded.example.com/ws' });
      }
      return Promise.reject(new Error('unexpected fetch'));
    });
    store[STORAGE_KEYS.connectionId] = 'cid-emb';
    const cfg = await getEffectiveConfig();
    expect(cfg.source).toBe('config.json');
    expect(httpOrigin(cfg)).toBe('https://embedded.example.com');
  });
});
