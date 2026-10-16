import { describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/logger', async importOriginal => ({ ...await importOriginal<typeof import('@/utils/logger')>(), log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/background/activity-log', () => ({ logTool: vi.fn(), logError: vi.fn() }));

import { routeToTargetTab } from '@/background/tool-handlers';

function fakeTabs(connected: number | null, existing: number[]) {
  const state = { connected };
  return {
    state,
    getConnectedTabId: () => state.connected,
    hasTab: vi.fn(async (tabId: number) => existing.includes(tabId)),
    connectTab: vi.fn(async (tabId: number) => {
      if (!existing.includes(tabId)) throw new Error(`Tab ${tabId} does not exist`);
      state.connected = tabId;
    }),
  };
}

describe('routeToTargetTab', () => {
  // Regression: two MCP sessions on one browser shared the single connected tab, so the
  // second session's commands landed in the first session's tab.
  it('connects to the session tab before the command and strips the routing field', async () => {
    const tabs = fakeTabs(10, [10, 20]);
    const payload = await routeToTargetTab(tabs, { targetTabId: 20, selector: '#x' });
    expect(tabs.connectTab).toHaveBeenCalledWith(20);
    expect(tabs.state.connected).toBe(20);
    expect(payload).toEqual({ selector: '#x' });
  });

  it('does not reconnect when the session tab is already the connected one', async () => {
    const tabs = fakeTabs(20, [20]);
    await routeToTargetTab(tabs, { targetTabId: 20 });
    expect(tabs.connectTab).not.toHaveBeenCalled();
  });

  it('leaves commands without a target alone', async () => {
    const tabs = fakeTabs(10, [10]);
    expect(await routeToTargetTab(tabs, { url: 'https://a.test' })).toEqual({ url: 'https://a.test' });
    expect(await routeToTargetTab(tabs, undefined)).toBeUndefined();
    expect(tabs.connectTab).not.toHaveBeenCalled();
  });

  it('answers TAB_GONE without touching the connected tab when the session tab was closed', async () => {
    // Regression (architect, #23): connectTab lets go of the current tab first, so calling it for
    // a gone tab dropped the tab (and debugger) another session was using.
    const tabs = fakeTabs(10, [10]);
    await expect(routeToTargetTab(tabs, { targetTabId: 99 })).rejects.toMatchObject({ name: 'TAB_GONE' });
    expect(tabs.connectTab).not.toHaveBeenCalled();
    expect(tabs.state.connected).toBe(10);
  });

  it('passes other connection errors through unchanged', async () => {
    const tabs = fakeTabs(10, [10, 20]);
    tabs.connectTab.mockRejectedValueOnce(new Error('CDP_DEBUGGER_BUSY: Another debugger'));
    await expect(routeToTargetTab(tabs, { targetTabId: 20 })).rejects.toThrow('CDP_DEBUGGER_BUSY');
  });
});

describe('strict target routing', () => {
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '20', null, undefined])('rejects explicit invalid ID %s before tab lookup', async targetTabId => {
    const tabs = fakeTabs(10, [10, 20]);
    await expect(routeToTargetTab(tabs, { targetTabId })).rejects.toMatchObject({ name: 'INVALID_TARGET_TAB_ID' });
    expect(tabs.hasTab).not.toHaveBeenCalled();
    expect(tabs.connectTab).not.toHaveBeenCalled();
    expect(tabs.state.connected).toBe(10);
  });
  it('checks a stale connected target instead of falling back to another tab', async () => {
    const tabs = fakeTabs(20, [10]);
    await expect(routeToTargetTab(tabs, { targetTabId: 20 })).rejects.toMatchObject({ name: 'TAB_GONE' });
    expect(tabs.connectTab).not.toHaveBeenCalled();
  });
});
