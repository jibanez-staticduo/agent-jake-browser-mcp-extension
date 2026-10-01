import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentStopped, runAgent } from '@/background/agent/loop';
import { createCopilotTrafficGate, registerCopilotBridge } from '@/background/agent/bridge';
import { COPILOT_PORT, COPILOT_SETTINGS_KEY, DEFAULT_COPILOT_SETTINGS } from '@/types/copilot';
import type { TabManager } from '@/background/tab-manager';
import type { PanelToWorker, WorkerToPanel } from '@/types/copilot';

vi.mock('@/utils/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('@/background/agent/loop', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/background/agent/loop')>(),
  runAgent: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  let currentTab = 1;
  const tabManager = {
    getConnectedTabId: vi.fn(() => currentTab),
    connectTab: vi.fn(async (id: number) => { currentTab = id; }),
    disconnectTab: vi.fn(async () => { currentTab = 0; }),
    listTabs: vi.fn(async () => []),
  } as unknown as TabManager;
  const handler = vi.fn(async (message: { id: string }) => ({ id: message.id, success: true, result: { tabId: currentTab } }));
  const gate = createCopilotTrafficGate(tabManager, handler);
  const onConnect = vi.fn();
  vi.stubGlobal('chrome', {
    runtime: { onConnect: { addListener: onConnect } },
    storage: { local: { get: vi.fn(async () => ({
      [COPILOT_SETTINGS_KEY]: { ...DEFAULT_COPILOT_SETTINGS, baseUrl: 'https://model.test/v1', model: 'chat' },
    })) } },
    tabs: { get: vi.fn(async (id: number) => ({ id, url: `https://tab${id}.test/` })) },
  });
  registerCopilotBridge(async () => ({
    tabManager, handleMessage: handler, acquireLease: () => gate.acquire(),
  }));

  function panel() {
    const events: WorkerToPanel[] = [];
    let receive!: (message: PanelToWorker) => Promise<void>;
    const port = {
      name: COPILOT_PORT,
      postMessage: (event: WorkerToPanel) => { events.push(event); },
      onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
      onDisconnect: { addListener: vi.fn() },
    };
    onConnect.mock.calls[0][0](port);
    return {
      events,
      send: (message: PanelToWorker) => receive(message),
      prompt: (tabId: number) => receive({
        type: 'prompt', history: [], prompt: 'inspect', targetTabId: tabId, mode: 'auto', model: 'chat',
      }),
    };
  }

  return { panel, gate, handler, tabManager, getTab: () => currentTab };
}

describe('Copilot bridge lease', () => {
  it('restores the MCP target after stop and rejects MCP while Copilot runs', async () => {
    const { panel, gate, handler, getTab } = setup();
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(runAgent).mockImplementation(async (_history, _prompt, _settings, deps) => {
      started();
      await new Promise<void>((_resolve, reject) => {
        deps.signal.addEventListener('abort', () => reject(new AgentStopped()), { once: true });
      });
      return '';
    });
    const first = panel();
    const turn = first.prompt(2);
    await running;
    expect(getTab()).toBe(2);
    expect((await gate.handleMcp({ id: 'm1', type: 'browser_type', payload: {} })).error?.code).toBe('COPILOT_BUSY');
    expect(handler).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }));

    await first.send({ type: 'stop' });
    await turn;
    expect(getTab()).toBe(1);
    expect(first.events).toContainEqual({ type: 'done', stopped: true });
    expect(await gate.handleMcp({ id: 'm2', type: 'browser_state', payload: {} })).toMatchObject({ result: { tabId: 1 } });
  });

  it('does not let a second panel change the target and restores it after an error', async () => {
    const { panel, getTab, tabManager } = setup();
    let fail!: (error: Error) => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(runAgent).mockImplementation(() => new Promise<string>((_resolve, reject) => {
      fail = reject;
      started();
    }));
    const first = panel();
    const second = panel();
    const turn = first.prompt(2);
    await running;

    await second.prompt(3);
    expect(getTab()).toBe(2);
    expect(tabManager.connectTab).not.toHaveBeenCalledWith(3);
    expect(second.events).toContainEqual({ type: 'error', message: expect.stringContaining('busy') });

    fail(new Error('model down'));
    await turn;
    expect(getTab()).toBe(1);
    expect(first.events).toContainEqual({ type: 'error', message: 'model down' });
    expect(first.events).toContainEqual({ type: 'done', stopped: false });
  });
});
