import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeServerConfig } from '@/config/runtime';

const mocks = vi.hoisted(() => ({ config: vi.fn(), log: { info: vi.fn(), debug: vi.fn(), error: vi.fn() }, activity: vi.fn() }));
vi.mock('@/config/runtime', async (original) => ({ ...await original<typeof import('@/config/runtime')>(), getEffectiveConfig: mocks.config }));
vi.mock('@/utils/logger', () => ({ log: mocks.log }));
vi.mock('@/background/activity-log', () => ({ logConnection: mocks.activity, logError: mocks.activity }));
import { WebSocketClient } from '@/background/ws-client';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(public url: string) { FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(id: string) {
    this.onmessage?.({ data: JSON.stringify({ id, type: 'browser_list_tabs', payload: {} }) });
  }
}
const cfg: RuntimeServerConfig = {
  secure: true, hostname: 'example.test', port: 443, path: '/ws', scheme: 'wss',
  token: '', connectionId: 'browser-id', source: 'config.json', fromStorage: false,
};
let client: WebSocketClient;
const fetchMock = vi.fn();
const response = (authEnabled: boolean) => ({ ok: true, json: async () => ({ authEnabled }) });
async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
beforeEach(() => {
  vi.clearAllMocks();
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('fetch', fetchMock);
  mocks.config.mockResolvedValue({ ...cfg });
  fetchMock.mockResolvedValue(response(true));
  client = new WebSocketClient();
});
afterEach(() => { client.disconnect(); vi.unstubAllGlobals(); });

describe('WebSocket connection replacement', () => {
  it('settles the first reload while the replacement handshake is pending', async () => {
    mocks.config.mockResolvedValue({ ...cfg, token: 'first-token' });
    const firstReload = client.reload();
    await settle();
    const first = FakeSocket.instances[0];

    mocks.config.mockResolvedValue({ ...cfg, hostname: 'replacement.test', token: 'second-token' });
    const secondReload = client.reload();
    await firstReload;
    await settle();

    const second = FakeSocket.instances[1];
    const secondUrl = new URL(second.url);
    expect(first.close).toHaveBeenCalledWith(1000, 'Client disconnect');
    expect(secondUrl.hostname).toBe('replacement.test');
    expect(secondUrl.searchParams.get('connectionId')).toBe('browser-id');
    expect(secondUrl.searchParams.get('token')).toBe('second-token');
    expect(client.isReconnecting()).toBe(true);
    expect(client.isConnected()).toBe(false);
    mocks.activity.mockClear();

    first.open();
    first.onerror?.();
    first.onclose?.({ code: 1006, reason: '' });
    expect(mocks.activity).not.toHaveBeenCalled();
    expect(client.isReconnecting()).toBe(true);
    expect(client.isConnected()).toBe(false);
    expect(first.send).not.toHaveBeenCalled();
    expect(second.send).not.toHaveBeenCalled();

    second.open();
    await secondReload;
    first.open();
    first.onclose?.({ code: 1006, reason: '' });
    expect(second.send).toHaveBeenCalledTimes(1);
    expect(client.isReconnecting()).toBe(false);
    expect(client.isConnected()).toBe(true);
    expect(client.getEffectiveUrl()).toBe('wss://replacement.test/ws');
  });

  it('ignores a superseded config read that finishes after the replacement connects', async () => {
    let finishConfig!: (config: RuntimeServerConfig) => void;
    mocks.config.mockReturnValueOnce(new Promise<RuntimeServerConfig>(resolve => { finishConfig = resolve; }));
    const first = client.connect();

    mocks.config.mockResolvedValue({ ...cfg, hostname: 'replacement.test', token: 'test-token' });
    const second = client.reload();
    expect(await first).toBe(false);
    await settle();
    FakeSocket.instances[0].open();
    await second;

    finishConfig(cfg);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(client.isConnected()).toBe(true);
    expect(client.getEffectiveUrl()).toBe('wss://replacement.test/ws');
  });

  it('ignores an authentication probe completed during the replacement handshake', async () => {
    let finishProbe!: (result: ReturnType<typeof response>) => void;
    fetchMock.mockReturnValueOnce(new Promise<ReturnType<typeof response>>(resolve => { finishProbe = resolve; }));
    const first = client.connect();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    mocks.config.mockResolvedValue({ ...cfg, hostname: 'replacement.test', token: 'test-token' });
    const second = client.reload();
    expect(await first).toBe(false);
    await settle();
    expect(FakeSocket.instances).toHaveLength(1);

    finishProbe(response(true));
    await settle();
    expect(client.isAwaitingToken()).toBe(false);
    expect(client.isReconnecting()).toBe(true);
    expect(client.getEffectiveUrl()).toBe('wss://replacement.test/ws');

    FakeSocket.instances[0].open();
    await second;
    expect(client.isConnected()).toBe(true);
  });
});

