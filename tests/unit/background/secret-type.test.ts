import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInteractionHandlers } from '@/background/tools/handlers/interaction';
import { createToolHandlers } from '@/background/tool-handlers';
import { schemas } from '@/background/tools/schemas';
import { log, withSecretLogging, isSecretLogging } from '@/utils/logger';
import { WebSocketClient } from '@/background/ws-client';
import { TabManager } from '@/background/tab-manager';
import { pageEvents } from '@/background/page-events';
import type { HandlerContext } from '@/background/tools/handlers/types';

const SECRET = 'FAKE-private-typing-91';
const saved: unknown[] = [];
const chromeFake = {
  runtime: { id: 'fake-extension' },
  tabs: { get: vi.fn().mockResolvedValue({ url: 'https://fake.test' }), sendMessage: vi.fn() },
  storage: { local: { get: vi.fn().mockResolvedValue({}), set: vi.fn(async (v) => { saved.push(v); }), remove: vi.fn() } },
  debugger: { getTargets: vi.fn().mockResolvedValue([{ tabId: 1, attached: true }]), sendCommand: vi.fn(),
    onEvent: { addListener: vi.fn() }, onDetach: { addListener: vi.fn() } },
};
vi.stubGlobal('chrome', chromeFake);
function context(navigated = false): HandlerContext {
  return {
    tabManager: { getConnectedTabId: () => 1, sendDebuggerCommand: vi.fn().mockResolvedValue({}) },
    resolveRef: vi.fn().mockResolvedValue({ frameId: 3, selector: '#fake' }),
    sendToContent: vi.fn(async (action) => action === 'getElementCoordinates' ? { x: 1, y: 2 } : action === 'getFieldLength' ? { exists: true, length: SECRET.length } : {}),
    waitForStableOrNavigation: vi.fn().mockResolvedValue({ navigated, newUrl: `https://fake.test/${SECRET}` }),
    dispatchMouseEventTyped: vi.fn(), dispatchKeyEventTyped: vi.fn(),
  } as unknown as HandlerContext;
}
describe('secret typing boundaries', () => {
  beforeEach(() => { vi.clearAllMocks(); saved.length = 0; });
  it('accepts selectors and preserves the secret marker in the real schema', () => {
    expect(schemas.browser_type.parse({ selector: '#fake', text: SECRET, secret: true })).toMatchObject({ selector: '#fake', secret: true });
    expect(schemas.browser_type.safeParse({ text: SECRET }).success).toBe(false);
  });
  it.each([false, true])('does not echo secret or remote navigation text (navigation=%s)', async (navigated) => {
    const result = await createInteractionHandlers(context(navigated)).browser_type({ ref: 'f3:1', text: SECRET, clear: true, secret: true });
    expect(result).toMatchObject({ typed: true, navigated });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    if (!navigated) expect(result).toMatchObject({ verified: true, length: SECRET.length });
  });
  it('routes a selector to frame zero and preserves normal typing output', async () => {
    const ctx = context();
    expect(await createInteractionHandlers(ctx).browser_type({ selector: '#fake', text: 'normal' })).toEqual({ typed: 'normal', cleared: false });
    expect(ctx.sendToContent).toHaveBeenCalledWith('scrollIntoView', { selector: '#fake' }, 0);
  });
  it.each(['missing', 'throws', 'mismatch'])('reports safe verification metadata when the field %s', async (failure) => {
    const ctx = context();
    const original = ctx.sendToContent;
    ctx.sendToContent = async (action, payload, frameId) => {
      if (action !== 'getFieldLength') return original(action, payload, frameId);
      if (failure === 'throws') throw new Error(SECRET);
      return (failure === 'missing' ? { exists: false, value: SECRET } : { exists: true, length: 1, value: SECRET }) as never;
    };
    const result = await createInteractionHandlers(ctx).browser_type({ selector: '#fake', text: SECRET, clear: true, secret: true });
    expect(result).toMatchObject({ typed: true, verified: false });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
  it('redacts warning diagnostics throughout typing and restores normal diagnostics after rejection', async () => {
    const capture = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = context();
    ctx.waitForStableOrNavigation = async () => { log.warn(SECRET, { value: SECRET }, new Error(SECRET)); throw new Error(SECRET); };
    await expect(createInteractionHandlers(ctx).browser_type({ ref: '1', text: SECRET, secret: true })).rejects.toThrow('Secret typing failed');
    expect(JSON.stringify(capture.mock.calls)).not.toContain(SECRET);
    expect(isSecretLogging()).toBe(false);
    log.warn('normal diagnostic');
    expect(capture.mock.calls.at(-1)).toContain('normal diagnostic');
    capture.mockRestore();
  });
  it('keeps overlapping secret operations redacted until both finish', async () => {
    let release!: () => void;
    const pending = withSecretLogging(() => new Promise<void>(resolve => { release = resolve; }));
    await withSecretLogging(async () => {});
    expect(isSecretLogging()).toBe(true);
    release(); await pending;
    expect(isSecretLogging()).toBe(false);
  });
  it('keeps remote CDP failure text out of retained status and actual logger output', async () => {
    const capture = vi.spyOn(console, 'error').mockImplementation(() => {});
    chromeFake.debugger.getTargets.mockResolvedValue([{ tabId: 1, attached: true }]);
    chromeFake.debugger.sendCommand.mockImplementation(async (_target, method) => {
      if (method === 'Runtime.enable') return {};
      throw new Error(SECRET);
    });
    const manager = new TabManager();
    (manager as any).connectedTabId = 1;
    await withSecretLogging(async () => {
      await expect(manager.sendDebuggerCommand('Input.dispatchKeyEvent', { key: SECRET })).rejects.toThrow(SECRET);
    });
    expect(JSON.stringify([(manager as any).lastCdpError, capture.mock.calls])).not.toContain(SECRET);
    capture.mockRestore();
  });
  it('keeps debugger event waiters functional while discarding captured secret events', async () => {
    const manager = new TabManager();
    (manager as any).connectedTabId = 1;
    (manager as any).captureEvents = true;
    pageEvents.reset();
    const waiting = manager.waitForDebuggerEvent<{ frameId: string }>('Page.fileChooserOpened', 1000);
    await withSecretLogging(async () => {
      await (manager as any).handleDebuggerEvent({ tabId: 1 }, 'Runtime.consoleAPICalled', { type: 'warning', args: [{ value: SECRET.slice(0, 5) }] });
      await (manager as any).handleDebuggerEvent({ tabId: 1 }, 'Page.fileChooserOpened', { frameId: 'frame-1' });
      await expect(waiting).resolves.toEqual({ frameId: 'frame-1' });
    });
    expect(pageEvents.consoleMessages({ all: true })).toEqual([]);
  });
  it('never returns a remote exception or logs payload through the real dispatcher', async () => {
    const capture = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tab = { getConnectedTabId: () => 1, sendDebuggerCommand: vi.fn().mockRejectedValue(new Error(SECRET)) };
    chromeFake.tabs.sendMessage.mockRejectedValue(new Error(SECRET));
    const result = await createToolHandlers(tab as never)({ id: 'fake', type: 'browser_type', payload: { ref: '1', text: SECRET, secret: true } });
    expect(result.success).toBe(false);
    expect(JSON.stringify([result, capture.mock.calls, saved])).not.toContain(SECRET);
    capture.mockRestore();
  });
  it.each(['invalid', 'gone', 'connect-error'])('redacts secret routing failures (%s)', async mode => {
    const captures = ['debug', 'info', 'warn', 'error'].map(level => vi.spyOn(console, level as 'debug').mockImplementation(() => {}));
    const tab = { getConnectedTabId: () => 1, hasTab: vi.fn(async () => mode !== 'gone'), connectTab: vi.fn(async () => {
      log.warn(SECRET); throw new Error(SECRET);
    }) };
    const result = await createToolHandlers(tab as never)({ id: 'secret-route', type: 'browser_type', payload: { targetTabId: mode === 'invalid' ? SECRET : 2, ref: '1', text: SECRET, secret: true } });
    expect(result).toMatchObject({ success: false, error: { code: 'EXECUTION_ERROR', message: 'Secret typing failed' } });
    expect(JSON.stringify([result, saved, captures.map(capture => capture.mock.calls)])).not.toContain(SECRET);
    expect(isSecretLogging()).toBe(false);
    captures.forEach(capture => capture.mockRestore());
  });
  it('redacts WebSocket send logs and secret handler rejection', async () => {
    const captures = ['debug', 'error'].map(level => vi.spyOn(console, level as 'debug').mockImplementation(() => {}));
    vi.stubGlobal('WebSocket', { OPEN: 1 });
    const socket = { readyState: 1, send: vi.fn() };
    const client = new WebSocketClient();
    (client as any).socket = socket;
    client.send({ id: 'normal', success: true, result: { text: SECRET } });
    client.setMessageHandler(async () => { throw new Error(SECRET); });
    await (client as any).handleMessage(JSON.stringify({ id: 'fake', type: 'browser_type', payload: { text: SECRET, secret: true } }));
    expect(JSON.stringify(captures.map(c => c.mock.calls))).not.toContain(SECRET);
    expect(socket.send.mock.calls[1][0]).not.toContain(SECRET);
    captures.forEach(c => c.mockRestore());
  });
});
