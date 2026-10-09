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
  onmessage = null;
  send = vi.fn();
  close = vi.fn();
  constructor(public url: string) { FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
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
