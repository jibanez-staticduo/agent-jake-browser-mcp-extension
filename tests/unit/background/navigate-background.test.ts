import { describe, expect, it, vi } from 'vitest';
import { createNavigationHandlers } from '@/background/tools/handlers/navigation';
import type { HandlerContext } from '@/background/tools/handlers/types';

vi.mock('@/utils/logger', () => import('../helpers/logger'));

const updated: unknown[] = [];
(globalThis as { chrome?: unknown }).chrome = {
  tabs: { update: vi.fn(async (...args: unknown[]) => { updated.push(args); }) },
};

/** A tab manager reduced to what browser_navigate reads. */
function contextWith(opts: { connected: number | null; autoAttached: boolean }) {
  const createTab = vi.fn(async (url: string) => ({
    tab: { id: 99, url, title: '', active: false, connected: true },
    loaded: true,
  }));
  const waitForNextTabLoad = vi.fn(async (_id: number, start: () => unknown) => { await start(); return true; });
  const ctx = {
    tabManager: {
      getConnectedTabId: () => opts.connected,
      isAutoAttached: () => opts.autoAttached,
      createTab,
      waitForNextTabLoad,
    },
  } as unknown as HandlerContext;
  return { handlers: createNavigationHandlers(ctx), createTab, waitForNextTabLoad };
}

describe('browser_navigate never drives the user\'s own tab', () => {
  it('with no tab connected it opens a NEW background tab, connects to it and returns its id', async () => {
    updated.length = 0;
    const { handlers, createTab, waitForNextTabLoad } = contextWith({ connected: null, autoAttached: false });

    const answer = await handlers.browser_navigate({ url: 'https://example.com/login' });

    expect(createTab).toHaveBeenCalledWith('https://example.com/login', true); // connect in a new unfocused window
    expect(waitForNextTabLoad).not.toHaveBeenCalled();
    expect(updated).toEqual([]);
    expect(answer).toEqual({ navigated: 'https://example.com/login', loaded: true, tabId: 99, openedNewTab: true });
  });

  it('on a tab bound only by auto-attach (the user\'s) it opens a new background tab and leaves that one alone', async () => {
    updated.length = 0;
    const { handlers, createTab, waitForNextTabLoad } = contextWith({ connected: 7, autoAttached: true });

    const answer = await handlers.browser_navigate({ url: 'https://example.com/' });

    expect(createTab).toHaveBeenCalledWith('https://example.com/', true);
    expect(waitForNextTabLoad).not.toHaveBeenCalled();
    expect(updated).toEqual([]); // chrome.tabs.update never touched tab 7
    expect(answer).toMatchObject({ tabId: 99, openedNewTab: true });
  });

  it('on a tab the agent opened or chose it keeps navigating in place', async () => {
    updated.length = 0;
    const { handlers, createTab, waitForNextTabLoad } = contextWith({ connected: 7, autoAttached: false });

    const answer = await handlers.browser_navigate({ url: 'https://example.com/next' });

    expect(createTab).not.toHaveBeenCalled();
    expect(waitForNextTabLoad).toHaveBeenCalledWith(7, expect.any(Function), expect.any(Number), 'load');
    expect(updated).toEqual([[7, { url: 'https://example.com/next' }]]);
    expect(answer).toEqual({ navigated: 'https://example.com/next', loaded: true });
  });
});
