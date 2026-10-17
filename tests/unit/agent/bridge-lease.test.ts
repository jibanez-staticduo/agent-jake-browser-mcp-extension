import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentStopped, runAgent, type AgentDeps, type ToolOutcome } from '@/background/agent/loop';
import { createCopilotTrafficGate, registerCopilotBridge } from '@/background/agent/bridge';
import { COPILOT_PORT, COPILOT_SETTINGS_KEY, DEFAULT_COPILOT_SETTINGS } from '@/types/copilot';
import type { TabManager } from '@/background/tab-manager';
import type { IncomingMessage, OutgoingMessage } from '@/types/messages';
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
    hasTab: vi.fn(async () => true),
    listTabs: vi.fn(async () => []),
  } as unknown as TabManager;
  // Routes like createToolHandlers: a call with a target connects that tab first.
  const handler = vi.fn(async (message: IncomingMessage, _signal?: AbortSignal): Promise<OutgoingMessage> => {
    if (typeof message.payload.targetTabId === 'number') currentTab = message.payload.targetTabId;
    return { id: message.id, success: true, result: { tabId: currentTab } };
  });
  const gate = createCopilotTrafficGate(tabManager, handler);
  const onConnect = vi.fn();
  vi.stubGlobal('chrome', {
    runtime: { onConnect: { addListener: onConnect } },
    storage: { local: { get: vi.fn(async () => ({
      [COPILOT_SETTINGS_KEY]: { ...DEFAULT_COPILOT_SETTINGS, baseUrl: 'https://model.test/v1', apiKey: 'k', model: 'chat' },
    })) } },
    tabs: { get: vi.fn(async (id: number) => ({ id, url: `https://tab${id}.test/` })) },
  });
  registerCopilotBridge(async () => ({ tabManager, acquireLease: (tabId) => gate.acquire(tabId) }));

  function panel() {
    const events: WorkerToPanel[] = [];
    let receive!: (message: PanelToWorker) => Promise<void>;
    let leave!: () => void;
    const port = {
      name: COPILOT_PORT,
      postMessage: (event: WorkerToPanel) => { events.push(event); },
      onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
      onDisconnect: { addListener: (listener: () => void) => { leave = listener; } },
    };
    onConnect.mock.calls[0][0](port);
    return {
      events,
      send: (message: PanelToWorker) => receive(message),
      // Cerrar el panel: el puerto se va y el `prompt` en curso se queda sin quien le espere.
      close: () => leave(),
      prompt: (tabId: number | null, over: Partial<Extract<PanelToWorker, { type: 'prompt' }>> = {}) => receive({
        type: 'prompt', history: [], prompt: 'inspect', targetTabId: tabId, mode: 'auto', model: 'chat', ...over,
      }),
    };
  }

  return { panel, gate, handler, tabManager, getTab: () => currentTab };
}

/** A run that reads its page first (the copilot is in its tab from then on) and then does `rest`. */
function runs(rest: (deps: AgentDeps) => Promise<string>) {
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  vi.mocked(runAgent).mockImplementation(async (_history, _prompt, _settings, deps) => {
    await deps.execTool('browser_state', {});
    started();
    return rest(deps);
  });
  return running;
}

const untilStopped = (deps: AgentDeps) => new Promise<string>((_resolve, reject) => {
  deps.signal.addEventListener('abort', () => reject(new AgentStopped()), { once: true });
});

