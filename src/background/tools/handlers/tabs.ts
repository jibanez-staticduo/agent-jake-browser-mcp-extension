/**
 * Tab management tool handlers: new_tab, list_tabs, find_tab, switch_tab, send_to_back, close_tab.
 */
import { schemas } from '../schemas';
import type { HandlerContext, HandlerMap } from './types';

export function createTabHandlers(ctx: HandlerContext): HandlerMap {
  return {
    browser_new_tab: async (payload) => {
      const { url, windowId } = schemas.browser_new_tab.parse(payload);
      const { windowCreated, ...tab } = await ctx.tabManager.createTab(url, true, windowId);
      return { tab, windowId: tab.windowId, windowCreated };
    },

    // closeById tells the server this build closes the tab it is asked for (see browser_close_tab):
    // its tab reaper closes nothing on a browser that does not say so.
    browser_list_tabs: async () => {
      return { tabs: await ctx.tabManager.listTabs(), closeById: true, closeWindow: true, windowPerSession: true };
    },

    // Search, not drive: it names no tab and attaches none, so one caller can look at the browser
    // without moving anyone else's tab.
    browser_find_tab: async (payload) => {
      const { query, limit } = schemas.browser_find_tab.parse(payload);
      const needle = query.toLowerCase();
      const found = (await ctx.tabManager.listTabs()).filter(
        (tab) => tab.title.toLowerCase().includes(needle) || tab.url.toLowerCase().includes(needle)
      );
      return { query, total: found.length, tabs: found.slice(0, limit) };
    },

    browser_switch_tab: async (payload) => {
      const { tabId } = schemas.browser_switch_tab.parse(payload);
      await ctx.tabManager.switchTab(tabId);
      return { switched: tabId };
    },

    browser_send_to_back: async (payload) => {
      const { tabId } = schemas.browser_send_to_back.parse(payload);
      const activatedTabId = await ctx.tabManager.sendTabToBack(tabId);
      return { sentToBack: tabId ?? ctx.tabManager.getConnectedTabId(), activatedTabId };
    },

    // The server closes an idle agent tab by id (its tab reaper), so the id must be honoured:
    // ignoring it closed the connected tab instead. The answer echoes the id actually closed.
    browser_close_tab: async (payload) => {
      const { tabId } = schemas.browser_close_tab.parse(payload ?? {});
      const closed = await ctx.tabManager.closeTab(tabId);
      return { closed: true, tabId: closed };
    },
    browser_close_window: async (payload) => {
      const { windowId, tabIds } = schemas.browser_close_window.parse(payload);
      return ctx.tabManager.closeWindow(windowId, tabIds);
    },
  };
}
