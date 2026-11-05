import { describe, expect, it, vi } from 'vitest';
import { createInteractionHandlers, passkeyTargetProbe } from '@/background/tools/handlers/interaction';
import type { HandlerContext } from '@/background/tools/handlers/types';

vi.mock('@/utils/logger', () => import('../helpers/logger'));

/** What the page answers to passkeyTargetProbe: the describe of the button, and the mark of the new one. */
const described = { tag: 'button', role: 'button', text: 'Continue', index: 0 };

(globalThis as { chrome?: unknown }).chrome = {
  tabs: { get: vi.fn().mockResolvedValue({ id: 7, url: 'https://accounts.shopify.com/lookup' }) },
  scripting: {
    executeScript: vi.fn(async ({ args }: { args: unknown[] }) =>
      [{ result: args[0] === 'describe' ? described : true }]),
  },
};

function fakeContext(resolveTarget = vi.fn(async () => ({ frameId: 0, selector: '#passkey' }))) {
  const runPasskeyCeremony = vi.fn(async (
    _mode: string,
    action: () => Promise<unknown>,
    options?: { afterReload?: () => Promise<void> },
  ) => {
    // The real ceremony reloads the page between these two: the ref of the old document is gone.
    await options?.afterReload?.();
    return {
      result: await action(),
      passkey: { mode: 'use', host: 'accounts.shopify.com', ceremony: 'completed', passkeys: [] },
    };
  });
  const ctx = {
    sendToContent: vi.fn(async (action: string) =>
      action === 'getElementCoordinates' ? { x: 10, y: 20 } : undefined),
    sendToAllFrames: vi.fn(),
    resolveTarget,
    waitForStableOrNavigation: vi.fn(async () => ({ navigated: false })),
    dispatchMouseEventTyped: vi.fn(async () => undefined),
    tabManager: {
      tabId: () => Promise.resolve(7),
      startNewTabDetection: vi.fn(),
      stopNewTabDetection: vi.fn(() => null),
      runPasskeyCeremony,
    },
  } as unknown as HandlerContext;
  return { ctx, runPasskeyCeremony, resolveTarget };
}

describe('browser_passkey (INFRA-585)', () => {
  it('describes BUTTON text from textContent rather than an absent input value', () => {
    const button = { tagName: 'BUTTON', textContent: 'Continue', getAttribute: () => null };
    vi.stubGlobal('document', { querySelector: () => button, querySelectorAll: () => [button] });
    expect(passkeyTargetProbe('describe', '#passkey')).toMatchObject({ tag: 'button', text: 'Continue' });
    vi.unstubAllGlobals();
  });
  it('a plain click never touches the WebAuthn guard', async () => {
    const { ctx, runPasskeyCeremony } = fakeContext();
    const result = await createInteractionHandlers(ctx).browser_click({ ref: 'e1' });
    expect(runPasskeyCeremony).not.toHaveBeenCalled();
    expect(result).toEqual({ clicked: 'e1' });
  });

  it('browser_passkey clicks inside the ceremony and reports it', async () => {
    const { ctx, runPasskeyCeremony } = fakeContext();
    const result = await createInteractionHandlers(ctx).browser_passkey({ ref: 'e1', mode: 'use' });
    expect(runPasskeyCeremony).toHaveBeenCalledWith('use', expect.any(Function), { source: 'agent', rpIds: [] });
    expect(ctx.dispatchMouseEventTyped).toHaveBeenCalledTimes(3);
    expect(result).toEqual(expect.objectContaining({ clicked: 'e1', passkey: expect.objectContaining({ ceremony: 'completed' }) }));
  });

  // INFRA-374: the rpIds are the server's, never the agent's choice; the ceremony decides with them.
  it('forwards source "1password" with the rpIds the server sent', async () => {
    const { ctx, runPasskeyCeremony } = fakeContext();
    await createInteractionHandlers(ctx).browser_passkey({ ref: 'e1', mode: 'use', source: '1password', rpIds: ['google.com'] });
    expect(runPasskeyCeremony).toHaveBeenCalledWith('use', expect.any(Function),
      expect.objectContaining({ source: '1password', rpIds: ['google.com'] }));
  });

  it('a ref is found again after the reload and the click lands on the new element', async () => {
    const { ctx, resolveTarget } = fakeContext(vi.fn(async () => ({ frameId: 0, selector: '[data-hx="12"]' })));
    const result = await createInteractionHandlers(ctx).browser_passkey({
      ref: '12', mode: 'use', source: '1password', rpIds: ['google.com'],
    });

    const asked = resolveTarget.mock.calls.map((c) => c[0]);
    expect(asked[0]).toEqual({ ref: '12' }); // described before the page goes away
    expect(asked.at(-1)!.selector).toMatch(/^\[data-hx="9\d{5}"]$/); // clicked after it comes back
    expect(result).toEqual(expect.objectContaining({ clicked: expect.stringMatching(/^\[data-hx="9\d{5}"]$/) }));
  });

  it('a ref of an iframe is refused before the ceremony starts', async () => {
    const { ctx, runPasskeyCeremony } = fakeContext(vi.fn(async () => ({ frameId: 3, selector: '[data-hx="12"]' })));
    await expect(createInteractionHandlers(ctx).browser_passkey({
      ref: 'f3:12', mode: 'use', source: '1password', rpIds: ['google.com'],
    })).rejects.toThrow('a ref of an iframe (fN:) is not supported');
    expect(runPasskeyCeremony).not.toHaveBeenCalled();
  });

  it('a CSS selector is used as it is: nothing to recognise again', async () => {
    const { ctx, runPasskeyCeremony } = fakeContext();
    await createInteractionHandlers(ctx).browser_passkey({
      selector: '#continue', mode: 'use', source: '1password', rpIds: ['google.com'],
    });
    const options = runPasskeyCeremony.mock.calls[0][2] as { afterReload?: unknown };
    expect(options.afterReload).toBeUndefined();
  });

  it('browser_passkey needs a mode', async () => {
    const { ctx, runPasskeyCeremony } = fakeContext();
    await expect(createInteractionHandlers(ctx).browser_passkey({ ref: 'e1' })).rejects.toThrow();
    expect(runPasskeyCeremony).not.toHaveBeenCalled();
  });
});
