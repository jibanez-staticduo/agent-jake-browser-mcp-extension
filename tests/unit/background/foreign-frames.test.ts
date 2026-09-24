import { describe, expect, it, vi } from 'vitest';

const executeScript = vi.fn();
(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: { id: 'ownextensionid' },
  scripting: { executeScript },
  storage: { local: { get: vi.fn().mockResolvedValue({}), set: vi.fn(), remove: vi.fn() } },
  tabs: { onUpdated: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() }, onCreated: { addListener: vi.fn() } },
  debugger: { onDetach: { addListener: vi.fn() }, onEvent: { addListener: vi.fn() } },
};

const { purgeForeignExtensionFrames, FOREIGN_EXTENSION_FRAME_ERROR } = await import('@/background/tab-manager');

describe('purgeForeignExtensionFrames', () => {
  it('sweeps every frame, passes our own id and adds up what was removed', async () => {
    executeScript.mockResolvedValueOnce([{ result: 2 }, { result: 1 }, { result: undefined }]);
    await expect(purgeForeignExtensionFrames(7)).resolves.toBe(3);
    const call = executeScript.mock.calls[0][0];
    expect(call.target).toEqual({ tabId: 7, allFrames: true });
    expect(call.args).toEqual(['ownextensionid']);
  });

  it('matches the error Chrome gives for a tab with another extension frame', () => {
    expect('Cannot access a chrome-extension:// URL of different extension').toContain(FOREIGN_EXTENSION_FRAME_ERROR);
  });
});
