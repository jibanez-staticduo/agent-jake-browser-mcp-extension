import { describe, expect, it, vi } from 'vitest';
import { createTabHandlers } from '@/background/tools/handlers/tabs';
import type { HandlerContext } from '@/background/tools/handlers/types';

/** A tab manager whose closeTab behaves like the real one: the given id, else the connected tab. */
function contextWith(connectedTabId: number) {
  const closeTab = vi.fn(async (tabId?: number) => tabId ?? connectedTabId);
  const listTabs = vi.fn(async () => [{ id: connectedTabId, url: 'https://a.example/', title: 'a', active: true, connected: true }]);
  const ctx = { tabManager: { closeTab, listTabs } } as unknown as HandlerContext;
  return { handlers: createTabHandlers(ctx), closeTab };
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
});

describe('browser_new_tab', () => {
  it('answers with the tab and whether its page finished loading', async () => {
    const tab = { id: 9, url: 'https://slow.example/hang', title: '', active: false, connected: true };
    const createTab = vi.fn(async () => ({ tab, loaded: false }));
    const handlers = createTabHandlers({ tabManager: { createTab } } as unknown as HandlerContext);

    const answer = await handlers.browser_new_tab({ url: 'https://slow.example/hang' });

    expect(createTab).toHaveBeenCalledWith('https://slow.example/hang', true, false, 0);
    expect(answer).toEqual({ tab, loaded: false });
  });
});

describe('browser_find_tab (INFRA-916)', () => {
  const tabs = [
    { id: 1, title: 'Búsqueda | CaixaBank', url: 'https://www.caixabank.es/empresas', active: true, connected: false },
    { id: 2, title: 'panel DGX', url: 'https://nexus.lan/panel', active: false, connected: true },
    { id: 3, title: 'Inbox', url: 'https://mail.google.com/caixabank-invoice', active: false, connected: false },
  ];
  const context = () => {
    const listTabs = vi.fn(async () => tabs);
    const connectTab = vi.fn();
    return { handlers: createTabHandlers({ tabManager: { listTabs, connectTab } } as unknown as HandlerContext), connectTab };
  };

  it('matches title or url, case-insensitive, and says how many there are', async () => {
    const { handlers, connectTab } = context();

    const answer = (await handlers.browser_find_tab({ query: 'CAIXA' })) as { total: number; tabs: Array<{ id: number }> };

    expect(answer.total).toBe(2);
    expect(answer.tabs.map((t) => t.id)).toEqual([1, 3]);
    // Looking is not driving: no tab is attached or activated.
    expect(connectTab).not.toHaveBeenCalled();
  });

  it('caps the list at `limit` (10 by default) without losing the count', async () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ id: i, title: `t${i} x`, url: 'u', active: false, connected: false }));
    const handlers = createTabHandlers({ tabManager: { listTabs: async () => many } } as unknown as HandlerContext);

    expect((await handlers.browser_find_tab({ query: 'x', limit: 3 })) as object).toMatchObject({ total: 14 });
    expect(((await handlers.browser_find_tab({ query: 'x' })) as { tabs: unknown[] }).tabs).toHaveLength(10);
  });

  it('rejects an empty query and answers total 0 when nothing matches', async () => {
    const { handlers } = context();

    await expect(handlers.browser_find_tab({ query: '' })).rejects.toThrow();
    expect(await handlers.browser_find_tab({ query: 'noexiste' })).toMatchObject({ total: 0, tabs: [] });
  });
});
