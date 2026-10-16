/**
 * Navigation tool handlers: navigate, go_back, go_forward, reload.
 */
import { TIMEOUTS } from '@/constants/timeouts';
import { schemas } from '../schemas';
import type { HandlerContext, HandlerMap } from './types';

export function createNavigationHandlers(ctx: HandlerContext): HandlerMap {
  return {
    browser_navigate: async (payload) => {
      const { url, waitUntil } = schemas.browser_navigate.parse(payload);
      const tabId = ctx.tabManager.getConnectedTabId();

      // The agent never drives the tab the user is looking at: with nothing connected, or with the
      // user's own tab bound by auto-attach, the URL opens in a NEW background tab (same path as
      // browser_new_tab, WebAuthn guard first) that becomes the connected one. A tab the agent
      // opened or chose itself keeps navigating in place.
      if (!tabId || ctx.tabManager.isAutoAttached()) {
        const { tab, loaded } = await ctx.tabManager.createTab(url, true);
        return { navigated: url, loaded, tabId: tab.id, openedNewTab: true };
      }

      // networkidle = load: the extension does not measure network idleness.
      const loaded = await ctx.tabManager.waitForNextTabLoad(
        tabId,
        () => chrome.tabs.update(tabId, { url }),
        TIMEOUTS.TAB_LOAD_WAIT,
        waitUntil === 'domcontentloaded' ? 'domcontentloaded' : 'load',
      );

      // loaded:false = the page was still loading when the wait ran out; the tab is fine.
      return { navigated: url, loaded };
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
      const loaded = tabId ? await ctx.tabManager.waitForNextTabLoad(tabId, () => chrome.tabs.reload(tabId)) : false;
      return { success: true, loaded };
    },
  };
}
