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

vi.mock('@/utils/logger', () => ({
  log: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/types/config', async (importOriginal) => {
  const { CONFIG } = await importOriginal<typeof import('@/types/config')>();
  return { CONFIG: { ...CONFIG, WS_HOST: 'build.example', WS_PORT: 443, WS_SECURE: true, WS_TOKEN: 'compiled-token' } };
});

import { STORAGE_KEYS } from '@/config/runtime';

type PairingModule = typeof import('@/background/pairing');

async function loadPairing(): Promise<PairingModule> {
  vi.resetModules();
  return await import('@/background/pairing');
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: async () => body,
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  store[STORAGE_KEYS.serverUrl] = 'wss://pair.example.com';
  store[STORAGE_KEYS.connectionId] = 'cid-1';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('startPairing', () => {
  it('registers the OTP via POST /pair/start and exposes the approval link', async () => {
    const pairing = await loadPairing();
    fetchMock.mockImplementation((url: string) => {
      if (url === 'https://pair.example.com/pair/start') return jsonResponse({ ok: true });
      return jsonResponse({ state: 'pending' });
    });

    const result = await pairing.startPairing();

    expect(result.otp).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(result.approveUrl).toBe(`https://pair.example.com/pair?otp=${result.otp}`);

    const startCall = fetchMock.mock.calls.find(
      (call) => call[0] === 'https://pair.example.com/pair/start',
    );
    expect(startCall).toBeDefined();
    expect(startCall?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ otp: result.otp, connectionId: 'cid-1' }),
    });

    expect(store[STORAGE_KEYS.pairCode]).toMatchObject({
      otp: result.otp, wsUrl: 'wss://pair.example.com', serverRevision: null,
      connectionId: 'cid-1', startedAt: expect.any(Number),
    });
    expect(pairing.getPairingInfo().state).toBe('pending');
    pairing.cancelPairing();
  });

  it('surfaces an HTTP failure from /pair/start', async () => {
    const pairing = await loadPairing();
    fetchMock.mockReturnValue(jsonResponse({ error: 'no pairing' }, false, 404));

    await expect(pairing.startPairing()).rejects.toThrow(/HTTP 404/);
    expect(pairing.getPairingInfo().state).toBe('error');
    expect(store[STORAGE_KEYS.pairCode]).toBeUndefined();
    pairing.cancelPairing();
  });
});

describe('pollPairStatusOnce', () => {
  it('stores the emitted token and fires the reload callback on approval', async () => {
    const pairing = await loadPairing();
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/pair/start')) return jsonResponse({ ok: true });
      return jsonResponse({ state: 'approved', token: 'tok-123' });
    });

    const onApproved = vi.fn();
    pairing.setOnTokenApproved(onApproved);

    await pairing.startPairing();
    const state = await pairing.pollPairStatusOnce();

    expect(state).toBe('approved');
    expect(store[STORAGE_KEYS.token]).toBe('tok-123');
    expect(store[STORAGE_KEYS.serverRevision]).toMatch(/^[0-9a-f-]{36}$/);
    expect(store[STORAGE_KEYS.pairCode]).toBeNull();
    expect(onApproved).toHaveBeenCalledTimes(1);
    expect(pairing.getPairingInfo().state).toBe('approved');
    pairing.cancelPairing();
  });

  it('reports pending and expired states', async () => {
    const pairing = await loadPairing();
    fetchMock.mockReturnValue(jsonResponse({ state: 'pending' }));
    await pairing.startPairing();
    expect(await pairing.pollPairStatusOnce()).toBe('pending');

    fetchMock.mockReturnValue(jsonResponse({ state: 'expired' }));
    expect(await pairing.pollPairStatusOnce()).toBe('expired');
    expect(store[STORAGE_KEYS.pairCode]).toBeUndefined();
    pairing.cancelPairing();
  });

  it('expires a local attempt before polling if its lifetime has elapsed', async () => {
    const pairing = await loadPairing();
    fetchMock.mockReturnValue(jsonResponse({ ok: true }));
    await pairing.startPairing();
    fetchMock.mockClear();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60 * 1000);

    try {
      expect(await pairing.pollPairStatusOnce()).toBe('expired');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(store[STORAGE_KEYS.pairCode]).toBeUndefined();
    } finally {
      clock.mockRestore();
      pairing.cancelPairing();
    }
  });
});

