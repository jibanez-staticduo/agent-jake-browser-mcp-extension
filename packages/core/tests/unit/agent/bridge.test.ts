import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCopilotBridge } from '@/background/agent/bridge';
import { COPILOT_PORT, COPILOT_SETTINGS_KEY } from '@/types/copilot';

vi.mock('@/utils/logger', () => ({ log: { warn: vi.fn() } }));

afterEach(() => vi.unstubAllGlobals());

describe('copilot bridge setup boundary', () => {
  it.each([undefined, { baseUrl: 'not a URL', model: 'model' }])(
    'rejects missing or invalid persisted setup before accessing browser dependencies',
    async (settings) => {
      const onConnect = vi.fn();
      const onMessage = vi.fn();
      const postMessage = vi.fn();
      vi.stubGlobal('chrome', {
        runtime: { onConnect: { addListener: onConnect } },
        storage: { local: { get: vi.fn(async () => ({ [COPILOT_SETTINGS_KEY]: settings })) } },
      });
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const getDeps = vi.fn(async () => ({ tabManager: null, handleMessage: null }));
      registerCopilotBridge(getDeps);
      onConnect.mock.calls[0][0]({
        name: COPILOT_PORT,
        postMessage,
        onMessage: { addListener: onMessage },
        onDisconnect: { addListener: vi.fn() },
      });
      await onMessage.mock.calls[0][0]({
        type: 'prompt', prompt: 'read private page', history: [], targetTabId: 7, mode: 'auto', model: 'model',
      });
      expect(getDeps).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(postMessage).toHaveBeenCalledWith({ type: 'error', message: expect.stringMatching(/Configure/) });
      expect(postMessage).toHaveBeenCalledWith({ type: 'done', stopped: false });
    },
  );
});