describe('WebSocket response routing', () => {
  it.each(['result', 'error'] as const)('discards a pending %s when the socket is replaced', async (outcome) => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const handleRequest = vi.fn(async ({ id }: { id: string }) => {
      if (id === 'original') {
        await pending;
        if (outcome === 'error') throw new Error('Original request failed');
      }
      return { id, success: true };
    });
    client.setMessageHandler(handleRequest);

    mocks.config.mockResolvedValue({ ...cfg, token: 'test-token' });
    const connecting = client.connect();
    await settle();
    const original = FakeSocket.instances[0];
    original.open();
    await connecting;
    original.send.mockClear();
    original.receive('original');
    expect(handleRequest).toHaveBeenCalledWith({ id: 'original', type: 'browser_list_tabs', payload: {} });

    mocks.config.mockResolvedValue({ ...cfg, hostname: 'replacement.test', token: 'test-token' });
    const reloading = client.reload();
    await settle();
    const replacement = FakeSocket.instances[1];
    replacement.open();
    await reloading;
    replacement.send.mockClear();

    finish();
    replacement.receive('replacement');
    await settle();

    expect(original.send).not.toHaveBeenCalled();
    expect(replacement.send.mock.calls.map(([data]) => JSON.parse(data))).toEqual([
      { id: 'replacement', success: true },
    ]);
  });
});

describe('WebSocket authentication startup', () => {
  it('waits for a token without opening or repeatedly probing the authenticated server', async () => {
    expect(await client.connect()).toBe(false);
    expect(await client.connect()).toBe(false);
    expect(FakeSocket.instances).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.test/connections');
    expect(client.isConnected()).toBe(false);
    expect(client.isAwaitingToken()).toBe(true);
    expect(client.isReconnecting()).toBe(false);
  });

  it('connects with the approved token after reload', async () => {
    await client.connect();
    mocks.config.mockResolvedValue({ ...cfg, token: 'approved-token' });
    const connecting = client.reload();
    await settle();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0].url).toContain('token=approved-token');
    FakeSocket.instances[0].open();
    await connecting;
    expect(client.isConnected()).toBe(true);
    expect(client.isAwaitingToken()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([mocks.log.info.mock.calls, mocks.activity.mock.calls])).not.toContain('approved-token');
    expect(client.getEffectiveUrl()).toBe('wss://example.test/ws');
  });

  it('connects a tokenless local server with authentication disabled', async () => {
    mocks.config.mockResolvedValue({ ...cfg, secure: false, scheme: 'ws', hostname: 'localhost', port: 8765 });
    fetchMock.mockResolvedValue(response(false));
    const connecting = client.connect();
    await settle();
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8765/connections');
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0].url).not.toContain('token=');
    FakeSocket.instances[0].open();
    expect(await connecting).toBe(true);
  });

  it('preserves the bare loopback build default whose dedicated WS port has no HTTP endpoint', async () => {
    mocks.config.mockResolvedValue({ ...cfg, source: 'build', secure: false,
      scheme: 'ws', hostname: '127.0.0.1', port: 8765, path: '' });
    const connecting = client.connect();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0].url).toBe('ws://127.0.0.1:8765?connectionId=browser-id');
    FakeSocket.instances[0].open();
    expect(await connecting).toBe(true);
  });

  it.each([
    ['manual', 'localhost'],
    ['manual', '192.168.1.5'],
    ['config.json', '127.0.0.1'],
    ['config.json', '192.168.1.5'],
  ] as const)('connects a tokenless %s dedicated WS server at %s after HTTP 426', async (source, hostname) => {
    mocks.config.mockResolvedValue({ ...cfg, source, hostname, secure: false,
      scheme: 'ws', port: 8765, fromStorage: source === 'manual' });
    fetchMock.mockResolvedValue({ ok: false, status: 426 });
    const connecting = client.connect();
    await settle();
    expect(fetchMock.mock.calls[0][0]).toBe(`http://${hostname}:8765/connections`);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0].url).not.toContain('token=');
    expect(client.isAwaitingToken()).toBe(false);
    FakeSocket.instances[0].open();
    expect(await connecting).toBe(true);
  });

  it('keeps a failed dedicated WS handshake as a connection failure', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 426 });
    const connecting = client.connect();
    const rejected = expect(connecting).rejects.toThrow('WebSocket connection failed');
    await settle();
    FakeSocket.instances[0].onerror?.();
    await rejected;
    expect(client.isAwaitingToken()).toBe(false);
    expect(client.isConnected()).toBe(false);
  });

  it('reports a configured token failure without discarding it or logging its URL', async () => {
    mocks.config.mockResolvedValue({ ...cfg, token: 'stale-secret' });
    const connecting = client.connect();
    const rejected = expect(connecting).rejects.toThrow('configured token or pair again');
    await settle();
    FakeSocket.instances[0].onerror?.();
    await rejected;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify([mocks.log.error.mock.calls, mocks.activity.mock.calls])).not.toContain('stale-secret');
  });

  it('reports failed preflight instead of treating an unreachable server as pending pairing', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await expect(client.connect()).rejects.toThrow('HTTP 503');
    expect(client.isAwaitingToken()).toBe(false);
    expect(client.isReconnecting()).toBe(false);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('does not attempt WS after a network failure in preflight', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(client.connect()).rejects.toThrow('server unavailable or invalid response');
    expect(FakeSocket.instances).toHaveLength(0);
    expect(client.isAwaitingToken()).toBe(false);
  });

  it('discards a preflight superseded by disconnect', async () => {
    let finish!: (value: unknown) => void;
    fetchMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const connecting = client.connect();
    await settle();
    client.disconnect();
    finish(response(false));
    expect(await connecting).toBe(false);
    expect(FakeSocket.instances).toHaveLength(0);
    expect(client.isReconnecting()).toBe(false);
  });
});
