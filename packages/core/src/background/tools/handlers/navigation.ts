/**
 * Navigation tool handlers: navigate, go_back, go_forward, reload.
 */
import { schemas } from '../schemas';
import type { HandlerContext, HandlerMap } from './types';

export function createNavigationHandlers(ctx: HandlerContext): HandlerMap {
  return {
    browser_navigate: async (payload) => {
      const { url } = schemas.browser_navigate.parse(payload);
      const tabId = ctx.tabManager.getConnectedTabId();

      if (!tabId) {
        throw new Error('No tab connected');
      }

      await chrome.tabs.update(tabId, { url });
      await ctx.tabManager.waitForTabLoad(tabId);

      return { navigated: url };
    },

    browser_go_back: async () => {
      await ctx.tabManager.sendDebuggerCommand('Page.navigateToHistoryEntry', {
        entryId: -1,
      });
      const tabId = ctx.tabManager.getConnectedTabId();
      if (tabId) {
        await chrome.tabs.goBack(tabId);
      }
      return { success: true };
    },

    browser_go_forward: async () => {
      const tabId = ctx.tabManager.getConnectedTabId();
      if (tabId) {
        await chrome.tabs.goForward(tabId);
      }
      return { success: true };
    },

    browser_reload: async () => {
      const tabId = ctx.tabManager.getConnectedTabId();
      if (tabId) {
        await chrome.tabs.reload(tabId);
        await ctx.tabManager.waitForTabLoad(tabId);
      }
      return { success: true };
    },
  };
}
