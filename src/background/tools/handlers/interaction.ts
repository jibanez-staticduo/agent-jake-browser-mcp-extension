/**
 * Interaction tool handlers: click, type, hover, press_key, snapshot.
 */
import { schemas } from '../schemas';
import type { HandlerContext, HandlerMap, Coordinates } from './types';

export function createInteractionHandlers(ctx: HandlerContext): HandlerMap {
  const { sendToContent, getSelector, waitForStableOrNavigation } = ctx;

  return {
    browser_snapshot: async () => {
      const snapshot = await sendToContent<string>('generateSnapshot');
      const { url, title } = await sendToContent<{ url: string; title: string }>('getPageInfo');

      return { url, title, snapshot };
    },

    browser_click: async (payload) => {
      const { ref } = schemas.browser_click.parse(payload);
      const tabId = ctx.tabManager.getConnectedTabId();
      if (!tabId) throw new Error('No tab connected');

      const initialTab = await chrome.tabs.get(tabId);
      const initialUrl = initialTab.url || '';

      ctx.tabManager.startNewTabDetection();

      try {
        const selector = await getSelector(ref);
        await sendToContent('scrollIntoView', { selector });

        const coords = await sendToContent<Coordinates>('getElementCoordinates', {
          selector,
          clickable: true,
        });

        await ctx.dispatchMouseEventTyped('mouseMoved', coords.x, coords.y);
        await ctx.dispatchMouseEventTyped('mousePressed', coords.x, coords.y, 'left', 1);
        await ctx.dispatchMouseEventTyped('mouseReleased', coords.x, coords.y, 'left', 1);

        const result = await waitForStableOrNavigation(initialUrl);

        await new Promise(resolve => setTimeout(resolve, 100));

        const newTab = ctx.tabManager.stopNewTabDetection();

        if (result.navigated) {
          return {
            clicked: ref,
            navigated: true,
            newUrl: result.newUrl,
            ...(newTab && { newTabOpened: newTab }),
          };
        }
        return {
          clicked: ref,
          ...(newTab && { newTabOpened: newTab }),
        };
      } catch (error) {
        ctx.tabManager.stopNewTabDetection();
        throw error;
      }
    },

    browser_type: async (payload) => {
      const { ref, text, clear } = schemas.browser_type.parse(payload);
      const tabId = ctx.tabManager.getConnectedTabId();
      if (!tabId) throw new Error('No tab connected');

      const initialTab = await chrome.tabs.get(tabId);
      const initialUrl = initialTab.url || '';

      const selector = await getSelector(ref);
      await sendToContent('scrollIntoView', { selector });

      const coords = await sendToContent<Coordinates>('getElementCoordinates', { selector });

      // Click to focus
      await ctx.dispatchMouseEventTyped('mouseMoved', coords.x, coords.y);
      await ctx.dispatchMouseEventTyped('mousePressed', coords.x, coords.y, 'left', 1);
      await ctx.dispatchMouseEventTyped('mouseReleased', coords.x, coords.y, 'left', 1);

      if (clear) {
        await ctx.dispatchKeyEventTyped('keyDown', 'Control');
        await ctx.dispatchKeyEventTyped('keyDown', 'a');
        await ctx.dispatchKeyEventTyped('keyUp', 'a');
        await ctx.dispatchKeyEventTyped('keyUp', 'Control');
        await ctx.dispatchKeyEventTyped('keyDown', 'Backspace');
        await ctx.dispatchKeyEventTyped('keyUp', 'Backspace');
      }

      for (const char of text) {
        await ctx.dispatchKeyEventTyped('keyDown', char);
        await ctx.dispatchKeyEventTyped('char', char, char);
        await ctx.dispatchKeyEventTyped('keyUp', char);
      }

      const result = await waitForStableOrNavigation(initialUrl);
      if (result.navigated) {
        return { typed: text, cleared: clear, navigated: true, newUrl: result.newUrl };
      }
      return { typed: text, cleared: clear };
    },

    browser_hover: async (payload) => {
      const parsed = schemas.browser_hover.parse(payload);
      const ref = parsed.ref;

      const selector = await getSelector(ref);
      await sendToContent('scrollIntoView', { selector });

      const coords = await sendToContent<Coordinates>('getElementCoordinates', { selector });
      await ctx.dispatchMouseEventTyped('mouseMoved', coords.x, coords.y);

      return { hovered: ref };
    },

    /**
     * The server has advertised browser_select_option all along, but the extension had
     * no handler for it: the tool always answered "Unknown tool". Any form with a
     * <select> — a bank transfer, to pick one — forced a drop down to raw JS.
     */
    browser_select_option: async (payload) => {
      const { ref, selector, value, label, index } = schemas.browser_select_option.parse(payload);
      const targetSelector = selector ?? (await getSelector(ref!));
      await sendToContent('scrollIntoView', { selector: targetSelector });
      const { selected } = await sendToContent<{ selected: string[] }>('selectOption', {
        selector: targetSelector,
        value,
        label,
        index,
      });
      return { selected };
    },

    browser_press_key: async (payload) => {
      const { key } = schemas.browser_press_key.parse(payload);
      const tabId = ctx.tabManager.getConnectedTabId();
      if (!tabId) throw new Error('No tab connected');

      const initialTab = await chrome.tabs.get(tabId);
      const initialUrl = initialTab.url || '';

      await ctx.dispatchKeyEventTyped('keyDown', key);
      await ctx.dispatchKeyEventTyped('keyUp', key);

      const result = await waitForStableOrNavigation(initialUrl);
      if (result.navigated) {
        return { pressed: key, navigated: true, newUrl: result.newUrl };
      }
      return { pressed: key };
    },
  };
}
