/**
 * Query tool handlers: get_text, get_attribute, is_visible, wait_for_element, highlight.
 */
import { schemas } from '../schemas';
import type { HandlerContext, HandlerMap } from './types';

export function createQueryHandlers(ctx: HandlerContext): HandlerMap {
  const { sendToContent, getSelector } = ctx;

  return {
    browser_get_text: async (payload) => {
      const { ref } = schemas.browser_get_text.parse(payload);
      const selector = await getSelector(ref);
      const text = await sendToContent<string>('getText', { selector });
      return text;
    },

    browser_get_attribute: async (payload) => {
      const { ref, attribute } = schemas.browser_get_attribute.parse(payload);
      const selector = await getSelector(ref);
      const value = await sendToContent<string | null>('getAttribute', { selector, attribute });
      return value;
    },

    browser_is_visible: async (payload) => {
      const { ref } = schemas.browser_is_visible.parse(payload);
      const selector = await getSelector(ref);
      const visible = await sendToContent<boolean>('isVisible', { selector });
      return { visible };
    },

    browser_wait_for_element: async (payload) => {
      const { ref, timeout } = schemas.browser_wait_for_element.parse(payload);
      const selector = await getSelector(ref);
      const found = await sendToContent<boolean>('waitForElement', { selector, timeout });
      return { found };
    },

    browser_highlight: async (payload) => {
      const { ref } = schemas.browser_highlight.parse(payload);
      const selector = await getSelector(ref);
      await sendToContent('highlight', { selector });
      return { highlighted: ref };
    },
  };
}
