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
  sendToContent: <T>(action: string, payload?: Record<string, unknown>, frameId?: number) => Promise<T>;
  sendToAllFrames: <T>(action: string, payload?: Record<string, unknown>) => Promise<FrameResult<T>[]>;
  getSelector: (ref: string) => Promise<string>;
  resolveRef: (ref: string | number) => Promise<{ frameId: number; selector: string }>;
  waitForStable: (frameId?: number) => Promise<void>;
  waitForStableOrNavigation: (initialUrl: string, frameId?: number) => Promise<{ navigated: boolean; newUrl?: string }>;
  dispatchMouseEvent: (type: string, x: number, y: number, button?: string, clickCount?: number) => Promise<void>;
  dispatchKeyEvent: (type: string, keyDef: { key: string; code: string; keyCode: number }) => Promise<void>;
}

/** One frame of the tab and whatever its content script answered. */
export interface FrameResult<T> {
  frameId: number;
  url: string;
  data: T;
}

/** Frame tag carried by refs: the top frame carries none. */
export function frameTag(frameId: number): string | undefined {
  return frameId ? `f${frameId}` : undefined;
}

/**
 * Split a ref into the frame it belongs to and that frame's own local ref.
 * "f3:12" -> { frameId: 3, local: "12" } · "12" or "s1e42" -> top frame.
 * Plain refs keep working: no tag means frame 0.
 */
export function parseRef(ref: string | number): { frameId: number; local: string } {
  const raw = String(ref).trim();
  const m = raw.match(/^f(\d+):(.+)$/);
  if (m) return { frameId: Number(m[1]), local: m[2] };
  return { frameId: 0, local: raw };
}

/**
 * Create tool context from a tab manager.
 * This binds all helper functions to the tab manager instance.
 */
export function createToolContext(tabManager: TabManager): ToolContext {
  /**
   * Connected tab, or a clear error if the popup has not connected one.
   */
  function requireTabId(): number {
    const tabId = tabManager.getConnectedTabId();
    if (!tabId) {
      throw new Error('No tab connected. Use the popup to connect a tab first.');
    }
    return tabId;
  }

  /**
   * Frames of the tab where a content script can live, top frame first.
   * Anything that is not http(s)/file is dropped (about:blank, chrome-extension://,
   * data:): no content script runs there and the message would only burn a retry.
   */
  async function listFrames(tabId: number): Promise<Array<{ frameId: number; url: string }>> {
    let frames: chrome.webNavigation.GetAllFrameResultDetails[] | null | undefined;
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId });
    } catch {
      frames = null;
    }
    if (!frames?.length) return [{ frameId: 0, url: '' }];

    return frames
      .filter((f) => !f.errorOccurred && /^(https?|file):/i.test(f.url))
      .sort((a, b) => a.frameId - b.frameId)
      .map((f) => ({ frameId: f.frameId, url: f.url }));
  }

  /**
   * Send an action to the content script of ONE given frame.
   *
   * The frameId is mandatory in practice: with `all_frames: true` in the manifest,
   * chrome.tabs.sendMessage WITHOUT options reaches every frame and resolves with
   * whichever answers first — non-deterministic. Hence the default of 0 (top frame).
   */
  async function sendToContent<T>(
    action: string,
    payload: Record<string, unknown> = {},
    frameId: number = 0
  ): Promise<T> {
    const tabId = requireTabId();

    const response = await chrome.tabs.sendMessage(tabId, { action, payload }, { frameId });

    if (!response.success) {
      throw new Error(response.error || 'Content script error');
    }

    return response.data as T;
  }

  /**
   * The same action in EVERY frame of the tab, in parallel.
   *
   * Each frame is handed its own tag (`frame: "f3"`) so the refs it emits already read
   * [f3:12] and the action knows which frame to go back to. A frame that does not answer
   * (sandboxed, cross-origin with no content script, just gone) is skipped silently: a
   * third-party ad staying quiet is no reason to lose the state of the whole page.
   */
  async function sendToAllFrames<T>(
    action: string,
    payload: Record<string, unknown> = {}
  ): Promise<FrameResult<T>[]> {
    const tabId = requireTabId();
    const frames = await listFrames(tabId);

    const settled = await Promise.all(
      frames.map(async (f): Promise<FrameResult<T> | null> => {
        try {
          const data = (await sendToContent<T>(
            action,
            { ...payload, frame: frameTag(f.frameId) },
            f.frameId
          )) as T;
          return { frameId: f.frameId, url: f.url, data };
        } catch (e) {
          log.debug(`[sendToAllFrames] ${action} got no answer from frame ${f.frameId} (${f.url}): ${(e as Error).message}`);
          return null;
        }
      })
    );

    return settled.filter((r): r is FrameResult<T> => r !== null);
  }

  /**
   * Resolve a ref to the frame it lives in and to a CSS selector inside THAT frame.
   *
   * Two ref families coexist on purpose:
   *  - ARIA        "s1e42"   -> accessibility snapshot, per document
   *  - framed      "f3:s1e42" -> the same ref inside iframe 3
   * Both are local to their document, which is exactly why the tag is needed.
   */
  async function resolveRef(ref: string | number): Promise<{ frameId: number; selector: string }> {
    const { frameId, local } = parseRef(ref);
    if (/^\d+$/.test(local)) {
      return { frameId, selector: `[data-hx="${local}"]` };
    }
    return { frameId, selector: await sendToContent<string>('getSelector', { ref: local }, frameId) };
  }

  /**
   * CSS selector for a ref. It drops the frame, so it is only good for the top frame:
   * anything that will actually act on the element must go through resolveRef.
   */
  async function getSelector(ref: string): Promise<string> {
<<<<<<< HEAD
    return (await resolveRef(ref)).selector;
=======
    // Two ref families on purpose:
    //  - compact  "12"     -> from the DOM-first state (data-hx), resolved without a round trip
    //  - ARIA     "s1e42"  -> from the accessibility snapshot (fallback)
    if (/^\d+$/.test(String(ref).trim())) {
      return `[data-hx="${String(ref).trim()}"]`;
    }
    return sendToContent<string>('getSelector', { ref });
>>>>>>> prtest/5
  }

  /**
   * Wait for DOM to stabilize after action.
   */
  async function waitForStable(frameId: number = 0): Promise<void> {
    await sendToContent('waitForDomStable', { timeout: CONFIG.DOM_STABILITY_MS }, frameId);
  }

  /**
   * Try to wait for DOM stability, handling navigation gracefully.
   * Returns navigated: true if page navigated, false if stable on same page.
   */
  async function waitForStableOrNavigation(initialUrl: string, frameId: number = 0): Promise<{ navigated: boolean; newUrl?: string }> {
    const tabId = tabManager.getConnectedTabId();
    if (!tabId) throw new Error('No tab connected');

    try {
      // After acting inside an iframe the mutations happen in THAT frame: watching the
      // top document alone would call a page settled while it is still changing.
      await waitForStable(frameId);
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
    sendToAllFrames,
    getSelector,
    resolveRef,
    waitForStable,
    waitForStableOrNavigation,
    dispatchMouseEvent,
    dispatchKeyEvent,
  };
}
