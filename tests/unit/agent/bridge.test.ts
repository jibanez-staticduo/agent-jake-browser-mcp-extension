import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCopilotBridge } from '@/background/agent/bridge';
import { runAgent } from '@/background/agent/loop';
import { COPILOT_PORT, COPILOT_SETTINGS_KEY } from '@/types/copilot';

vi.mock('@/utils/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('@/background/agent/loop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/background/agent/loop')>()),
  runAgent: vi.fn(),
}));

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

describe('copilot execTool only runs the tools the model is offered', () => {
  /** One prompt to the bridge; runAgent is replaced by a model that calls `name` and keeps the outcome. */
  async function callFromModel(name: string) {
    vi.stubGlobal('chrome', {
      runtime: { onConnect: { addListener: vi.fn() } },
      storage: { local: { get: vi.fn(async () => ({ [COPILOT_SETTINGS_KEY]: { baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm' } })) } },
    });
    const handleMessage = vi.fn(async (m: { id: string }) => ({ id: m.id, success: true, result: { value: 'CANARY-SEED-7F3A9C21' } }));
    const getDeps = vi.fn(async () => ({
      tabManager: { getConnectedTabId: () => null } as never,
      handleMessage: handleMessage as never,
      acquireLease: () => async () => {},
    }));
    let outcome: unknown;
    vi.mocked(runAgent).mockImplementationOnce(async (_history, _prompt, _settings, deps) => {
      outcome = await deps.execTool(name, { selector: '#semilla' });
      return '';
    });
    registerCopilotBridge(getDeps);
    const onConnect = vi.mocked(chrome.runtime.onConnect.addListener);
    const onMessage = vi.fn();
    onConnect.mock.calls[0][0]({
      name: COPILOT_PORT, postMessage: vi.fn(), onMessage: { addListener: onMessage }, onDisconnect: { addListener: vi.fn() },
    } as never);
    await onMessage.mock.calls[0][0]({ type: 'prompt', prompt: 'p', history: [], mode: 'auto', model: 'm' });
    return { outcome, handleMessage };
  }

  it.each(['browser_read_secret', 'browser_no_existe'])('refuses %s without calling handleMessage', async (name) => {
    const { outcome, handleMessage } = await callFromModel(name);
    expect(outcome).toMatchObject({ ok: false });
    expect(JSON.stringify(outcome)).not.toContain('CANARY-SEED-7F3A9C21');
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('still runs a tool of the catalog', async () => {
    const { outcome, handleMessage } = await callFromModel('browser_get_text');
    expect(outcome).toMatchObject({ ok: true });
    expect(handleMessage).toHaveBeenCalledOnce();
  });
});
