import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCopilotTrafficGate } from '@/background/agent/bridge';
import { TIMEOUTS } from '@/constants/timeouts';
import type { TabManager } from '@/background/tab-manager';
import type { IncomingMessage, OutgoingMessage } from '@/types/messages';

vi.mock('@/utils/logger', () => ({ log: { warn: vi.fn() } }));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const mcp = (id: string, payload: Record<string, unknown> = {}, type: IncomingMessage['type'] = 'browser_type'): IncomingMessage =>
  ({ id, type, payload });

function setup(initialTab: number | null = 1) {
  // The tab in front: what a call that names none takes as its own (the user's, auto-attached).
  let activeTab = initialTab;
  vi.stubGlobal('chrome', { tabs: { query: vi.fn(async () => (activeTab === null ? [] : [{ id: activeTab, url: 'https://a.test/' }])) } });
  const tabManager = {
    connectTab: vi.fn(async (id: number) => { activeTab = id; }),
    disconnectTab: vi.fn(async (id: number) => { void id; }),
    hasTab: vi.fn(async () => true),
  } as unknown as TabManager;
  // Routes like createToolHandlers: the answer comes from the tab the call was given.
  const handler = vi.fn(async (request: IncomingMessage): Promise<OutgoingMessage> => ({
    id: request.id,
    success: true,
    result: { tabId: typeof request.payload.targetTabId === 'number' ? request.payload.targetTabId : activeTab },
  }));
  const gate = createCopilotTrafficGate(tabManager, handler);
  return { gate, handler, tabManager, setTab(id: number | null) { activeTab = id; }, getTab: () => activeTab };
}

