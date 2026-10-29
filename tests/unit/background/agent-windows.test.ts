import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentWindows } from '@/background/agent-windows';

let store: Record<string, unknown>;
let tabs: Map<number, any>;
let targets: Map<number, string>;
let nextId: number;
const remove = vi.fn(async (id: number) => { tabs.delete(id); targets.delete(id); });
const chromeMock = {
  storage: { local: {
    get: vi.fn(async (key: string) => structuredClone({ [key]: store[key] })),
    set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(store, structuredClone(value)); }),
  } },
  debugger: { getTargets: vi.fn(async () => [...targets].map(([tabId, id]) => ({ tabId, id, type: 'page' }))) },
  tabs: {
    get: vi.fn(async (id: number) => { if (!tabs.has(id)) throw new Error('No tab'); return { ...tabs.get(id) }; }),
    create: vi.fn(async (props: any) => makeTab(props.windowId, props.url)), remove,
  },
  windows: {
    create: vi.fn(async (props: any) => { const windowId = nextId++; return { id: windowId, tabs: [makeTab(windowId, props.url)] }; }),
    get: vi.fn(async (id: number) => { if (![...tabs.values()].some(tab => tab.windowId === id)) throw new Error('No window'); return { id }; }),
    remove: vi.fn(),
  },
};
function makeTab(windowId: number, url = 'about:blank') {
  const tab = { id: nextId++, windowId, url, active: false };
  tabs.set(tab.id, tab); targets.set(tab.id, `target-original-${tab.id}`); return tab;
}
vi.stubGlobal('chrome', chromeMock);

describe('agent window provenance', () => {
  beforeEach(() => { vi.clearAllMocks(); store = {}; tabs = new Map(); targets = new Map(); nextId = 30; });

  it('opens unfocused, reuses only its own window, and records each created tab', async () => {
    const windows = new AgentWindows();
    const first = await windows.openTab('about:blank');
    const second = await windows.openTab('about:blank', first.tab.windowId);
    expect(first.windowCreated).toBe(true); expect(second.windowCreated).toBe(false);
    expect(chromeMock.windows.create).toHaveBeenCalledWith({ url: 'about:blank', focused: false, state: 'normal' });
    expect(chromeMock.tabs.create).toHaveBeenCalledWith({ windowId: first.tab.windowId, url: 'about:blank', active: false });
    expect((store['ajb.agentWindowProvenance'] as any[])[0].witnesses).toHaveLength(2);
  });

  it.each(['worker restart', 'extension reload/update clears storage.session'])('recovers after %s using unchanged target UUIDs', async () => {
    const first = await new AgentWindows().openTab('about:blank');
    const second = await new AgentWindows().openTab('about:blank', first.tab.windowId);
    expect(second.tab.windowId).toBe(first.tab.windowId);
    expect(second.windowCreated).toBe(false);
    expect(chromeMock.windows.create).toHaveBeenCalledTimes(1);
  });

  it('rejects browser-restarted reused numeric IDs with different target UUIDs for close and reuse', async () => {
    const first = await new AgentWindows().openTab('about:blank');
    targets.set(first.tab.id, 'new-browser-target-uuid');
    await expect(new AgentWindows().closeWindow(first.tab.windowId, [first.tab.id], async () => {})).rejects.toThrow('NOT_AGENT_WINDOW');
    expect(remove).not.toHaveBeenCalled();
    const second = await new AgentWindows().openTab('about:blank', first.tab.windowId);
    expect(second.tab.windowId).not.toBe(first.tab.windowId);
    expect(tabs.has(first.tab.id)).toBe(true);
  });

  it('rejects a witness moved into another window', async () => {
    const first = await new AgentWindows().openTab('about:blank');
    tabs.get(first.tab.id).windowId = 999;
    await expect(new AgentWindows().closeWindow(first.tab.windowId, [first.tab.id], async () => {})).rejects.toThrow('NOT_AGENT_WINDOW');
    expect(remove).not.toHaveBeenCalled();
  });

  it('closes exact requested IDs and preserves user tabs and tabs moved during disconnect', async () => {
    const windows = new AgentWindows();
    const first = await windows.openTab('about:blank');
    const moved = await windows.openTab('about:blank', first.tab.windowId);
    const user = makeTab(first.tab.windowId);
    const result = await windows.closeWindow(first.tab.windowId, [first.tab.id, first.tab.id, moved.tab.id], async id => {
      if (id === moved.tab.id) tabs.get(id).windowId = 999;
    });
    expect(result).toEqual({ windowId: first.tab.windowId, closed: false, closedTabIds: [first.tab.id] });
    expect(tabs.has(user.id)).toBe(true); expect(tabs.has(moved.tab.id)).toBe(true);
    expect(chromeMock.windows.remove).not.toHaveBeenCalled();
  });

  it('reports partial closure when one selected tab already disappeared', async () => {
    const windows = new AgentWindows();
    const first = await windows.openTab('about:blank');
    const second = await windows.openTab('about:blank', first.tab.windowId);
    await remove(second.tab.id);
    expect(await windows.closeWindow(first.tab.windowId, [first.tab.id, second.tab.id], async () => {})).toEqual({ windowId: first.tab.windowId, closed: true, closedTabIds: [first.tab.id] });
    expect(store['ajb.agentWindowProvenance']).toEqual([]);
  });

  it('serializes concurrent manager creation and cleanup without losing another window', async () => {
    const [one, two] = await Promise.all([new AgentWindows().openTab('about:blank'), new AgentWindows().openTab('about:blank')]);
    await Promise.all([
      new AgentWindows().closeWindow(one.tab.windowId, [one.tab.id], async () => {}),
      new AgentWindows().openTab('about:blank', two.tab.windowId),
    ]);
    expect((store['ajb.agentWindowProvenance'] as any[]).map(entry => entry.windowId)).toEqual([two.tab.windowId]);
    expect(await new AgentWindows().openTab('about:blank', two.tab.windowId)).toMatchObject({ windowCreated: false });
  });

  it('recovers the serialized queue after a real removal error', async () => {
    const windows = new AgentWindows(); const first = await windows.openTab('about:blank');
    remove.mockRejectedValueOnce(new Error('Chrome busy'));
    await expect(windows.closeWindow(first.tab.windowId, [first.tab.id], async () => {})).rejects.toThrow('Chrome busy');
    expect(await windows.closeWindow(first.tab.windowId, [first.tab.id], async () => {})).toMatchObject({ closed: true });
  });
});
