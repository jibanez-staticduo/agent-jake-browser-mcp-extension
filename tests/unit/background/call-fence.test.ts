import { afterEach, describe, expect, it, vi } from 'vitest';
import { createToolHandlers } from '@/background/tool-handlers';
import type { TabManager } from '@/background/tab-manager';

vi.mock('@/utils/logger', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/background/activity-log', () => ({ logTool: vi.fn(), logError: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

describe('a call the gate has cut', () => {
  it('does not act when its hung step finally answers, and still lets go of what it took (16-10)', async () => {
    let answer!: (response: unknown) => void;
    // The content script of a frozen tab: the first message never answers until the test says so.
    const sendMessage = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    vi.stubGlobal('chrome', { tabs: { get: vi.fn(async () => ({ id: 1, url: 'https://mail.test/' })), sendMessage } });
    const tabManager = {
      getConnectedTabId: vi.fn(() => 1),
      startNewTabDetection: vi.fn(),
      stopNewTabDetection: vi.fn(() => null),
      sendDebuggerCommand: vi.fn(async () => ({})),
    } as unknown as TabManager;
    const cut = new AbortController();
    const call = createToolHandlers(tabManager)({ id: 'c1', type: 'browser_click', payload: { ref: '12' } }, cut.signal);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());

    cut.abort(new Error('CALL_CUT: this call no longer holds the browser'));
    answer({ success: true });

    expect(await call).toMatchObject({ success: false, error: { message: expect.stringContaining('CALL_CUT') } });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(tabManager.sendDebuggerCommand).not.toHaveBeenCalled();
    expect(tabManager.stopNewTabDetection).toHaveBeenCalledOnce();
  });

  it('runs as before while the call holds the browser', async () => {
    vi.stubGlobal('chrome', {});
    const tabManager = { switchTab: vi.fn(async () => {}), getConnectedTabId: vi.fn(() => 2) } as unknown as TabManager;
    const result = await createToolHandlers(tabManager)({ id: 's1', type: 'browser_switch_tab', payload: { tabId: 2 } });
    expect(result).toMatchObject({ id: 's1', success: true });
    expect(tabManager.switchTab).toHaveBeenCalledWith(2);
  });
});
