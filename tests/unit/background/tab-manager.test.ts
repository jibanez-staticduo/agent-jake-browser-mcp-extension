import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockChrome = {
  storage: {
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  },
  tabs: {
    get: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    remove: vi.fn(),
    onUpdated: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    onCreated: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
  debugger: {
    getTargets: vi.fn(),
    attach: vi.fn(),
    sendCommand: vi.fn(),
    detach: vi.fn(),
    onEvent: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    onDetach: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
  scripting: {
    executeScript: vi.fn().mockResolvedValue([]),
  },
};

(globalThis as { chrome?: unknown }).chrome = mockChrome as unknown;

vi.mock('@/utils/logger', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/utils/logger')>(),
  log: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/background/activity-log', () => ({
  logTab: vi.fn().mockResolvedValue(undefined),
  logError: vi.fn().mockResolvedValue(undefined),
}));

import { TabManager } from '@/background/tab-manager';
import { pageEvents } from '@/background/page-events';
import { createTabHandlers } from '@/background/tools/handlers/tabs';
import type { HandlerContext } from '@/background/tools/handlers/types';

describe('TabManager closeTab', () => {
  let manager: TabManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChrome.tabs.remove.mockReset().mockResolvedValue(undefined);
    mockChrome.debugger.detach.mockResolvedValue(undefined);
    manager = new TabManager();
    (manager as unknown as { connectedTabId: number }).connectedTabId = 7;
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '42'])(
    'rejects invalid explicit id %s without closing or disconnecting the connected tab', async (tabId) => {
      const disconnect = vi.spyOn(manager, 'disconnectTab');

      await expect(manager.closeTab(tabId as number)).rejects.toThrow('positive integer');

      expect(mockChrome.tabs.remove).not.toHaveBeenCalled();
      expect(disconnect).not.toHaveBeenCalled();
      expect(manager.getConnectedTabId()).toBe(7);
    },
  );

  it('closes the requested tab through the real handler and preserves the connected tab', async () => {
    const handlers = createTabHandlers({ tabManager: manager } as HandlerContext);
    const disconnect = vi.spyOn(manager, 'disconnectTab');

    await expect(handlers.browser_close_tab({ tabId: 42 })).resolves.toEqual({ closed: true, tabId: 42 });

    expect(mockChrome.tabs.remove).toHaveBeenCalledTimes(1);
    expect(mockChrome.tabs.remove).toHaveBeenCalledWith(42);
    expect(disconnect).not.toHaveBeenCalled();
    expect(manager.getConnectedTabId()).toBe(7);
  });

  it('rejects zero through the real handler and manager without any tab effects', async () => {
    const handlers = createTabHandlers({ tabManager: manager } as HandlerContext);

    await expect(handlers.browser_close_tab({ tabId: 0 })).rejects.toThrow();

    expect(mockChrome.tabs.remove).not.toHaveBeenCalled();
    expect(mockChrome.storage.local.remove).not.toHaveBeenCalled();
    expect(manager.getConnectedTabId()).toBe(7);
  });

  it('closes and disconnects the connected tab when the handler receives no id', async () => {
    const handlers = createTabHandlers({ tabManager: manager } as HandlerContext);

    await expect(handlers.browser_close_tab({})).resolves.toEqual({ closed: true, tabId: 7 });

    expect(mockChrome.tabs.remove).toHaveBeenCalledTimes(1);
    expect(mockChrome.tabs.remove).toHaveBeenCalledWith(7);
    expect(mockChrome.storage.local.remove).toHaveBeenCalled();
    expect(manager.getConnectedTabId()).toBeNull();
  });

  it('reports failure for an unknown explicit id without closing the connected tab', async () => {
    mockChrome.tabs.remove.mockRejectedValue(new Error('No tab with id: 42'));

    await expect(manager.closeTab(42)).rejects.toThrow('No tab with id: 42');

    expect(mockChrome.tabs.remove).toHaveBeenCalledTimes(1);
    expect(mockChrome.tabs.remove).toHaveBeenCalledWith(42);
    expect(mockChrome.storage.local.remove).not.toHaveBeenCalled();
    expect(manager.getConnectedTabId()).toBe(7);
  });

  it('rejects omission when no tab is connected', async () => {
    manager = new TabManager();

    await expect(manager.closeTab()).rejects.toThrow('No tab specified and no connected tab');

    expect(mockChrome.tabs.remove).not.toHaveBeenCalled();
  });
});

