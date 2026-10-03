import { describe, expect, it, vi } from 'vitest';
import { createTabHandlers } from '@/background/tools/handlers/tabs';
import type { HandlerContext } from '@/background/tools/handlers/types';

/** A tab manager whose closeTab behaves like the real one: the given id, else the connected tab. */
function contextWith(connectedTabId: number) {
  const closeTab = vi.fn(async (tabId?: number) => tabId ?? connectedTabId);
  const listTabs = vi.fn(async () => [{ id: connectedTabId, url: 'https://a.example/', title: 'a', active: true, connected: true }]);
  const createTab = vi.fn(async (url: string, _connect: boolean, windowId?: number) => ({
    id: 9, url, title: '', active: false, connected: true, windowId: windowId ?? 50, windowCreated: windowId === undefined,
  }));
  const closeWindow = vi.fn(async (windowId: number, tabIds?: number[]) => ({ windowId, closed: true, closedTabIds: tabIds ?? [] }));
  const ctx = { tabManager: { closeTab, listTabs, createTab, closeWindow } } as unknown as HandlerContext;
  return { handlers: createTabHandlers(ctx), closeTab, createTab, closeWindow };
}

describe('browser_close_tab', () => {
  it('closes the tab it is given, not the connected one', async () => {
    const { handlers, closeTab } = contextWith(7);

    const answer = await handlers.browser_close_tab({ tabId: 42 });

    expect(closeTab).toHaveBeenCalledWith(42);
    expect(answer).toEqual({ closed: true, tabId: 42 });
  });

  it('closes the connected tab when no id is given, and says which', async () => {
    const { handlers, closeTab } = contextWith(7);

    const answer = await handlers.browser_close_tab({});

    expect(closeTab).toHaveBeenCalledWith(undefined);
    expect(answer).toEqual({ closed: true, tabId: 7 });
  });

  it('rejects an id that is not a number', async () => {
    const { handlers, closeTab } = contextWith(7);

    await expect(handlers.browser_close_tab({ tabId: 'all' })).rejects.toThrow();
    expect(closeTab).not.toHaveBeenCalled();
  });
});

describe('browser_list_tabs', () => {
  it('announces that this build closes tabs by id', async () => {
    const { handlers } = contextWith(7);

    const answer = (await handlers.browser_list_tabs({})) as { tabs: Array<{ id: number }>; closeById: boolean };

    expect(answer.closeById).toBe(true);
    expect(answer.tabs.map((t) => t.id)).toEqual([7]);
  });

  it('announces window-per-session and close-window', async () => {
    const { handlers } = contextWith(7);

    const answer = (await handlers.browser_list_tabs({})) as { closeWindow: boolean; windowPerSession: boolean };

    expect(answer).toMatchObject({ closeWindow: true, windowPerSession: true });
  });
});

describe('browser_new_tab', () => {
  it('without windowId opens a window and says so', async () => {
    const { handlers, createTab } = contextWith(7);

    const answer = await handlers.browser_new_tab({ url: 'https://a.example/' });

    expect(createTab).toHaveBeenCalledWith('https://a.example/', true, undefined);
    expect(answer).toMatchObject({ windowId: 50, windowCreated: true, tab: { id: 9, windowId: 50 } });
    expect(answer).not.toHaveProperty('tab.windowCreated');
  });

  it('passes the windowId of the session and ignores switchTo', async () => {
    const { handlers, createTab } = contextWith(7);

    const answer = await handlers.browser_new_tab({ url: 'https://a.example/', windowId: 30, switchTo: true });

    expect(createTab).toHaveBeenCalledWith('https://a.example/', true, 30);
    expect(answer).toMatchObject({ windowId: 30, windowCreated: false });
  });
});

describe('browser_close_window', () => {
  it('closes the window with the tabs it was given', async () => {
    const { handlers, closeWindow } = contextWith(7);

    const answer = await handlers.browser_close_window({ windowId: 30, tabIds: [5, 6] });

    expect(closeWindow).toHaveBeenCalledWith(30, [5, 6]);
    expect(answer).toEqual({ windowId: 30, closed: true, closedTabIds: [5, 6] });
  });

  it('rejects a payload without windowId', async () => {
    const { handlers, closeWindow } = contextWith(7);

    await expect(handlers.browser_close_window({ tabIds: [5] })).rejects.toThrow();
    expect(closeWindow).not.toHaveBeenCalled();
  });
});
