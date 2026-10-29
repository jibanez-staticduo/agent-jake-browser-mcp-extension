/**
 * Query tool handlers: get_text, get_attribute, is_visible, wait_for_element, highlight.
 * Every ref is resolved to the frame it lives in: reading the text of [f3:s1e42] in the
 * top document would find nothing, since refs are local to each document.
 */
import { schemas } from '../schemas';

import type { ReadSecretResult, SecretCode } from '@/content/read-secret';
import type { HandlerContext, HandlerMap } from './types';
import { parseRef } from '../utils';
import { RE2JS } from 're2js';

/** The only texts a read_secret failure may carry: never the value, never text of the page. */
export const SECRET_ERRORS: Record<SecretCode, () => string> = {
  SECRET_NO_MATCH: () => 'No element matches the selector',
  SECRET_AMBIGUOUS: () => 'Multiple elements match the selector',
  SECRET_EMPTY: () => 'The element has no text',
  SECRET_REGEX_INVALID: () => 'The regex is not valid or has no capture group',
  SECRET_REGEX_NO_MATCH: () => 'The regex did not match',
  SECRET_TOO_LARGE: () => 'The text is too large',
};

export function createQueryHandlers(ctx: HandlerContext): HandlerMap {
  const { sendToContent, resolveTarget } = ctx;

  return {
    browser_get_text: async (payload) => {
      const { frameId, selector } = await resolveTarget(schemas.browser_get_text.parse(payload));
      const text = await sendToContent<string>('getText', { selector }, frameId);
      return text;
    },

    browser_read_secret: async (payload) => {
      const fail = (code: SecretCode): never => { throw Object.assign(new Error(SECRET_ERRORS[code]()), { name: code }); };
      const parsed = schemas.browser_read_secret.safeParse(payload);
      if (!parsed.success) return fail('SECRET_NO_MATCH');
      const { regex, ref, selector } = parsed.data;
      if (regex !== undefined) {
        try {
          if (RE2JS.compile(regex).groupCount() < 1) return fail('SECRET_REGEX_INVALID');
        } catch { return fail('SECRET_REGEX_INVALID'); }
      }
      // Preserve element identity in its own frame instead of rebuilding a CSS selector.
      const { frameId, local } = ref ? parseRef(ref) : { frameId: 0, local: undefined };
      let res: ReadSecretResult;
      try {
        res = await sendToContent<ReadSecretResult>('readSecret', { ref: local, selector, regex }, frameId);
      } catch { return fail('SECRET_NO_MATCH'); }
      if (res?.ok === true && typeof res.value === 'string') {
        if (!res.value.trim()) return fail('SECRET_EMPTY');
        if (res.value.length > 4096) return fail('SECRET_TOO_LARGE');
        return { value: res.value };
      }
      if (res?.ok === false && Object.hasOwn(SECRET_ERRORS, res.code)) return fail(res.code);
      return fail('SECRET_NO_MATCH');
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