describe('Copilot bridge lease', () => {
  it("keeps MCP out of the copilot's tab while it runs, not out of the others, and gives the browser back on stop", async () => {
    const { panel, gate, handler, getTab } = setup();
    const running = runs(untilStopped);
    const first = panel();
    const turn = first.prompt(2);
    await running;
    expect(getTab()).toBe(2);
    expect((await gate.handleMcp({ id: 'm1', type: 'browser_type', payload: {} })).error?.code).toBe('COPILOT_BUSY');
    expect((await gate.handleMcp({ id: 'm2', type: 'browser_type', payload: { targetTabId: 2 } })).error?.code).toBe('COPILOT_BUSY');
    expect(handler).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), expect.anything());

    await first.send({ type: 'stop' });
    await turn;
    expect(getTab()).toBe(1);
    expect(first.events).toContainEqual({ type: 'done', stopped: true });
    expect(await gate.handleMcp({ id: 'm3', type: 'browser_state', payload: {} })).toMatchObject({ result: { tabId: 1 } });
  });

  it('lets MCP work in another tab while the copilot runs', async () => {
    const { panel, gate } = setup();
    const running = runs(untilStopped);
    const first = panel();
    const turn = first.prompt(2);
    await running;
    expect(await gate.handleMcp({ id: 'm1', type: 'browser_type', payload: { targetTabId: 5 } })).toMatchObject({ success: true, result: { tabId: 5 } });
    await first.send({ type: 'stop' });
    await turn;
  });

  // INFRA-909: lo que anuncia el servidor son herramientas del copiloto; lo que no es suyo no toca la pestaña.
  it('sends a plugin call to the server and never to the tab', async () => {
    const { panel, handler } = setup();
    vi.mocked(chrome.storage.local.get).mockResolvedValue({
      [COPILOT_SETTINGS_KEY]: {
        ...DEFAULT_COPILOT_SETTINGS, baseUrl: 'https://model.test/v1', apiKey: 'k', model: 'chat', mcpUrl: 'https://jake.test/mcp',
      },
    });
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body)) as { id?: number; method: string };
      seen.push(body.method);
      const result = body.method === 'tools/list'
        ? { tools: [{ name: 'delegar', description: 'delegar', inputSchema: { type: 'object', properties: {} } }] }
        : { content: [{ type: 'text', text: 'trabajo aceptado' }] };
      return {
        ok: true, status: 200, headers: new Headers({ 'mcp-session-id': 'sess-1' }),
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
      };
    }));

    let outcome!: ToolOutcome;
    const running = runs(async (deps) => {
      await deps.serverTools!();
      outcome = await deps.execTool('delegar', { orden: 'informe' });
      return 'done';
    });
    const first = panel();
    await first.prompt(2);
    await running;

    expect(seen).toContain('tools/call');
    expect(outcome).toEqual({ ok: true, result: 'trabajo aceptado' });
    expect(handler).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'delegar' }), expect.anything());
  });

  it('refuses a second panel in the same tab, and an error still gives the browser back', async () => {
    const { panel, getTab, tabManager } = setup();
    let fail!: (error: Error) => void;
    const running = runs(() => new Promise<string>((_resolve, reject) => { fail = reject; }));
    const first = panel();
    const second = panel();
    const turn = first.prompt(2);
    await running;

    await second.prompt(2);
    expect(second.events).toContainEqual({ type: 'error', message: expect.stringContaining('busy') });

    fail(new Error('model down'));
    await turn;
    expect(getTab()).toBe(1);
    expect(tabManager.connectTab).toHaveBeenCalledWith(1);
    expect(first.events).toContainEqual({ type: 'error', message: 'model down' });
    expect(first.events).toContainEqual({ type: 'done', stopped: false });
  });

  it('runs a panel in another tab at the same time, each in its own tab', async () => {
    const { panel, handler } = setup();
    const firstRunning = runs(untilStopped);
    const first = panel();
    const firstTurn = first.prompt(2);
    await firstRunning;

    const secondRunning = runs(untilStopped);
    const second = panel();
    const secondTurn = second.prompt(3);
    await secondRunning;
    expect(handler).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'browser_state', payload: { targetTabId: 3 } }), expect.any(AbortSignal));

    await first.send({ type: 'stop' });
    await second.send({ type: 'stop' });
    await Promise.all([firstTurn, secondTurn]);
    expect(first.events).toContainEqual({ type: 'done', stopped: true });
    expect(second.events).toContainEqual({ type: 'done', stopped: true });
  });

  it('refuses a panel without a tab to work in', async () => {
    const { panel } = setup();
    const first = panel();
    await first.prompt(null);
    expect(runAgent).not.toHaveBeenCalled();
    expect(first.events).toContainEqual({ type: 'error', message: expect.stringContaining('no tab') });
  });

  it('frees the browser when the panel closes on a run that never aborts', async () => {
    const { panel, gate, getTab } = setup();
    const running = runs(() => new Promise<string>(() => {}));
    const first = panel();
    void first.prompt(2);
    await running;
    expect(getTab()).toBe(2);
    expect((await gate.handleMcp({ id: 'm1', type: 'browser_type', payload: {} })).error?.code).toBe('COPILOT_BUSY');

    first.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getTab()).toBe(1);
    expect(await gate.handleMcp({ id: 'm2', type: 'browser_state', payload: {} })).toMatchObject({ result: { tabId: 1 } });
  });

  it('restores the previous tab once even if the hung run unwinds after the panel closed', async () => {
    const { panel, tabManager, getTab } = setup();
    let finish!: (value: string) => void;
    const running = runs(() => new Promise<string>((resolve) => { finish = resolve; }));
    const first = panel();
    const turn = first.prompt(2);
    await running;

    first.close();
    finish('ok');
    await turn;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getTab()).toBe(1);
    expect(vi.mocked(tabManager.connectTab).mock.calls.filter(([id]) => id === 1)).toHaveLength(1);
  });

  it('keeps the agent on the chinchetada tab until the pin comes off', async () => {
    const { panel, handler } = setup();
    let started!: () => void;
    let go!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const unblocked = new Promise<void>((resolve) => { go = resolve; });
    const outcomes: ToolOutcome[] = [];
    vi.mocked(runAgent).mockImplementation(async (_history, _prompt, _settings, deps) => {
      outcomes.push(await deps.execTool('browser_switch_tab', { tabId: 9 }));
      started();
      await unblocked;
      outcomes.push(await deps.execTool('browser_new_tab', { url: 'https://otra.test/' }));
      return 'ok';
    });
    const first = panel();
    const turn = first.prompt(2, { pinned: true });
    await running;
    expect(outcomes[0]).toEqual({ ok: false, error: expect.stringContaining('chincheta') });
    expect(handler).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'browser_switch_tab' }), expect.anything());

    await first.send({ type: 'pin', pinned: false });
    go();
    await turn;
    expect(outcomes[1]).toMatchObject({ ok: true });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'browser_new_tab' }), expect.any(AbortSignal));
    expect(first.events).toContainEqual({ type: 'target', title: expect.any(String) });
  });
});
