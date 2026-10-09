import { describe, expect, it, vi } from 'vitest';
import { createInteractionHandlers } from '@/background/tools/handlers/interaction';
import type { HandlerContext } from '@/background/tools/handlers/types';

vi.mock('@/utils/logger', () => import('../helpers/logger'));

(globalThis as { chrome?: unknown }).chrome = {
  tabs: { get: vi.fn().mockResolvedValue({ id: 7, url: 'https://login.example/' }) },
};

/**
 * `landed(text)` says how many characters of the typed text end up in the field through CDP keys;
 * the in-page fallback (setFieldText) always lands all of them. The field starts with `initial` chars.
 */
function fakeContext(opts: { initial?: number; landed: (n: number) => number; perKey?: number; fallbackApplied?: boolean }) {
  let length = opts.initial ?? 0;
  const calls: Array<{ action: string; payload?: Record<string, unknown> }> = [];
  const sendToContent = vi.fn(async (action: string, payload?: Record<string, unknown>) => {
    calls.push({ action, payload });
    if (action === 'getElementCoordinates') return { x: 10, y: 20 };
    if (action === 'fieldLength') return { length };
    if (action === 'clearField') { length = 0; return { length }; }
    if (action === 'setFieldText') {
      if (opts.fallbackApplied === false) return { applied: false, length };
      length = (payload!.kept as number) + [...(payload!.text as string)].length;
      return { applied: true, length };
    }
    return undefined;
  });
  const dispatchKeyEventTyped = vi.fn();
  const ctx = {
    sendToContent,
    resolveTarget: vi.fn(async () => ({ frameId: 0, selector: '#pw' })),
    waitForStableOrNavigation: vi.fn(async () => ({ navigated: false })),
    dispatchMouseEventTyped: vi.fn(async () => undefined),
    dispatchKeyEventTyped,
    tabManager: { getConnectedTabId: () => 7, sendDebuggerCommand: vi.fn(async () => undefined) },
  } as unknown as HandlerContext;
  // `landed` decides how many of the typed characters the page really took.
  let typed = 0;
  dispatchKeyEventTyped.mockImplementation(async (type: string) => {
    if (type !== 'char') return;
    typed += 1;
    if (typed <= opts.landed(typed)) length += opts.perKey ?? 1;
  });
  return { handlers: createInteractionHandlers(ctx), calls };
}

describe('browser_type in a tab that does not take the keys', () => {
  it('sets the value from inside the page when the keys were lost, and says so with lengths only', async () => {
    const { handlers, calls } = fakeContext({ landed: () => 0 });

    const answer = await handlers.browser_type({ selector: '#pw', text: 's3cr3t-pass', clear: true, secret: true });

    expect(calls.filter((c) => c.action === 'setFieldText')).toHaveLength(1);
    expect(answer).toEqual({ typed: '[secret]', cleared: true, fallback: 'native-setter', fieldLength: 11 });
    expect(JSON.stringify(answer)).not.toContain('s3cr3t');
  });

  it('keeps what was already in the field when appending, and repairs only the missing part', async () => {
    const { handlers, calls } = fakeContext({ initial: 3, landed: (n) => (n <= 2 ? 1 : 0) });

    const answer = await handlers.browser_type({ selector: '#f', text: 'abcd', clear: false });

    const set = calls.find((c) => c.action === 'setFieldText')!;
    expect(set.payload).toMatchObject({ kept: 3, text: 'abcd' });
    expect(answer).toMatchObject({ fallback: 'native-setter', fieldLength: 7 });
    expect(answer).not.toHaveProperty('warning');
  });

  it('does nothing extra when the keys landed', async () => {
    const { handlers, calls } = fakeContext({ landed: () => 99 });

    const answer = await handlers.browser_type({ selector: '#f', text: 'abc', clear: true });

    expect(calls.some((c) => c.action === 'setFieldText')).toBe(false);
    expect(answer).toEqual({ typed: 'abc', cleared: true });
  });

  it('warns, without guessing, when the page refuses the fallback (maxlength)', async () => {
    const { handlers } = fakeContext({ landed: () => 0, fallbackApplied: false });

    const answer = await handlers.browser_type({ selector: '#f', text: 'abcdef', clear: true });

    expect(answer).toMatchObject({ fieldLength: 0, warning: 'the field holds 0 characters after typing 6' });
    expect(answer).not.toHaveProperty('fallback');
  });

  it('does not repair a field that holds MORE than typed (a mask, a rewrite): that is not a lost key', async () => {
    const { handlers, calls } = fakeContext({ landed: () => 99, perKey: 2 }); // a mask adding a separator per key

    const answer = await handlers.browser_type({ selector: '#f', text: 'ab', clear: true });

    expect(calls.some((c) => c.action === 'setFieldText')).toBe(false);
    expect(answer).toMatchObject({ fieldLength: 4, warning: 'the field holds 4 characters after typing 2' });
  });
});
