import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketClient } from '../../../src/background/ws-client';
import type { IncomingMessage } from '../../../src/types/messages';

vi.mock('@/config/runtime', () => ({
  getEffectiveConfig: vi.fn(async () => ({})),
  buildWsUrl: vi.fn(() => 'ws://127.0.0.1:8765/?connectionId=wire-test'),
}));
vi.mock('@/utils/logger', () => ({ log: { info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/background/activity-log', () => ({ logConnection: vi.fn(), logError: vi.fn() }));

class ContractSocket {
  static OPEN = 1;
  static latest: ContractSocket;
  readyState = 0;
  onopen?: () => void;
  onclose?: (event: { code: number; reason: string }) => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  readonly frames: unknown[] = [];
  private frameReceived?: (frame: unknown) => void;

  constructor(_url: string) {
    ContractSocket.latest = this;
  }

  open() {
    this.readyState = ContractSocket.OPEN;
    this.onopen?.();
  }

  send(data: string) {
    const frame = JSON.parse(data);
    this.frames.push(frame);
    const receive = this.frameReceived;
    this.frameReceived = undefined;
    receive?.(frame);
  }

  receive(frame: unknown): Promise<unknown> {
    return new Promise(resolve => {
      this.frameReceived = resolve;
      this.onmessage?.({ data: JSON.stringify(frame) });
    });
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

describe('documented M1A WebSocket wire contract', () => {
  let client: WebSocketClient;

  beforeEach(async () => {
    vi.stubGlobal('WebSocket', ContractSocket);
    client = new WebSocketClient();
    const connected = client.connect();
    await Promise.resolve();
    ContractSocket.latest.open();
    await connected;
    expect(ContractSocket.latest.frames).toEqual([{ type: 'heartbeat', timestamp: expect.any(Number) }]);
  });

  afterEach(() => {
    client.disconnect();
    vi.unstubAllGlobals();
  });

  it('passes the current id/type/payload request through and serializes the correlated success reply', async () => {
    const request = { id: 'wire-success', type: 'browser_reload' as const, payload: {} };
    const handler = vi.fn(async (message: IncomingMessage) => ({
      id: message.id,
      success: true,
      result: { reloaded: true },
    }));
    client.setMessageHandler(handler);

    const reply = await ContractSocket.latest.receive(request);

    expect(handler).toHaveBeenCalledWith(request);
    expect(Object.keys(handler.mock.calls[0][0]).sort()).toEqual(['id', 'payload', 'type']);
    expect(reply).toEqual({ id: 'wire-success', success: true, result: { reloaded: true } });
  });

  it('serializes the current correlated error envelope without a result or version handshake', async () => {
    const reply = await ContractSocket.latest.receive({
      id: 'wire-error',
      type: 'browser_reload',
      payload: {},
    });

    expect(reply).toEqual({
      id: 'wire-error',
      success: false,
      error: { code: 'NO_HANDLER', message: 'No message handler configured' },
    });
  });
});
