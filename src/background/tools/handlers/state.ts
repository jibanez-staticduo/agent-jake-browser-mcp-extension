/**
 * DOM-first state: the default way to see a page.
 * browser_state returns interactive elements with [n] refs; browser_find
 * searches without pulling the whole state. The ARIA snapshot stays as the
 * expensive fallback.
 */
import type { HandlerContext, HandlerMap } from './types';

export function createStateHandlers(ctx: HandlerContext): HandlerMap {
  const { sendToContent } = ctx;

  return {
    browser_state: async (payload) => {
      const { max } = (payload ?? {}) as { max?: number };
      const state = await sendToContent<string>('generateState', { max });
      return { state };
    },

    browser_find: async (payload) => {
      const { text } = (payload ?? {}) as { text: string };
      if (!text) throw new Error('browser_find requires "text"');
      const matches = await sendToContent<string>('findElements', { text });
      return { matches };
    },
  };
}