describe('TabManager CDP readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cancels a file chooser event wait without a late timeout rejection', async () => {
    const manager = new TabManager();
    (manager as unknown as { connectedTabId: number }).connectedTabId = 101;
    const controller = new AbortController();
    const wait = manager.waitForDebuggerEvent('Page.fileChooserOpened', 10000, controller.signal);
    controller.abort();
    await expect(wait).rejects.toThrow('Stopped waiting for Page.fileChooserOpened');
  });

  it('rejects a second file chooser until the first releases its lock', () => {
    const manager = new TabManager();
    manager.beginFileChooser();
    expect(() => manager.beginFileChooser()).toThrow('already in progress');
    manager.endFileChooser();
    expect(() => manager.beginFileChooser()).not.toThrow();
    manager.endFileChooser();
  });

  it('clears captured network and console data on disconnect and debugger detach', async () => {
    const manager = new TabManager();
    pageEvents.handle('Network.requestWillBeSent', { requestId: 'secret', request: { url: 'https://x.test', postData: 'secret' } });
    pageEvents.handle('Runtime.consoleAPICalled', { args: [{ value: 'secret' }] });
    await manager.disconnectTab();
    expect(pageEvents.networkRequests()).toHaveLength(0);
    expect(pageEvents.consoleMessages()).toHaveLength(0);

    pageEvents.handle('Network.requestWillBeSent', { requestId: 'secret2', request: { url: 'https://x.test' } });
    manager.markDebuggerDetached();
    expect(pageEvents.networkRequests()).toHaveLength(0);
  });

  it('ignores a late network event while disconnect is waiting on the close guard', async () => {
    const manager = new TabManager();
    (manager as unknown as { connectedTabId: number }).connectedTabId = 101;
    (manager as unknown as { captureEvents: boolean }).captureEvents = true;
    let releaseGuard!: () => void;
    vi.spyOn(manager as never, 'setLiveConnectionCloseGuard' as never).mockImplementation(
      () => new Promise<void>((resolve) => { releaseGuard = resolve; }) as never,
    );

    const disconnect = manager.disconnectTab();
    await expect(manager.waitForDebuggerEvent('Page.fileChooserOpened')).rejects.toThrow('No connected tab');
    await (manager as unknown as { handleDebuggerEvent: (source: { tabId: number }, method: string, params: object) => Promise<void> })
      .handleDebuggerEvent({ tabId: 101 }, 'Network.requestWillBeSent', {
        requestId: 'late', request: { url: 'https://x.test', headers: { Cookie: 'late-secret' } },
      });
    expect(pageEvents.networkRequests()).toHaveLength(0);
    releaseGuard();
    await disconnect;
    expect(pageEvents.networkRequests()).toHaveLength(0);
  });

  it('rejects old chooser waits and never sends their files to a new tab', async () => {
    const manager = new TabManager();
    (manager as unknown as { connectedTabId: number }).connectedTabId = 101;
    const oldWait = manager.waitForDebuggerEvent('Page.fileChooserOpened');
    const rejected = expect(oldWait).rejects.toThrow('tab changed or detached');

    await manager.disconnectTab();
    await rejected;
    (manager as unknown as { connectedTabId: number }).connectedTabId = 102;
    await (manager as unknown as { handleDebuggerEvent: (source: { tabId: number }, method: string, params: object) => Promise<void> })
      .handleDebuggerEvent({ tabId: 102 }, 'Page.fileChooserOpened', { backendNodeId: 77 });
    await expect(manager.setChooserFiles(101, 77, ['/tmp/old-file'])).rejects.toThrow('Tab changed');
    expect(mockChrome.debugger.sendCommand).not.toHaveBeenCalledWith(
      { tabId: 102 }, 'DOM.setFileInputFiles', expect.anything(),
    );
    await manager.setFileChooserInterception(101, false);
    expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 101 }, 'Page.setInterceptFileChooserDialog', { enabled: false },
    );
  });

  it('reports not ready when no tab is connected', async () => {
    const manager = new TabManager();
    const status = await manager.getCdpStatus();

    expect(status.connectedTabId).toBeNull();
    expect(status.debuggerAttached).toBe(false);
    expect(status.canExecuteCdp).toBe(false);
    expect(status.lastCdpError).toContain('No tab connected');
  });

  it('throws CDP_DEBUGGER_BUSY when another debugger owns the tab', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });
    mockChrome.debugger.getTargets.mockResolvedValue([]);
    mockChrome.debugger.attach.mockRejectedValue(
      new Error('Another debugger is already attached to the tab')
    );
    // The client holding it is not us: Chrome refuses our commands.
    mockChrome.debugger.sendCommand.mockRejectedValue(
      new Error('Debugger is not attached to the tab with id: 101')
    );

    await expect(manager.connectTab(101, 'https://example.com')).rejects.toThrow('CDP_DEBUGGER_BUSY');
  });

  it('attaches even when getTargets says the tab is already attached (another CDP client)', async () => {
    // Regression: with a Playwright client connected over CDP, `getTargets()[].attached` is
    // true while we are not attached at all. Trusting that flag skipped our own attach and
    // every command afterwards died with "Debugger is not attached".
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });
    mockChrome.debugger.getTargets.mockResolvedValue([{ tabId: 101, attached: true }]);
    let attached = false;
    mockChrome.debugger.attach.mockImplementation(async () => {
      attached = true;
    });
    mockChrome.debugger.sendCommand.mockImplementation(async () => {
      if (!attached) throw new Error('Debugger is not attached to the tab with id: 101');
      return {};
    });

    await manager.connectTab(101, 'https://example.com');

    expect(mockChrome.debugger.attach).toHaveBeenCalledWith({ tabId: 101 }, expect.any(String));
  });

  it('reattaches and retries once when command fails with detached debugger', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });

    // connectTab attach check -> detached
    // sendDebuggerCommand initial check -> attached
    // retry attach check -> detached
    mockChrome.debugger.getTargets
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ tabId: 101, attached: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ tabId: 101, attached: true }]);
    mockChrome.debugger.attach.mockResolvedValue(undefined);

    let firstEvaluate = true;
    mockChrome.debugger.sendCommand.mockImplementation(async (_debuggee, method) => {
      if (method === 'Runtime.enable' || method === 'Page.enable' || method === 'DOM.enable') {
        return {};
      }

      if (method === 'Runtime.evaluate') {
        if (firstEvaluate) {
          firstEvaluate = false;
          throw new Error('Debugger is not attached to the tab with id: 101.');
        }

        return { result: { type: 'number', value: 2 } };
      }

      return {};
    });

    await manager.connectTab(101, 'https://example.com');
    const result = await manager.sendDebuggerCommand('Runtime.evaluate', { expression: '1+1' });

    expect(result).toEqual({ result: { type: 'number', value: 2 } });
    expect(mockChrome.debugger.attach).toHaveBeenCalledTimes(2);
    expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 101 },
      'Runtime.evaluate',
      { expression: '1+1' }
    );
  });

  it('enables close confirmation on connect and disables it on disconnect', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });
    mockChrome.debugger.getTargets
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ tabId: 101, attached: true }]);
    mockChrome.debugger.attach.mockResolvedValue(undefined);
    mockChrome.debugger.sendCommand.mockResolvedValue({});

    await manager.connectTab(101, 'https://example.com');

    expect(mockChrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 101 },
        world: 'MAIN',
        func: expect.any(Function),
      })
    );

    await manager.disconnectTab();

    expect(mockChrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 101 },
        world: 'MAIN',
        func: expect.any(Function),
      })
    );
  });

  it('reapplies live connection UI for connected tab after reload', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });
    mockChrome.debugger.getTargets
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ tabId: 101, attached: true }]);
    mockChrome.debugger.attach.mockResolvedValue(undefined);
    mockChrome.debugger.sendCommand.mockResolvedValue({});

    await manager.connectTab(101, 'https://example.com');
    mockChrome.scripting.executeScript.mockClear();

    await manager.reapplyLiveConnectionUi();

    expect(mockChrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 101 },
        world: 'MAIN',
        func: expect.any(Function),
      })
    );
  });
});

