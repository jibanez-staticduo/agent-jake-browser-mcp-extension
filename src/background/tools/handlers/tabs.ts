/**
 * Tab management tool handlers: new_tab, list_tabs, switch_tab, close_tab.
 */
import { schemas } from '../schemas';
import type { HandlerContext, HandlerMap } from './types';

export function createTabHandlers(ctx: HandlerContext): HandlerMap {
  return {
    browser_new_tab: async (payload) => {
      const { url } = schemas.browser_new_tab.parse(payload);
      const tabInfo = await ctx.tabManager.createTab(url, true);
      return { tab: tabInfo };
    },

    browser_list_tabs: async () => {
      return ctx.tabManager.listTabs();
    },

    browser_switch_tab: async (payload) => {
      const { tabId } = schemas.browser_switch_tab.parse(payload);
      await ctx.tabManager.switchTab(tabId);
      return { switched: tabId };
    },

    browser_close_tab: async () => {
      await ctx.tabManager.closeTab();
      return { closed: true };
    },
  };
}
