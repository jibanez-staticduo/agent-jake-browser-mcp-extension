/**
 * Interaction tool handlers: click, type, hover, press_key, snapshot.
 *
 * Everything that acts on a ref first resolves WHICH FRAME that ref lives in and sends
 * its orders to that frame. The click stays a trusted CDP event as long as the element's
 * position can be translated into top-frame coordinates (same-origin iframes); inside a
 * cross-origin iframe that translation does not exist, and rather than firing at the
 * wrong point of the page it falls back to a programmatic click inside the frame.
 */
import { withSecretLogging } from '@/utils/logger';
import type { PasskeyCeremonyOptions } from '@/background/tab-manager';
import { schemas } from '../schemas';
import type { HandlerContext, HandlerMap, Coordinates } from './types';

/** How long the reloaded document gets to bring the passkey button back (INFRA-374). */
const PASSKEY_TARGET_RELOCATE_MS = 5_000;

/** What a ref pointed at, in a form that survives a reload. */
interface PasskeyTarget {
  tag: string;
  role: string;
  text: string;
  index: number;
}

/**
 * INFRA-374, run in the page: `describe` reads the element a selector points at, `mark` finds the
 * one that matches a descriptor and tags it with a fresh data-hx the click can name. A ref belongs
 * to its document and the 1Password ceremony reloads the page, so the button has to be recognised
 * by what it is (tag, role, visible text, and which one of those it was) rather than by its ref.
 * Self-contained on purpose: it is serialized for chrome.scripting.
 */
function passkeyTargetProbe(
  mode: 'describe' | 'mark',
  arg: string | PasskeyTarget,
  mark?: string,
): PasskeyTarget | boolean {
  const selector = 'a,button,input[type="button"],input[type="submit"],input[type="image"],[role="button"]';
  const textOf = (el: Element) => ((el as HTMLInputElement).value ?? el.textContent ?? '')
    .trim().replace(/\s+/g, ' ').slice(0, 60);
  const roleOf = (el: Element) => el.getAttribute('role') || el.tagName.toLowerCase();
  const matches = (t: PasskeyTarget) => Array.from(document.querySelectorAll(selector))
    .filter((el) => el.tagName.toLowerCase() === t.tag && roleOf(el) === t.role && textOf(el) === t.text);
  if (mode === 'describe') {
    const el = document.querySelector(arg as string);
    if (!el) return false;
    const target: PasskeyTarget = {
      tag: el.tagName.toLowerCase(), role: roleOf(el), text: textOf(el), index: 0,
    };
    target.index = Math.max(0, matches(target).indexOf(el));
    return target;
  }
  const found = matches(arg as PasskeyTarget)[(arg as PasskeyTarget).index];
  if (!found) return false;
  found.setAttribute('data-hx', String(mark));
  return true;
}