describe('TabManager background-tab control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('createTab opens in the background by default', async () => {
    const manager = new TabManager();
    mockChrome.tabs.create.mockResolvedValue({ id: 5, url: 'https://example.com', title: '', active: false });

    await manager.createTab('https://example.com', false);

    expect(mockChrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://example.com',
      active: false,
    });
  });

  it('createTab activates the tab only when asked', async () => {
    const manager = new TabManager();
    mockChrome.tabs.create.mockResolvedValue({ id: 5, url: 'https://example.com', title: '', active: true });

    await manager.createTab('https://example.com', false, true);

    expect(mockChrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://example.com',
      active: true,
    });
  });

  it('bringTabToFront activates the tab and returns the previous one', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 5, windowId: 1 });
    mockChrome.tabs.query.mockResolvedValue([{ id: 3 }]);

    const previous = await manager.bringTabToFront(5);

    expect(previous).toBe(3);
    expect(mockChrome.tabs.update).toHaveBeenCalledWith(5, { active: true });
  });

  it('bringTabToFront is a no-op when the tab is already visible', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 5, windowId: 1 });
    mockChrome.tabs.query.mockResolvedValue([{ id: 5 }]);

    const previous = await manager.bringTabToFront(5);

    expect(previous).toBeNull();
    expect(mockChrome.tabs.update).not.toHaveBeenCalled();
  });

  it('restoreTabBehind puts the user tab back when ours is still in front', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 5, windowId: 1 });
    mockChrome.tabs.query.mockResolvedValue([{ id: 5 }]);

    await manager.restoreTabBehind(5, 3);

    expect(mockChrome.tabs.update).toHaveBeenCalledWith(3, { active: true });
  });

  it('restoreTabBehind leaves the user alone if they switched tabs meanwhile', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 5, windowId: 1 });
    mockChrome.tabs.query.mockResolvedValue([{ id: 9 }]);

    await manager.restoreTabBehind(5, 3);

    expect(mockChrome.tabs.update).not.toHaveBeenCalled();
  });

  it('restoreTabBehind survives the previous tab being closed', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockRejectedValue(new Error('No tab with id: 3'));

    await expect(manager.restoreTabBehind(5, 3)).resolves.toBeUndefined();
  });

  it('sendTabToBack activates a sibling tab of the same window', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 5, windowId: 1, active: true });
    mockChrome.tabs.query.mockResolvedValue([{ id: 5 }, { id: 6 }]);

    const activated = await manager.sendTabToBack(5);

    expect(activated).toBe(6);
    expect(mockChrome.tabs.update).toHaveBeenCalledWith(6, { active: true });
  });

  it('sendTabToBack is a no-op for an already hidden tab', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 5, windowId: 1, active: false });

    const activated = await manager.sendTabToBack(5);

    expect(activated).toBeNull();
    expect(mockChrome.tabs.update).not.toHaveBeenCalled();
  });

  it('sendTabToBack is a no-op when the tab is alone in its window', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 5, windowId: 1, active: true });
    mockChrome.tabs.query.mockResolvedValue([{ id: 5 }]);

    const activated = await manager.sendTabToBack(5);

    expect(activated).toBeNull();
    expect(mockChrome.tabs.update).not.toHaveBeenCalled();
  });
});
