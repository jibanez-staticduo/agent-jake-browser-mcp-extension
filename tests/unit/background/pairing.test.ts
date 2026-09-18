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

    expect(store[STORAGE_KEYS.pairCode]).toBe(result.otp);
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
    expect(store[STORAGE_KEYS.pairCode]).toBeUndefined();
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
});

describe('maybeAutoStartPairing', () => {
  it('does nothing without a stored server URL', async () => {
    const pairing = await loadPairing();
    delete store[STORAGE_KEYS.serverUrl];

    await pairing.maybeAutoStartPairing();
    expect(fetchMock).not.toHaveBeenCalled();
    pairing.cancelPairing();
  });

  it('does nothing when a token already exists', async () => {
    const pairing = await loadPairing();
    store[STORAGE_KEYS.token] = 'already-set';

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

  it('resumes a pending pairing from storage without re-posting the OTP', async () => {
    const pairing = await loadPairing();
    store[STORAGE_KEYS.pairCode] = 'PENDING1';

    await pairing.maybeAutoStartPairing();

    expect(fetchMock).not.toHaveBeenCalled();
    const info = pairing.getPairingInfo();
    expect(info.state).toBe('pending');
    expect(info.otp).toBe('PENDING1');
    expect(info.approveUrl).toBe('https://pair.example.com/pair?otp=PENDING1');
    pairing.cancelPairing();
  });
});
