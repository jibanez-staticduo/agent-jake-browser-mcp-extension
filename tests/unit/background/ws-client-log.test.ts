import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CANARY, secretFlow } from '../helpers/secret-flow';

vi.mock('@/background/activity-log', () => ({ logTool: vi.fn(), logError: vi.fn(), logConnection: vi.fn() }));
vi.mock('@/config/runtime', () => ({ getEffectiveConfig: vi.fn(async () => ({})), buildWsUrl: () => 'wss://browser.test/ws' }));

import { WebSocketClient } from '@/background/ws-client';

const sockets: FakeSocket[] = [];
class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() {
    sockets.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) { this.sent.push(data); }
  close() {}
}

const consoleSpies = (['debug', 'info', 'warn', 'error', 'log'] as const).map((level) => vi.spyOn(console, level));
const everythingLogged = () => JSON.stringify(consoleSpies.map((spy) => spy.mock.calls));

let client: WebSocketClient;
beforeEach(async () => {
  sockets.length = 0;
  consoleSpies.forEach((spy) => spy.mockImplementation(() => {}));
  vi.stubGlobal('WebSocket', FakeSocket);
  client = new WebSocketClient();
  await client.connect();
});
afterEach(() => {
  client.disconnect();
  consoleSpies.forEach((spy) => spy.mockReset());
  vi.unstubAllGlobals();
});

describe('the console of the extension never holds a response body', () => {
  it('send() logs the id and the outcome of a response, not what it carries', () => {
    client.send({ id: 'r1', success: true, result: { value: CANARY } });
    expect(sockets[0].sent.join()).toContain(CANARY); // the server does get the value
    expect(everythingLogged()).not.toContain(CANARY);
    expect(everythingLogged()).toContain('r1');
  });

  it('a browser_read_secret request, answered end to end, leaves no value in any console level', async () => {
    const { handleMessage } = secretFlow({ ok: true, value: CANARY });
    client.setMessageHandler(handleMessage);
    sockets[0].onmessage?.({ data: JSON.stringify({ id: 'r2', type: 'browser_read_secret', payload: { selector: '#semilla', targetTabId: 7 } }) });
    await vi.waitFor(() => expect(sockets[0].sent.some((s) => s.includes('"r2"'))).toBe(true));

    const response = JSON.parse(sockets[0].sent.find((s) => s.includes('"r2"')) as string);
    expect(response).toEqual({ id: 'r2', success: true, result: { value: CANARY } });
    expect(everythingLogged()).not.toContain(CANARY);
  });

  it('a failed browser_read_secret request answers with the code and leaves no value either', async () => {
    const { handleMessage } = secretFlow({ ok: false, code: 'SECRET_NO_MATCH', text: CANARY });
    client.setMessageHandler(handleMessage);
    sockets[0].onmessage?.({ data: JSON.stringify({ id: 'r3', type: 'browser_read_secret', payload: { selector: '#nada', targetTabId: 7 } }) });
    await vi.waitFor(() => expect(sockets[0].sent.some((s) => s.includes('"r3"'))).toBe(true));

    const response = JSON.parse(sockets[0].sent.find((s) => s.includes('"r3"')) as string);
    expect(response.error).toEqual({ code: 'SECRET_NO_MATCH', message: 'No element matches the selector' });
    expect(everythingLogged()).not.toContain(CANARY);
  });
});
