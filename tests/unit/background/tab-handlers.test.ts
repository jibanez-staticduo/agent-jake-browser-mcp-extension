import { describe, expect, it, vi } from 'vitest';
import { createTabHandlers } from '@/background/tools/handlers/tabs';
import type { HandlerContext } from '@/background/tools/handlers/types';

/** Handler stub; TabManager target selection is covered separately with the real manager. */
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

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, 'all'])(
    'rejects invalid explicit id %s before calling the manager', async (tabId) => {
      const { handlers, closeTab } = contextWith(7);

      await expect(handlers.browser_close_tab({ tabId })).rejects.toThrow();
      expect(closeTab).not.toHaveBeenCalled();
    },
  );
});

describe('browser_list_tabs', () => {
  it('announces that this build closes tabs by id', async () => {
    const { handlers } = contextWith(7);

    const answer = (await handlers.browser_list_tabs({})) as { tabs: Array<{ id: number }>; closeById: boolean };

    expect(answer.closeById).toBe(true);
    expect(answer.tabs.map((t) => t.id)).toEqual([7]);
  });
});
