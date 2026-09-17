/**
 * Shared utility functions for tool handlers.
 * Contains navigation error detection and other common helpers.
 */

import { log } from '@/utils/logger';
import { CONFIG } from '@/types/config';
import type { TabManager } from '../tab-manager';

/**
 * Check if an error is a navigation-related error (BFCache, port closed, etc).
 * These errors often occur after a successful action that triggers navigation.
 */
export function isNavigationError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return msg.includes('back/forward cache') ||
         msg.includes('message channel') ||
         msg.includes('port') ||
         msg.includes('closed') ||
         msg.includes('receiving end does not exist');
}

/**
 * Context object passed to tool handlers.
 * Contains dependencies needed for tool execution.
 */
export interface ToolContext {
  tabManager: TabManager;
  sendToContent: <T>(action: string, payload?: Record<string, unknown>) => Promise<T>;
  getSelector: (ref: string) => Promise<string>;
  waitForStable: () => Promise<void>;
  waitForStableOrNavigation: (initialUrl: string) => Promise<{ navigated: boolean; newUrl?: string }>;
  dispatchMouseEvent: (type: string, x: number, y: number, button?: string, clickCount?: number) => Promise<void>;
  dispatchKeyEvent: (type: string, keyDef: { key: string; code: string; keyCode: number }) => Promise<void>;
}

/**
 * Create tool context from a tab manager.
 * This binds all helper functions to the tab manager instance.
 */
export function createToolContext(tabManager: TabManager): ToolContext {
  /**
   * Send message to content script in connected tab.
   */
  async function sendToContent<T>(
    action: string,
    payload: Record<string, unknown> = {}
  ): Promise<T> {
    // Auto-attach: the old flow required connecting a tab by hand from the
    // popup, which makes the MCP unusable from a headless session. With no tab
    // connected, attach the ACTIVE tab of the focused window instead.
    let tabId = tabManager.getConnectedTabId();
    if (!tabId) {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!active?.id) {
        throw new Error('No active tab to attach to');
      }
      await tabManager.connectTab(active.id, active.url);
      tabId = tabManager.getConnectedTabId();
      if (!tabId) {
        throw new Error(`Could not attach to the active tab (${active.url ?? 'no url'})`);
      }
    }

    // The content script only exists in pages loaded AFTER the extension was
    // installed; messaging a pre-existing tab dies with "Receiving end does not
    // exist". Inject on demand and retry.
    let response;
    try {
      response = await chrome.tabs.sendMessage(tabId, { action, payload });
    } catch (err) {
      const msg = (err as Error).message || '';
      if (!/Receiving end does not exist|Could not establish connection/i.test(msg)) {
        throw err;
      }
      const files = chrome.runtime.getManifest().content_scripts?.[0]?.js;
      if (!files?.length) {
        throw new Error('No content script declared in the manifest');
      }
      await chrome.scripting.executeScript({ target: { tabId }, files });
      // @crxjs content scripts are a loader doing a dynamic import(): when
      // executeScript resolves, the listener is NOT registered yet. Probe it.
      let injected: unknown;
      let lastErr: Error | null = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 50));
        try {
          injected = await chrome.tabs.sendMessage(tabId, { action, payload });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e as Error;
        }
      }
      if (lastErr) throw lastErr;
      response = injected;
    }

    if (!response.success) {
      throw new Error(response.error || 'Content script error');
    }

    return response.data as T;
  }

  /**
   * Get selector for element ref.
   */
  async function getSelector(ref: string): Promise<string> {
    return sendToContent<string>('getSelector', { ref });
  }

  /**
   * Wait for DOM to stabilize after action.
   */
  async function waitForStable(): Promise<void> {
    await sendToContent('waitForDomStable', { timeout: CONFIG.DOM_STABILITY_MS });
  }

  /**
   * Try to wait for DOM stability, handling navigation gracefully.
   * Returns navigated: true if page navigated, false if stable on same page.
   */
  async function waitForStableOrNavigation(initialUrl: string): Promise<{ navigated: boolean; newUrl?: string }> {
    const tabId = tabManager.getConnectedTabId();
    if (!tabId) throw new Error('No tab connected');

    try {
      await waitForStable();
      return { navigated: false };
    } catch (error) {
      if (isNavigationError(error as Error)) {
        // Check if navigation actually occurred
        const currentTab = await chrome.tabs.get(tabId);
        if (currentTab.url !== initialUrl) {
          log.info('[waitForStableOrNavigation] Navigation detected - action succeeded');
          return { navigated: true, newUrl: currentTab.url };
        }
        // Same URL but port closed - might be page refresh or form submit
        log.warn('[waitForStableOrNavigation] Port closed but same URL - assuming success');
        return { navigated: false };
      }
      throw error;
    }
  }

  /**
   * Dispatch mouse event via CDP.
   */
  async function dispatchMouseEvent(
    type: string,
    x: number,
    y: number,
    button: string = 'left',
    clickCount: number = 1
  ): Promise<void> {
    await tabManager.sendDebuggerCommand('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button,
      clickCount,
    });
  }

  /**
   * Dispatch key event via CDP.
   */
  async function dispatchKeyEvent(
    type: string,
    keyDef: { key: string; code: string; keyCode: number }
  ): Promise<void> {
    await tabManager.sendDebuggerCommand('Input.dispatchKeyEvent', {
      type,
      key: keyDef.key,
      code: keyDef.code,
      windowsVirtualKeyCode: keyDef.keyCode,
      nativeVirtualKeyCode: keyDef.keyCode,
    });
  }

  return {
    tabManager,
    sendToContent,
    getSelector,
    waitForStable,
    waitForStableOrNavigation,
    dispatchMouseEvent,
    dispatchKeyEvent,
  };
}
