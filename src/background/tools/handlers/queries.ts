/**
 * Query tool handlers: get_text, get_attribute, is_visible, wait_for_element, highlight.
 * Every ref is resolved to the frame it lives in: reading the text of [f3:s1e42] in the
 * top document would find nothing, since refs are local to each document.
 */
import { schemas } from '../schemas';
import type { HandlerContext, HandlerMap } from './types';

export function createQueryHandlers(ctx: HandlerContext): HandlerMap {
  const { sendToContent, resolveRef } = ctx;

  return {
    browser_get_text: async (payload) => {
      const { ref } = schemas.browser_get_text.parse(payload);
      const { frameId, selector } = await resolveRef(ref);
      const text = await sendToContent<string>('getText', { selector }, frameId);
      return text;
    },

    browser_get_attribute: async (payload) => {
      const { ref, attribute } = schemas.browser_get_attribute.parse(payload);
      const { frameId, selector } = await resolveRef(ref);
      const value = await sendToContent<string | null>('getAttribute', { selector, attribute }, frameId);
      return value;
    },

    browser_is_visible: async (payload) => {
      const { ref } = schemas.browser_is_visible.parse(payload);
      const { frameId, selector } = await resolveRef(ref);
      const visible = await sendToContent<boolean>('isVisible', { selector }, frameId);
      return { visible };
    },

    browser_wait_for_element: async (payload) => {
      const { ref, timeout } = schemas.browser_wait_for_element.parse(payload);
      const { frameId, selector } = await resolveRef(ref);
      const found = await sendToContent<boolean>('waitForElement', { selector, timeout }, frameId);
      return { found };
    },

    browser_highlight: async (payload) => {
      const { ref } = schemas.browser_highlight.parse(payload);
      const { frameId, selector } = await resolveRef(ref);
      await sendToContent('highlight', { selector }, frameId);
      return { highlighted: ref };
    },
  };
}