describe('maybeAutoStartPairing', () => {
  it('does nothing without a stored server URL', async () => {
    const pairing = await loadPairing();
    delete store[STORAGE_KEYS.serverUrl];
    fetchMock.mockImplementation((url: string) =>
      String(url).includes('config.json')
        ? Promise.reject(new Error('no config.json'))
        : jsonResponse({ ok: true }));

    await pairing.maybeAutoStartPairing();
    const startPosts = fetchMock.mock.calls.filter(
      (call) => String(call[0]).includes('/pair/start'),
    );
    expect(startPosts).toHaveLength(0);
    pairing.cancelPairing();
  });

  it('does nothing when a token already exists', async () => {
    const pairing = await loadPairing();
    store[STORAGE_KEYS.token] = 'already-set';
    store[STORAGE_KEYS.tokenUrl] = 'wss://pair.example.com';

    await pairing.maybeAutoStartPairing();
    expect(fetchMock).not.toHaveBeenCalled();
    pairing.cancelPairing();
  });

  it('starts pairing when a server URL is configured and no token exists', async () => {
    const pairing = await loadPairing();
    fetchMock.mockReturnValue(jsonResponse({ ok: true }));

    await pairing.maybeAutoStartPairing();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://pair.example.com/pair/start',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(pairing.getPairingInfo().state).toBe('pending');
    pairing.cancelPairing();
  });

  it.each(['wss://pair.example.com', 'wss://other.example/ws'])('resumes approval after restart with a stored token for %s', async (tokenUrl) => {
    store[STORAGE_KEYS.token] = 'prior-token';
    store[STORAGE_KEYS.tokenUrl] = tokenUrl;
    store[STORAGE_KEYS.serverRevision] = 'rev-1';
    const beforeRestart = await loadPairing();
    fetchMock.mockReturnValue(jsonResponse({ ok: true }));
    const { otp, approveUrl } = await beforeRestart.startPairing();
    beforeRestart.cancelPairing();
    fetchMock.mockClear();
    const pairing = await loadPairing();
    fetchMock.mockReturnValue(jsonResponse({ state: 'approved', token: 'renewed-token' }));

    try {
      await pairing.maybeAutoStartPairing();
      expect(pairing.getPairingInfo()).toMatchObject({ state: 'pending', otp, approveUrl });
      expect(await pairing.pollPairStatusOnce()).toBe('approved');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        `https://pair.example.com/pair/status?otp=${otp}`,
        expect.objectContaining({ method: 'GET' }),
      );
      expect(store[STORAGE_KEYS.token]).toBe('renewed-token');
      expect(store[STORAGE_KEYS.tokenUrl]).toBe('wss://pair.example.com');
    } finally {
      pairing.cancelPairing();
    }
  });

  it('resumes a manual renewal after restart when only the compiled token exists', async () => {
    delete store[STORAGE_KEYS.serverUrl];
    fetchMock.mockImplementation((url: string) => url.endsWith('config.json')
      ? jsonResponse({}, false, 404) : jsonResponse({ state: 'approved', token: 'renewed-token' }));
    const beforeRestart = await loadPairing();
    const { getEffectiveConfig } = await import('@/config/runtime');
    expect((await getEffectiveConfig()).token).toBe('compiled-token');
    const { otp } = await beforeRestart.startPairing();
    beforeRestart.cancelPairing();
    fetchMock.mockClear();

    const pairing = await loadPairing();
    try {
      await pairing.maybeAutoStartPairing();
      expect(pairing.getPairingInfo()).toMatchObject({ state: 'pending', otp });
      expect(await pairing.pollPairStatusOnce()).toBe('approved');
      expect(fetchMock).toHaveBeenCalledWith(`https://build.example/pair/status?otp=${otp}`, expect.anything());
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/pair/start'))).toBe(false);
      expect(store[STORAGE_KEYS.token]).toBe('renewed-token');
      expect(store[STORAGE_KEYS.tokenUrl]).toBe('wss://build.example');
    } finally {
      pairing.cancelPairing();
    }
  });

  it.each([
    ['changed endpoint', { wsUrl: 'wss://other.example' }],
    ['changed revision', { serverRevision: 'old-revision' }],
    ['changed connection identity', { connectionId: 'other-identity' }],
    ['expired lifetime', { startedAt: 0 }],
  ])('drops a saved attempt with %s', async (_reason, overrides) => {
    const pairing = await loadPairing();
    store[STORAGE_KEYS.pairCode] = {
      otp: 'PENDNG23', wsUrl: 'wss://pair.example.com', serverRevision: null,
      connectionId: 'cid-1', startedAt: Date.now(), ...overrides,
    };
    await pairing.maybeAutoStartPairing();
    expect(pairing.getPairingInfo().state).toBe('idle');
    expect(store[STORAGE_KEYS.pairCode]).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears a bare legacy code without sending it to the current endpoint', async () => {
    const pairing = await loadPairing();
    store[STORAGE_KEYS.pairCode] = 'PENDNG23';
    await pairing.maybeAutoStartPairing();
    expect(pairing.getPairingInfo().state).toBe('idle');
    expect(store[STORAGE_KEYS.pairCode]).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('config.json as server source', () => {
  it('derives the pairing origin from the packaged config.json', async () => {
    const pairing = await loadPairing();
    delete store[STORAGE_KEYS.serverUrl];
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('config.json')) {
        return jsonResponse({ version: 1, wsUrl: 'wss://embedded.example.com/ws' });
      }
      if (String(url).includes('/pair/start')) return jsonResponse({ ok: true });
      return jsonResponse({ state: 'pending' });
    });

    const result = await pairing.startPairing();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://embedded.example.com/pair/start',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.approveUrl).toBe(`https://embedded.example.com/pair?otp=${result.otp}`);
    pairing.cancelPairing();
  });

  it('auto-starts pairing against the config.json origin', async () => {
    const pairing = await loadPairing();
    delete store[STORAGE_KEYS.serverUrl];
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('config.json')) {
        return jsonResponse({ version: 1, wsUrl: 'wss://embedded.example.com' });
      }
      return jsonResponse({ ok: true });
    });

    await pairing.maybeAutoStartPairing();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://embedded.example.com/pair/start',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(pairing.getPairingInfo().state).toBe('pending');
    pairing.cancelPairing();
  });
});
