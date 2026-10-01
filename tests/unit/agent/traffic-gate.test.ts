import { describe, expect, it, vi } from 'vitest';
import { createCopilotTrafficGate } from '@/background/agent/bridge';
import type { TabManager } from '@/background/tab-manager';
import type { IncomingMessage, OutgoingMessage } from '@/types/messages';

const message: IncomingMessage = { id: 'mcp-1', type: 'browser_type', payload: { ref: '1', text: 'x' } };

function setup(initialTab: number | null = 1) {
  let currentTab = initialTab;
  const tabManager = {
    getConnectedTabId: vi.fn(() => currentTab),
    connectTab: vi.fn(async (id: number) => { currentTab = id; }),
    disconnectTab: vi.fn(async () => { currentTab = null; }),
  } as unknown as TabManager;
  const handler = vi.fn(async (request: IncomingMessage): Promise<OutgoingMessage> => ({
    id: request.id, success: true, result: { tabId: currentTab },
  }));
  return {
    tabManager,
    handler,
    setTab(id: number | null) { currentTab = id; },
    getTab() { return currentTab; },
  };
}

describe('Copilot/MCP traffic gate', () => {
  it('rejects a panel while an MCP call is in flight', async () => {
    const { tabManager, handler } = setup();
    let finish!: (response: OutgoingMessage) => void;
    handler.mockImplementation(() => new Promise<OutgoingMessage>((resolve) => { finish = resolve; }));
    const gate = createCopilotTrafficGate(tabManager, handler);
    const call = gate.handleMcp(message);

    expect(gate.acquire()).toBeNull();
    finish({ id: message.id, success: true });
    await call;
    const release = gate.acquire();
    expect(release).not.toBeNull();
    await release?.();
  });

  it('rejects MCP and a second panel until the previous MCP tab is restored', async () => {
    const { tabManager, handler, setTab, getTab } = setup(1);
    const gate = createCopilotTrafficGate(tabManager, handler);
    const release = gate.acquire();
    expect(release).not.toBeNull();
    expect(gate.acquire()).toBeNull();

    setTab(2);
    expect(await gate.handleMcp(message)).toEqual({
      id: message.id, success: false,
      error: { code: 'COPILOT_BUSY', message: expect.stringContaining('retry') },
    });
    expect(handler).not.toHaveBeenCalled();

    await release?.();
    expect(tabManager.connectTab).toHaveBeenCalledWith(1);
    expect(getTab()).toBe(1);
    expect(await gate.handleMcp(message)).toMatchObject({ success: true, result: { tabId: 1 } });
  });

  it('restores the absence of an MCP tab and unlocks even when restore fails', async () => {
    const empty = setup(null);
    const emptyGate = createCopilotTrafficGate(empty.tabManager, empty.handler);
    const releaseEmpty = emptyGate.acquire();
    empty.setTab(2);
    await releaseEmpty?.();
    expect(empty.tabManager.disconnectTab).toHaveBeenCalledOnce();
    expect(empty.getTab()).toBeNull();

    const broken = setup(1);
    const brokenGate = createCopilotTrafficGate(broken.tabManager, broken.handler);
    const releaseBroken = brokenGate.acquire();
    broken.setTab(2);
    vi.mocked(broken.tabManager.connectTab).mockRejectedValueOnce(new Error('tab closed'));
    await expect(releaseBroken?.()).rejects.toThrow('tab closed');
    expect(brokenGate.acquire()).not.toBeNull();
  });
});