/** The next handler call never answers until `finish`: a frozen tab. */
function hang(handler: ReturnType<typeof setup>['handler']) {
  const held: { finish?: (response: OutgoingMessage) => void; signal?: AbortSignal } = {};
  handler.mockImplementationOnce((_request, signal) => new Promise<OutgoingMessage>((resolve) => {
    held.finish = resolve;
    held.signal = signal;
  }));
  return held;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Copilot/MCP traffic gate', () => {
  it('cuts a hung call before the server does, fences it and does not run what went stale behind it', async () => {
    vi.useFakeTimers();
    const { gate, handler } = setup();
    const hung = hang(handler);
    const first = gate.handleMcp(mcp('m1', { targetTabId: 4 }));
    const second = gate.handleMcp(mcp('m2', { targetTabId: 5 }));

    await vi.advanceTimersByTimeAsync(TIMEOUTS.TOOL_CALL);
    expect(await first).toMatchObject({ id: 'm1', success: false, error: { code: 'TIMEOUT' } });
    expect(hung.signal?.aborted).toBe(true);
    expect(TIMEOUTS.TOOL_CALL).toBeLessThan(TIMEOUTS.REQUEST_TIMEOUT);
    // m2 arrived with m1 and its own deadline ran out in the queue: whoever sent it gave up.
    expect(await second).toMatchObject({ id: 'm2', success: false, error: { code: 'TIMEOUT' } });
    expect(handler).toHaveBeenCalledOnce();

    expect(await gate.handleMcp(mcp('m3', { targetTabId: 5 }))).toMatchObject({ success: true, result: { tabId: 5 } });
  });

  it('never runs two calls at once', async () => {
    const { gate, handler } = setup();
    const hung = hang(handler);
    const first = gate.handleMcp(mcp('m1', { targetTabId: 4 }));
    const second = gate.handleMcp(mcp('m2', { targetTabId: 5 }));
    await settle();
    expect(handler).toHaveBeenCalledOnce();

    hung.finish?.({ id: 'm1', success: true });
    await first;
    expect(await second).toMatchObject({ success: true, result: { tabId: 5 } });
  });

  it('lets a panel start while MCP works in another tab, and its calls wait their turn', async () => {
    const { gate, handler } = setup(1);
    const hung = hang(handler);
    const mcpCall = gate.handleMcp(mcp('m1', { targetTabId: 1 }));
    await settle();

    const lease = gate.acquire(2);
    expect(lease).not.toBeNull();
    const state = lease!.exec('browser_state', { max: 10 });
    await settle();
    expect(handler).toHaveBeenCalledOnce();

    hung.finish?.({ id: 'm1', success: true });
    await mcpCall;
    expect(await state).toMatchObject({ success: true, result: { tabId: 2 } });
    expect(handler).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'browser_state', payload: { max: 10, targetTabId: 2 } }), expect.any(AbortSignal));
  });

  it("keeps MCP out of the copilot's tab, and only out of that one", async () => {
    const { gate, setTab } = setup(1);
    const lease = gate.acquire(2)!;
    await lease.exec('browser_state', {});

    expect(await gate.handleMcp(mcp('m1', { targetTabId: 2 }))).toMatchObject({ success: false, error: { code: 'COPILOT_BUSY' } });
    expect(await gate.handleMcp(mcp('m2', { targetTabId: 3 }))).toMatchObject({ success: true, result: { tabId: 3 } });
    // Without a target MCP takes the tab in front: fine while that is not the copilot's.
    setTab(3);
    expect(await gate.handleMcp(mcp('m3'))).toMatchObject({ success: true, result: { tabId: 3 } });
    setTab(2);
    expect(await gate.handleMcp(mcp('m4'))).toMatchObject({ error: { code: 'COPILOT_BUSY' } });
    // No tab in front: the call opens or binds one of its own, so no panel is in its way.
    setTab(null);
    expect(await gate.handleMcp(mcp('m5'))).toMatchObject({ success: true });
    expect(await gate.handleMcp(mcp('m6', { tabId: 2 }, 'browser_close_tab'))).toMatchObject({ error: { code: 'COPILOT_BUSY' } });
    expect(await gate.handleMcp(mcp('m7', { url: 'https://a.test/' }, 'browser_new_tab'))).toMatchObject({ success: true });

    await lease.release();
    expect(await gate.handleMcp(mcp('m8', { targetTabId: 2 }))).toMatchObject({ success: true, result: { tabId: 2 } });
  });

  it('gives each panel a tab of its own', () => {
    const { gate } = setup();
    expect(gate.acquire(2)).not.toBeNull();
    expect(gate.acquire(2)).toBeNull();
    expect(gate.acquire(3)).not.toBeNull();
  });

  it('follows the copilot to the tab it switches to or opens, never into another panel', async () => {
    const { gate, handler } = setup();
    const lease = gate.acquire(2)!;
    gate.acquire(9);

    expect(await lease.exec('browser_switch_tab', { tabId: 9 })).toMatchObject({ error: { code: 'COPILOT_BUSY' } });
    expect(await lease.exec('browser_switch_tab', { tabId: 7 })).toMatchObject({ success: true });
    expect(lease.tabId()).toBe(7);
    expect(await gate.handleMcp(mcp('m1', { targetTabId: 2 }))).toMatchObject({ success: true });
    expect(await gate.handleMcp(mcp('m2', { targetTabId: 7 }))).toMatchObject({ error: { code: 'COPILOT_BUSY' } });

    handler.mockResolvedValueOnce({ id: 'n', success: true, result: { tab: { id: 8 }, loaded: true } });
    await lease.exec('browser_new_tab', { url: 'https://b.test/' });
    expect(handler).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'browser_new_tab', payload: { url: 'https://b.test/' } }), expect.any(AbortSignal));
    expect(lease.tabId()).toBe(8);
  });

  it('releasing a panel lets go of its own tab and of nothing else', async () => {
    // INFRA-907: with a debugger per tab there is no "the browser's tab" to give back. Releasing
    // frees the tab this panel used; MCP keeps whatever else it was driving.
    const { gate, tabManager } = setup(1);
    const lease = gate.acquire(2)!;
    await gate.handleMcp(mcp('m1', { targetTabId: 3 }));
    await lease.exec('browser_state', {});
    await lease.release();
    expect(tabManager.disconnectTab).toHaveBeenCalledWith(2);
    expect(tabManager.connectTab).not.toHaveBeenCalledWith(3);
    await lease.release();
    expect(tabManager.disconnectTab).toHaveBeenCalledOnce();
    expect(await gate.handleMcp(mcp('m2', { targetTabId: 2 }))).toMatchObject({ success: true });

    const broken = setup(1);
    const brokenLease = broken.gate.acquire(2)!;
    await brokenLease.exec('browser_state', {});
    vi.mocked(broken.tabManager.disconnectTab).mockRejectedValueOnce(new Error('tab closed'));
    await expect(brokenLease.release()).rejects.toThrow('tab closed');
    expect(broken.gate.acquire(2)).not.toBeNull();
  });

  it('lets the deploy reload and a bounded wait straight through a busy queue', async () => {
    const { gate, handler } = setup();
    const lease = gate.acquire(1)!;
    const hung = hang(handler);
    const click = lease.exec('browser_click', { ref: '1' });
    await settle();

    const reload = mcp('r1', {}, 'browser_reload_extension');
    expect(await gate.handleMcp(reload)).toMatchObject({ id: 'r1', success: true });
    expect(handler).toHaveBeenLastCalledWith(reload);
    expect(await gate.handleMcp(mcp('w1', { time: 0 }, 'browser_wait'))).toMatchObject({ success: true });
    // The copilot's wait does not take its tab either: it would switch it under the call in the queue.
    expect(await lease.exec('browser_wait', { time: 0 })).toMatchObject({ success: true });
    expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'browser_wait', payload: { time: 0 } }));

    hung.finish?.({ id: 'c', success: true });
    await click;
    await lease.release();
    expect(await lease.exec('browser_state', {})).toMatchObject({ success: false, error: { code: 'COPILOT_STOPPED' } });
  });
});
