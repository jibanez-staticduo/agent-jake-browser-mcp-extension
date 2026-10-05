import { describe, expect, it, vi } from 'vitest';
import { createInteractionHandlers } from '@/background/tools/handlers/interaction';
import type { HandlerContext } from '@/background/tools/handlers/types';

vi.mock('@/utils/logger', () => import('../helpers/logger'));

(globalThis as { chrome?: unknown }).chrome = {
  tabs: { get: vi.fn().mockResolvedValue({ id: 7, url: 'https://accounts.shopify.com/lookup' }) },
};

function fakeContext() {
  const runPasskeyCeremony = vi.fn(async (_mode: string, action: () => Promise<unknown>) => ({
    result: await action(),
    passkey: { mode: 'use', host: 'accounts.shopify.com', ceremony: 'completed', passkeys: [] },
  }));
  const ctx = {
    sendToContent: vi.fn(async (action: string) =>
      action === 'getElementCoordinates' ? { x: 10, y: 20 } : undefined),
    sendToAllFrames: vi.fn(),
    resolveTarget: vi.fn(async () => ({ frameId: 0, selector: '#passkey' })),
    waitForStableOrNavigation: vi.fn(async () => ({ navigated: false })),
    dispatchMouseEventTyped: vi.fn(async () => undefined),
    tabManager: {
      getConnectedTabId: () => 7,
      startNewTabDetection: vi.fn(),
      stopNewTabDetection: vi.fn(() => null),
      runPasskeyCeremony,
    },
  } as unknown as HandlerContext;
  return { ctx, runPasskeyCeremony };
}

describe('browser_passkey (INFRA-585)', () => {
  it('a plain click never touches the WebAuthn guard', async () => {
    const { ctx, runPasskeyCeremony } = fakeContext();
    const result = await createInteractionHandlers(ctx).browser_click({ ref: 'e1' });
    expect(runPasskeyCeremony).not.toHaveBeenCalled();
    expect(result).toEqual({ clicked: 'e1' });
  });

  it('browser_passkey clicks inside the ceremony and reports it', async () => {
    const { ctx, runPasskeyCeremony } = fakeContext();
    const result = await createInteractionHandlers(ctx).browser_passkey({ ref: 'e1', mode: 'use' });
    expect(runPasskeyCeremony).toHaveBeenCalledWith('use', expect.any(Function));
    expect(ctx.dispatchMouseEventTyped).toHaveBeenCalledTimes(3);
    expect(result).toEqual(expect.objectContaining({ clicked: 'e1', passkey: expect.objectContaining({ ceremony: 'completed' }) }));
  });

  it('browser_passkey needs a mode', async () => {
    const { ctx, runPasskeyCeremony } = fakeContext();
    await expect(createInteractionHandlers(ctx).browser_passkey({ ref: 'e1' })).rejects.toThrow();
    expect(runPasskeyCeremony).not.toHaveBeenCalled();
  });
});
