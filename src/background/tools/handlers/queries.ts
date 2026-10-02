/**
 * Query tool handlers: get_text, get_attribute, is_visible, wait_for_element, highlight.
 * Every ref is resolved to the frame it lives in: reading the text of [f3:s1e42] in the
 * top document would find nothing, since refs are local to each document.
 */
import { schemas } from '../schemas';
import type { HandlerContext, HandlerMap } from './types';

export function createQueryHandlers(ctx: HandlerContext): HandlerMap {
  const { sendToContent, resolveTarget } = ctx;

  return {
    browser_get_text: async (payload) => {
      const { frameId, selector } = await resolveTarget(schemas.browser_get_text.parse(payload));
      const text = await sendToContent<string>('getText', { selector }, frameId);
      return text;
    },

    browser_get_attribute: async (payload) => {
      const { attribute, ...element } = schemas.browser_get_attribute.parse(payload);
      const { frameId, selector } = await resolveTarget(element);
      const value = await sendToContent<string | null>('getAttribute', { selector, attribute }, frameId);
      return value;
    },

    browser_is_visible: async (payload) => {
      const { frameId, selector } = await resolveTarget(schemas.browser_is_visible.parse(payload));
      const visible = await sendToContent<boolean>('isVisible', { selector }, frameId);
      return { visible };
    },

    browser_wait_for_element: async (payload) => {
      const { timeout, ...element } = schemas.browser_wait_for_element.parse(payload);
      const { frameId, selector } = await resolveTarget(element);
      const found = await sendToContent<boolean>('waitForElement', { selector, timeout }, frameId);
      return { found };
    },

    browser_highlight: async (payload) => {
      const element = schemas.browser_highlight.parse(payload);
      const { frameId, selector } = await resolveTarget(element);
      await sendToContent('highlight', { selector }, frameId);
      return { highlighted: element.ref ?? element.selector };
    },
  };
}