export function createInteractionHandlers(ctx: HandlerContext): HandlerMap {
  const { sendToContent, sendToAllFrames, resolveTarget, waitForStableOrNavigation } = ctx;

  async function clickElement(element: { ref?: string; selector?: string }) {
    const ref = element.ref ?? element.selector;
    const tabId = await ctx.tabManager.tabId();

    const initialTab = await chrome.tabs.get(tabId);
    const initialUrl = initialTab.url || '';

    ctx.tabManager.startNewTabDetection();

    try {
      const { frameId, selector } = await resolveTarget(element);
      await sendToContent('scrollIntoView', { selector }, frameId);

      const coords = await sendToContent<Coordinates>('getElementCoordinates', {
        selector,
        clickable: true,
      }, frameId);

      let trusted = true;
      if (coords.exact === false) {
        // Cross-origin iframe: there is no way to know where it lands on the page.
        await sendToContent('dispatchClick', { selector }, frameId);
        trusted = false;
      } else {
        await ctx.dispatchMouseEventTyped('mouseMoved', coords.x, coords.y);
        await ctx.dispatchMouseEventTyped('mousePressed', coords.x, coords.y, 'left', 1);
        await ctx.dispatchMouseEventTyped('mouseReleased', coords.x, coords.y, 'left', 1);
      }

      const result = await waitForStableOrNavigation(initialUrl, frameId);

      await new Promise(resolve => setTimeout(resolve, 100));

      const newTab = ctx.tabManager.stopNewTabDetection();

      if (result.navigated) {
        return {
          clicked: ref,
          navigated: true,
          newUrl: result.newUrl,
          ...(trusted ? {} : { trusted: false }),
          ...(newTab && { newTabOpened: newTab }),
        };
      }
      return {
        clicked: ref,
        ...(trusted ? {} : { trusted: false }),
        ...(newTab && { newTabOpened: newTab }),
      };
    } catch (error) {
      ctx.tabManager.stopNewTabDetection();
      throw error;
    }
  }

  /** INFRA-374: what the ref points at right now, before the ceremony reloads the page away. */
  async function describePasskeyTarget(tabId: number, ref: string): Promise<PasskeyTarget> {
    const { frameId, selector } = await resolveTarget({ ref });
    if (frameId !== 0) {
      throw new Error('A 1Password passkey is clicked on the page itself: a ref of an iframe (fN:) is not supported');
    }
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      injectImmediately: true,
      args: ['describe', selector],
      func: passkeyTargetProbe,
    });
    if (!probe || probe.result === false) {
      throw new Error(`The button for ref ${ref} is not on the page: take a fresh browser_state and pass its ref`);
    }
    return probe.result as PasskeyTarget;
  }

  /** INFRA-374: find that same button in the reloaded document and return a selector that names it. */
  async function relocatePasskeyTarget(tabId: number, target: PasskeyTarget): Promise<string> {
    const mark = String(900000 + (Date.now() % 100000)); // clear of the refs a snapshot would give
    const deadline = Date.now() + PASSKEY_TARGET_RELOCATE_MS;
    for (;;) {
      const [probe] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        injectImmediately: true,
        args: ['mark', target, mark],
        func: passkeyTargetProbe,
      });
      if (probe?.result === true) return `[data-hx="${mark}"]`;
      if (Date.now() >= deadline) {
        throw new Error(`The "${target.text || target.tag}" button did not come back after the reload: the page is not the sign-in page anymore`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  return {
    browser_snapshot: async () => {
      const frames = await sendToAllFrames<string>('generateSnapshot');
      const { url, title } = await sendToContent<{ url: string; title: string }>('getPageInfo');

      const snapshot = frames
        .map((f) => (f.frameId === 0 ? f.data : `# frame f${f.frameId} — ${f.url}\n${f.data}`))
        .join('\n');

      return { url, title, snapshot, frames: frames.length };
    },

    browser_click: async (payload) => clickElement(schemas.browser_click.parse(payload)),

    // INFRA-585: the click starts a passkey ceremony; the WebAuthn guard is lifted for it only.
    // INFRA-374: with source "1password" the key is 1Password's and never reaches us, and the page
    // reloads before the click, so a ref has to be recognised again by what the button is.
    browser_passkey: async (payload) => {
      const { mode, source, rpIds, ...element } = schemas.browser_passkey.parse(payload);
      const options: PasskeyCeremonyOptions = { source, rpIds };
      if (source === '1password' && element.ref) {
        const tabId = await ctx.tabManager.tabId();
        const target = await describePasskeyTarget(tabId, element.ref);
        // clickElement reads the element when it runs, after the reload: pointing it at the fresh
        // data-hx is what makes the click land on the button of the new document.
        options.afterReload = async () => {
          element.ref = undefined;
          element.selector = await relocatePasskeyTarget(tabId, target);
        };
      }
      const { result, passkey } = await ctx.tabManager.runPasskeyCeremony(mode, () => clickElement(element), options);
      return { ...result, passkey };
    },

    browser_type: async (payload) => {
      const sensitive = (payload as { secret?: unknown } | undefined)?.secret === true;
      const typeText = async () => {
        const { text, clear, secret, ...element } = schemas.browser_type.parse(payload);
        // browser_fill_secret arrives flagged `secret`: the answer (and the activity log that keeps it) never echoes the text.
        const shown = (payload as { secret?: unknown } | undefined)?.secret ? '[secret]' : text;
        const tabId = await ctx.tabManager.tabId();

        const initialTab = await chrome.tabs.get(tabId);
        const initialUrl = initialTab.url || '';

        const { frameId, selector } = await resolveTarget(element);
        await sendToContent('scrollIntoView', { selector }, frameId);

        const coords = await sendToContent<Coordinates>('getElementCoordinates', { selector }, frameId);

        if (coords.exact === false) {
          // With no reliable coordinates, focus is set from inside the frame. The focus
          // itself IS real, so the keys CDP sends next still reach this input.
          await sendToContent('focusElement', { selector }, frameId);
        } else {
          // Click to focus
          await ctx.dispatchMouseEventTyped('mouseMoved', coords.x, coords.y);
          await ctx.dispatchMouseEventTyped('mousePressed', coords.x, coords.y, 'left', 1);
          await ctx.dispatchMouseEventTyped('mouseReleased', coords.x, coords.y, 'left', 1);
        }

        if (clear) {
          // A bare Control keyDown does not modify the next key over CDP: without
          // `modifiers` the "a" just types, and Backspace then eats one char
          // ("Dani" + clear + "Luis" = "DanLuis"). The editing command selects all
          // on every platform.
          await ctx.tabManager.sendDebuggerCommand('Input.dispatchKeyEvent', {
            type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2, commands: ['selectAll'],
          });
          await ctx.tabManager.sendDebuggerCommand('Input.dispatchKeyEvent', {
            type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2,
          });
          await ctx.dispatchKeyEventTyped('keyDown', 'Backspace');
          await ctx.dispatchKeyEventTyped('keyUp', 'Backspace');
          // The keys do not always land (focus moved, a re-rendered form after a rejected
          // submit): "clear" then typed onto the old value, and a 2FA field got 10 digits.
          // Whatever is left goes from inside the page, with the events a framework listens to.
          const { length } = await sendToContent<{ length: number }>('fieldLength', { selector }, frameId);
          if (length > 0) await sendToContent('clearField', { selector }, frameId);
        }

        // How much of the field survives the typing: nothing after clear, else what is there now.
        // Lengths only, from here on: the text may be a secret (browser_fill_secret goes through here).
        const typedLength = [...text].length;
        const kept = clear ? 0 : await sendToContent<{ length: number }>('fieldLength', { selector }, frameId)
          .then((r) => r.length, () => undefined);
        const secretKept = !secret || clear ? 0 : await sendToContent<{ exists: boolean; length?: number }>('getFieldLength', { selector }, frameId)
          .then((r) => r.exists && Number.isSafeInteger(r.length) && r.length! >= 0 ? r.length : undefined, () => undefined);

        for (const char of text) {
          await ctx.dispatchKeyEventTyped('keyDown', char);
          await ctx.dispatchKeyEventTyped('char', char, char);
          await ctx.dispatchKeyEventTyped('keyUp', char);
        }

        const result = await waitForStableOrNavigation(initialUrl, frameId);
        if (result.navigated) {
          return secret ? { typed: true, cleared: clear, navigated: true, verified: false } : { typed: shown, cleared: clear, navigated: true, newUrl: result.newUrl };
        }
        const measure = () => sendToContent<{ length: number }>('fieldLength', { selector }, frameId)
          .then((r) => r.length, () => undefined);
        let fieldLength = await measure();
        const expected = kept === undefined ? undefined : kept + typedLength;

        const secretResult = async () => {
          try {
            const field = await sendToContent<{ exists: boolean; length?: number }>("getFieldLength", { selector }, frameId);
            const length = field.exists && Number.isSafeInteger(field.length) && field.length! >= 0 ? field.length : undefined;
            return { typed: true, cleared: clear, navigated: false, verified: length !== undefined && secretKept !== undefined && length === secretKept + text.length, ...(length === undefined ? {} : { length }) };
          } catch {
            return { typed: true, cleared: clear, navigated: false, verified: false, warning: "FIELD_VERIFICATION_UNAVAILABLE" };
          }
        };

        // The keys do not always land (the tab is hidden and the page never took the input, a
        // focus that moved): the tool must not answer "typed" over an empty field. Set the value
        // from inside the page, with the events a framework listens to, and measure again. This
        // never activates the tab.
        // Only a SHORTFALL is repaired: a longer value is a mask or a page that rewrote it, not lost keys.
        if (expected !== undefined && fieldLength !== undefined && fieldLength < expected) {
          const set = await sendToContent<{ applied: boolean; length: number }>(
            'setFieldText', { selector, text, kept }, frameId,
          ).catch(() => undefined);
          if (set?.applied) {
            fieldLength = (await measure()) ?? set.length;
            if (secret) return { ...await secretResult(), fallback: "native-setter" };
            return fieldLength === expected
              ? { typed: shown, cleared: clear, fallback: 'native-setter', fieldLength }
              : { typed: shown, cleared: clear, fallback: 'native-setter', fieldLength, warning: `the field holds ${fieldLength} characters after typing ${typedLength}` };
          }
        }
        if (secret) return secretResult();
        if (expected !== undefined && fieldLength !== undefined && fieldLength !== expected) {
          return { typed: shown, cleared: clear, fieldLength, warning: `the field holds ${fieldLength} characters after typing ${typedLength}` };
        }
        return { typed: shown, cleared: clear };
      };
      if (!sensitive) return typeText();
      return withSecretLogging(async () => {
        try { return await typeText(); } catch { throw new Error("Secret typing failed"); }
      });
    },

    browser_hover: async (payload) => {
      const element = schemas.browser_hover.parse(payload);
      const { frameId, selector } = await resolveTarget(element);
      await sendToContent('scrollIntoView', { selector }, frameId);
      const coords = await sendToContent<Coordinates>('getElementCoordinates', { selector }, frameId);
      await ctx.dispatchMouseEventTyped('mouseMoved', coords.x, coords.y);
      return { hovered: element.ref ?? element.selector };
    },

    browser_drag: async (payload) => {
      const parsed = schemas.browser_drag.parse(payload);
      const start = await resolveTarget({ ref: parsed.startRef, selector: parsed.startSelector });
      const end = await resolveTarget({ ref: parsed.endRef, selector: parsed.endSelector });

      await sendToContent('scrollIntoView', { selector: start.selector }, start.frameId);
      await sendToContent('scrollIntoView', { selector: end.selector }, end.frameId);
      const from = await sendToContent<Coordinates>('getElementCoordinates', { selector: start.selector }, start.frameId);
      const to = await sendToContent<Coordinates>('getElementCoordinates', { selector: end.selector }, end.frameId);

      // Trusted events over CDP, same as click. The intermediate moves are the
      // point: HTML5 drag-and-drop fires dragstart/dragover/drop only when the
      // pointer actually travels between press and release.
      await ctx.dispatchMouseEventTyped('mouseMoved', from.x, from.y);
      await ctx.dispatchMouseEventTyped('mousePressed', from.x, from.y, 'left', 1);
      const STEPS = 12;
      for (let i = 1; i <= STEPS; i++) {
        await ctx.dispatchMouseEventTyped(
          'mouseMoved',
          from.x + ((to.x - from.x) * i) / STEPS,
          from.y + ((to.y - from.y) * i) / STEPS,
          'left',
          1,
        );
      }
      await ctx.dispatchMouseEventTyped('mouseReleased', to.x, to.y, 'left', 1);

      return { dragged: `${parsed.startRef ?? parsed.startSelector} -> ${parsed.endRef ?? parsed.endSelector}` };
    },

    /**
     * The server has advertised browser_select_option all along, but the extension had
     * no handler for it: the tool always answered "Unknown tool". Any form with a
     * <select> — a bank transfer, to pick one — forced a drop down to raw JS.
     */
    browser_select_option: async (payload) => {
      const { ref, selector, value, label, index } = schemas.browser_select_option.parse(payload);
      const target = await resolveTarget({ ref, selector });
      await sendToContent('scrollIntoView', { selector: target.selector }, target.frameId);
      const { selected } = await sendToContent<{ selected: string[] }>('selectOption', {
        selector: target.selector,
        value,
        label,
        index,
      }, target.frameId);
      return { selected };
    },

    browser_press_key: async (payload) => {
      const { key, ...element } = schemas.browser_press_key.parse(payload);
      const tabId = await ctx.tabManager.tabId();

      const initialTab = await chrome.tabs.get(tabId);
      const initialUrl = initialTab.url || '';

      if (element.ref || element.selector) {
        // The MCP tool takes the element to focus first; it used to be dropped here.
        const { frameId, selector } = await resolveTarget(element);
        await sendToContent('focusElement', { selector }, frameId);
      }

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
