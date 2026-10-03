import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schemas } from '@/background/tools/schemas';
import { createInteractionHandlers } from '@/background/tools/handlers/interaction';
import { createQueryHandlers } from '@/background/tools/handlers/queries';
import type { HandlerContext } from '@/background/tools/handlers/types';

(globalThis as { chrome?: unknown }).chrome = {
  tabs: { get: vi.fn().mockResolvedValue({ id: 1, url: 'https://example.com/' }) },
};

const ELEMENT_TOOLS = [
  'browser_click', 'browser_hover', 'browser_get_text', 'browser_is_visible', 'browser_highlight',
] as const;

describe('element tools take a ref or a selector', () => {
  // Regression: the MCP server advertises `selector` for these tools, but the extension
  // required `ref` and answered a selector-only call with a zod "expected string" error.
  it.each(ELEMENT_TOOLS)('%s accepts selector alone and rejects neither', (tool) => {
    expect(schemas[tool].safeParse({ selector: '#login_field' }).success).toBe(true);
    expect(schemas[tool].safeParse({ ref: 's1e4' }).success).toBe(true);
    expect(schemas[tool].safeParse({}).success).toBe(false);
  });

  it('browser_type, get_attribute and wait_for_element too', () => {
    expect(schemas.browser_type.safeParse({ selector: '#otp', text: '123456' }).success).toBe(true);
    expect(schemas.browser_type.safeParse({ text: '123456' }).success).toBe(false);
    expect(schemas.browser_get_attribute.safeParse({ selector: 'a', attribute: 'href' }).success).toBe(true);
    expect(schemas.browser_wait_for_element.safeParse({ selector: '#x' }).success).toBe(true);
  });
});

function fakeContext(content: Record<string, (payload: Record<string, unknown>) => unknown>) {
  const calls: Array<[string, Record<string, unknown> | undefined, number | undefined]> = [];
  const keys: string[] = [];
  const ctx = {
    tabManager: {
      getConnectedTabId: () => 1,
      startNewTabDetection: vi.fn(),
      stopNewTabDetection: vi.fn(() => null),
      sendDebuggerCommand: vi.fn().mockResolvedValue({}),
    },
    sendToContent: vi.fn(async (action: string, payload?: Record<string, unknown>, frameId?: number) => {
      calls.push([action, payload, frameId]);
      return content[action]?.(payload ?? {}) ?? {};
    }),
    sendToAllFrames: vi.fn(),
    getSelector: vi.fn(),
    resolveRef: vi.fn(async (ref: string) => ({ frameId: 3, selector: `[ref=${ref}]` })),
    resolveTarget: vi.fn(async (t: { ref?: string; selector?: string }) =>
      t.ref ? { frameId: 3, selector: `[ref=${t.ref}]` } : { frameId: 0, selector: t.selector! }),
    waitForStable: vi.fn(),
    waitForStableOrNavigation: vi.fn().mockResolvedValue({ navigated: false }),
    dispatchMouseEvent: vi.fn(),
    dispatchKeyEvent: vi.fn(),
    dispatchMouseEventTyped: vi.fn(),
    dispatchKeyEventTyped: vi.fn(async (type: string, key: string) => { if (type === 'keyDown') keys.push(key); }),
  } as unknown as HandlerContext;
  return { ctx, calls, keys };
}

describe('handlers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('browser_click with only a selector acts on that selector in the top frame', async () => {
    const { ctx, calls } = fakeContext({ getElementCoordinates: () => ({ x: 5, y: 5 }) });
    const result = await createInteractionHandlers(ctx).browser_click({ selector: '#go' });
    expect(calls[0]).toEqual(['scrollIntoView', { selector: '#go' }, 0]);
    expect(result).toMatchObject({ clicked: '#go' });
  });

  it('browser_type with clear empties from inside the page when the keys left something behind', async () => {
    // Regression: retyping a 2FA code after a rejected submit left 10 digits in the field.
    let length = 4;
    const { ctx, calls } = fakeContext({
      getElementCoordinates: () => ({ x: 5, y: 5 }),
      fieldLength: () => ({ length }),
      clearField: () => { length = 0; return { length }; },
    });
    const handlers = createInteractionHandlers(ctx);
    const typing = handlers.browser_type({ selector: '#otp', text: '123456', clear: true });
    const result = await typing;
    const actions = calls.map(([a]) => a);
    expect(actions.indexOf('clearField')).toBeGreaterThan(actions.indexOf('fieldLength'));
    // the fake field never receives the keys, so the length check after typing reports it
    expect(result).toMatchObject({ cleared: true, fieldLength: 0, warning: 'the field holds 0 characters after typing 6' });
  });

  it('browser_type does not clear from the page when the keys already emptied the field', async () => {
    const { ctx, calls } = fakeContext({
      getElementCoordinates: () => ({ x: 5, y: 5 }),
      fieldLength: () => ({ length: 0 }),
    });
    await createInteractionHandlers(ctx).browser_type({ selector: '#otp', text: '', clear: true });
    expect(calls.map(([a]) => a)).not.toContain('clearField');
  });

  it('browser_press_key focuses the element it is given before the key', async () => {
    const { ctx, calls, keys } = fakeContext({});
    await createInteractionHandlers(ctx).browser_press_key({ key: 'Enter', selector: '#q' });
    expect(calls[0]).toEqual(['focusElement', { selector: '#q' }, 0]);
    expect(keys).toEqual(['Enter']);
  });

  it('query tools resolve a selector too', async () => {
    const { ctx, calls } = fakeContext({ getText: () => 'hola' });
    await expect(createQueryHandlers(ctx).browser_get_text({ selector: 'h1' })).resolves.toBe('hola');
    expect(calls[0]).toEqual(['getText', { selector: 'h1' }, 0]);
  });
});
