import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

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
    reload: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    remove: vi.fn(),
    onUpdated: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    onRemoved: {
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
  runtime: {
    id: 'own-extension-id',
    getManifest: vi.fn(() => ({ content_scripts: [{ js: ['content.js'] }] })),
  },
  webNavigation: {
    getAllFrames: vi.fn().mockResolvedValue([]),
    onCommitted: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    onDOMContentLoaded: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
};

(globalThis as { chrome?: unknown }).chrome = mockChrome as unknown;

vi.mock('@/utils/logger', () => import('../helpers/logger'));

vi.mock('@/background/activity-log', () => ({
  logTab: vi.fn().mockResolvedValue(undefined),
  logError: vi.fn().mockResolvedValue(undefined),
}));

import { TabManager, WEBAUTHN_PIN_SCRIPT, PASSKEY_CEREMONY_TIMEOUT_MS, pinWebAuthn, purgeForeignExtensionFrames } from '@/background/tab-manager';
import { pinnedToTab } from '@/background/tool-handlers';
import { runInNewContext } from 'node:vm';
import { TIMEOUTS } from '@/constants/timeouts';
import { createNavigationHandlers } from '@/background/tools/handlers/navigation';
import type { HandlerContext } from '@/background/tools/handlers/types';
import { createStateHandlers } from '@/background/tools/handlers/state';
import { createToolContext } from '@/background/tools/utils';

/** A tab the manager already drives, without going through the debugger: the tests below are about
 * what happens on a tab, not about attaching it. */
function drive(manager: TabManager, tabId: number) {
  const session = (manager as unknown as { session(n: number): { debuggerAttached: boolean; captureEvents: boolean } }).session(tabId);
  session.debuggerAttached = true;
  session.captureEvents = true;
  return session;
}

describe('TabManager CDP readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cancels a file chooser event wait without a late timeout rejection', async () => {
    const manager = new TabManager();
    drive(manager, 101);
    const controller = new AbortController();
    const wait = manager.waitForDebuggerEvent(101, 'Page.fileChooserOpened', 10000, controller.signal);
    controller.abort();
    await expect(wait).rejects.toThrow('Stopped waiting for Page.fileChooserOpened');
  });

  it('rejects a second file chooser until the first releases its lock', () => {
    const manager = new TabManager();
    manager.beginFileChooser(101);
    expect(() => manager.beginFileChooser(101)).toThrow('already in progress');
    manager.endFileChooser(101);
    expect(() => manager.beginFileChooser(101)).not.toThrow();
    manager.endFileChooser(101);
  });

  it('clears captured network and console data on disconnect and debugger detach', async () => {
    const manager = new TabManager();
    drive(manager, 101);
    const events = manager.eventsFor(101);
    events.handle('Network.requestWillBeSent', { requestId: 'secret', request: { url: 'https://x.test', postData: 'secret' } });
    events.handle('Runtime.consoleAPICalled', { args: [{ value: 'secret' }] });
    await manager.disconnectTab(101);
    expect(events.networkRequests()).toHaveLength(0);
    expect(events.consoleMessages()).toHaveLength(0);

    drive(manager, 101);
    manager.eventsFor(101).handle('Network.requestWillBeSent', { requestId: 'secret2', request: { url: 'https://x.test' } });
    manager.markDebuggerDetached(101);
    expect(manager.eventsFor(101).networkRequests()).toHaveLength(0);
  });

  it('ignores a late network event while disconnect is waiting on the close guard', async () => {
    const manager = new TabManager();
    drive(manager, 101);
    let releaseGuard!: () => void;
    vi.spyOn(manager as never, 'setLiveConnectionCloseGuard' as never).mockImplementation(
      () => new Promise<void>((resolve) => { releaseGuard = resolve; }) as never,
    );

    const disconnect = manager.disconnectTab(101);
    await expect(manager.waitForDebuggerEvent(101, 'Page.fileChooserOpened')).rejects.toThrow('No debugger session for tab 101');
    await (manager as unknown as { handleDebuggerEvent: (source: { tabId: number }, method: string, params: object) => Promise<void> })
      .handleDebuggerEvent({ tabId: 101 }, 'Network.requestWillBeSent', {
        requestId: 'late', request: { url: 'https://x.test', headers: { Cookie: 'late-secret' } },
      });
    expect(manager.eventsFor(101).networkRequests()).toHaveLength(0);
    releaseGuard();
    await disconnect;
    expect(manager.eventsFor(101).networkRequests()).toHaveLength(0);
  });

  it('rejects old chooser waits and never sends their files to a new tab', async () => {
    const manager = new TabManager();
    drive(manager, 101);
    const oldWait = manager.waitForDebuggerEvent(101, 'Page.fileChooserOpened');
    const rejected = expect(oldWait).rejects.toThrow('the tab detached');

    await manager.disconnectTab(101);
    await rejected;
    drive(manager, 102);
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

  it('connecting a tab we already drive attaches it once and leaves the other tabs alone', async () => {
    // INFRA-907: every command of a session routes through connectTab for its own tab; it must not
    // re-attach, and it must not take anything away from the tabs other sessions drive.
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });
    mockChrome.debugger.getTargets.mockResolvedValue([]);
    mockChrome.debugger.attach.mockResolvedValue(undefined);
    mockChrome.debugger.sendCommand.mockResolvedValue({});

    await manager.connectTab(102);
    await manager.connectTab(101);
    mockChrome.debugger.attach.mockClear();
    await manager.connectTab(101);

    expect(mockChrome.debugger.attach).not.toHaveBeenCalled();
    expect(mockChrome.debugger.detach).not.toHaveBeenCalled();
    expect(manager.drivenTabIds().sort((a, b) => a - b)).toEqual([101, 102]);
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

  it('turns WebAuthn into an immediate failure instead of the native security-key dialog', async () => {
    // Regression: GitHub's 2FA page asked for a security key through Chrome's native dialog,
    // which the agent cannot answer and which hid the authenticator-app (1Password TOTP) path.
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });
    mockChrome.debugger.attach.mockResolvedValue(undefined);
    mockChrome.debugger.sendCommand.mockImplementation(async (_debuggee, method) =>
      method === 'WebAuthn.addVirtualAuthenticator' ? { authenticatorId: 'va-1' } : {});

    await manager.connectTab(101, 'https://example.com');

    const webauthn = mockChrome.debugger.sendCommand.mock.calls.filter(([, method]) => String(method).startsWith('WebAuthn.'));
    expect(webauthn.map(([, method]) => method)).toEqual([
      'WebAuthn.disable',
      'WebAuthn.enable',
      'WebAuthn.addVirtualAuthenticator',
      'WebAuthn.setResponseOverrideBits',
    ]);
    expect(webauthn[1][2]).toEqual({ enableUI: false });
    expect(webauthn[2][2]).toEqual({
      options: expect.objectContaining({ hasUserVerification: true, isUserVerified: false, automaticPresenceSimulation: true }),
    });
    expect(webauthn[3][2]).toEqual({ authenticatorId: 'va-1', isBadUP: true });
  });

  it('pins navigator.credentials to Chrome in every document, once per session', async () => {
    // Regression: 1Password replaces navigator.credentials in the page and keeps discoverable
    // passkey requests (no allowCredentials) waiting on its unlock UI forever.
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });
    mockChrome.debugger.attach.mockResolvedValue(undefined);
    let n = 0;
    mockChrome.debugger.sendCommand.mockImplementation(async (_debuggee, method) => {
      if (method === 'WebAuthn.addVirtualAuthenticator') return { authenticatorId: 'va-1' };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: `s${++n}` };
      return {};
    });

    await manager.connectTab(101, 'https://example.com');
    await manager.reattachDebugger(101);

    const scripts = mockChrome.debugger.sendCommand.mock.calls
      .filter(([, method]) => String(method).includes('ScriptToEvaluateOnNewDocument'))
      .map(([, method, params]) => [method, params]);
    expect(scripts).toEqual([
      ['Page.addScriptToEvaluateOnNewDocument', { source: WEBAUTHN_PIN_SCRIPT, runImmediately: true }],
      ['Page.removeScriptToEvaluateOnNewDocument', { identifier: 's1' }],
      ['Page.addScriptToEvaluateOnNewDocument', { source: WEBAUTHN_PIN_SCRIPT, runImmediately: true }],
    ]);
  });

  it('the pin script hands get/create back to the native implementation and keeps them there', () => {
    class CredentialsContainer {
      get() { return 'native-get'; }
      create() { return 'native-create'; }
    }
    const credentials = new CredentialsContainer() as CredentialsContainer & Record<string, unknown>;
    // What a password manager does in the page before (or after) we run.
    credentials.get = () => 'hijacked';
    const window = { CredentialsContainer, navigator: { credentials } } as Record<string, unknown>;
    window.window = window;

    runInNewContext(WEBAUTHN_PIN_SCRIPT, window);
    credentials.create = () => 'hijacked';
    runInNewContext(WEBAUTHN_PIN_SCRIPT, window); // second run in the same document: no-op

    expect(credentials.get()).toBe('native-get');
    expect(credentials.create()).toBe('native-create');
  });

  it('the pin script hands a stand-in container to a page whose get/create were made non-configurable', () => {
    // A tab the agent adopts already loaded: 1Password got there first and locked its own
    // accessors, so the page gets navigator.credentials from us instead.
    const calls: unknown[] = [];
    class CredentialsContainer {
      get(...args: unknown[]) { calls.push(this); return `native-get:${args.length}`; }
      create() { calls.push(this); return 'native-create'; }
      store() { return 'native-store'; }
      preventSilentAccess() { return 'native-psa'; }
    }
    const real = new CredentialsContainer();
    for (const name of ['get', 'create']) {
      Object.defineProperty(real, name, { configurable: false, enumerable: true, get: () => () => 'hijacked', set: () => {} });
    }
    class Navigator { get credentials() { return real; } }
    const navigator = new Navigator() as Navigator & { credentials: CredentialsContainer };
    const window = { CredentialsContainer, navigator } as Record<string, unknown>;
    window.window = window;

    runInNewContext(WEBAUTHN_PIN_SCRIPT, window);
    runInNewContext(WEBAUTHN_PIN_SCRIPT, window); // again in the same document: no-op

    expect(navigator.credentials).not.toBe(real);
    expect(navigator.credentials).toBeInstanceOf(CredentialsContainer);
    expect(navigator.credentials.get({ publicKey: {} })).toBe('native-get:1');
    expect(navigator.credentials.create()).toBe('native-create');
    expect(navigator.credentials.store()).toBe('native-store');
    expect(calls).toEqual([real, real]); // Chrome's methods run on the real container
  });

  it('pins every web frame of the tab, and each subframe that commits later', async () => {
    // CDP scripts do not reach cross-site iframes (other processes); chrome.scripting does.
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });
    mockChrome.debugger.attach.mockResolvedValue(undefined);
    mockChrome.debugger.sendCommand.mockImplementation(async (_debuggee, method) =>
      method === 'WebAuthn.addVirtualAuthenticator' ? { authenticatorId: 'va-1' } : { identifier: 's1' });
    mockChrome.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 0, url: 'https://example.com/' },
      { frameId: 4, url: 'https://accounts.example.net/frame' },
      { frameId: 9, url: 'chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/inline.html' },
    ]);

    await manager.connectTab(101, 'https://example.com');

    const pinCalls = () => mockChrome.scripting.executeScript.mock.calls
      .map(([arg]) => arg as { target: { tabId: number; frameIds?: number[] }; func: unknown; world?: string })
      .filter((arg) => arg.func === pinWebAuthn);
    expect(pinCalls()).toEqual([
      expect.objectContaining({ target: { tabId: 101, frameIds: [0, 4] }, world: 'MAIN', injectImmediately: true }),
    ]);

    const onCommitted = mockChrome.webNavigation.onCommitted.addListener.mock.calls.at(-1)?.[0] as
      (d: { tabId: number; frameId: number; url: string }) => void;
    onCommitted({ tabId: 101, frameId: 12, url: 'https://idp.example.org/passkey' });
    onCommitted({ tabId: 101, frameId: 0, url: 'https://example.com/next' }); // main frame: CDP covers it
    onCommitted({ tabId: 202, frameId: 3, url: 'https://other.example/' }); // not our tab
    await vi.waitFor(() => expect(pinCalls()).toHaveLength(2));
    expect(pinCalls()[1].target).toEqual({ tabId: 101, frameIds: [12] });
  });

  it('emulates focus on the tab it drives, so input reaches it in the background', async () => {
    // Regression: a hidden tab got no CDP mouse/key event at all and the tools answered success;
    // the fix used to bring the tab in front of the user for every action.
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });
    mockChrome.debugger.attach.mockResolvedValue(undefined);
    mockChrome.debugger.sendCommand.mockImplementation(async (_d, method) =>
      method === 'WebAuthn.addVirtualAuthenticator' ? { authenticatorId: 'va-1' } : { identifier: 's1' });

    await manager.connectTab(101, 'https://example.com');

    expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 101 }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    expect(mockChrome.tabs.update).not.toHaveBeenCalledWith(101, { active: true });
  });

  it('still connects when the WebAuthn domain is unavailable', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });
    mockChrome.debugger.attach.mockResolvedValue(undefined);
    mockChrome.debugger.sendCommand.mockImplementation(async (_debuggee, method) => {
      if (String(method).startsWith('WebAuthn.')) throw new Error(`'${method}' wasn't found`);
      return {};
    });

    await expect(manager.connectTab(101, 'https://example.com')).resolves.toBeUndefined();
    expect(manager.drivenTabIds()).toEqual([101]);
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
    const result = await manager.sendDebuggerCommand(101, 'Runtime.evaluate', { expression: '1+1' });

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

    await manager.disconnectTab(101);

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

    await manager.reapplyLiveConnectionUi(101);

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

  it('createTab attaches on a blank page before loading the URL it will drive', async () => {
    // A password manager's page script (1Password) runs at document start; the WebAuthn guard
    // only wins in documents created after we attach, so the URL must load after connectTab.
    const manager = new TabManager();
    const order: string[] = [];
    let onUpdated: ((tabId: number, info: { status?: string }) => void) | undefined;
    mockChrome.tabs.onUpdated.addListener.mockImplementation((fn) => { onUpdated = fn; });
    mockChrome.tabs.create.mockImplementation(async (props) => {
      order.push(`create ${props.url}`);
      return { id: 7, url: props.url, title: '', active: false, status: 'complete' };
    });
    mockChrome.tabs.get.mockResolvedValue({ id: 7, url: 'https://example.com/', title: 'Example', active: false, status: 'complete' });
    mockChrome.tabs.update.mockImplementation(async (_id, props) => {
      order.push(`navigate ${props.url}`);
      queueMicrotask(() => onUpdated?.(7, { status: 'complete' }));
      return {};
    });
    mockChrome.debugger.attach.mockImplementation(async () => { order.push('attach'); });
    mockChrome.debugger.sendCommand.mockImplementation(async (_debuggee, method) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') order.push('pin script');
      return method === 'WebAuthn.addVirtualAuthenticator' ? { authenticatorId: 'va-1' } : { identifier: 's1' };
    });

    const info = await manager.createTab('https://example.com/');

    expect(order).toEqual(['create about:blank', 'attach', 'pin script', 'navigate https://example.com/']);
    expect(info).toMatchObject({ tab: { id: 7, url: 'https://example.com/', title: 'Example', connected: true }, loaded: true });
  });

  it('createTab closes the blank tab when it cannot load the URL', async () => {
    const manager = new TabManager();
    mockChrome.tabs.create.mockResolvedValue({ id: 8, url: 'about:blank', status: 'complete' });
    mockChrome.tabs.get.mockResolvedValue({ id: 8, url: 'about:blank', status: 'complete' });
    mockChrome.tabs.update.mockRejectedValueOnce(new Error('Cannot navigate'));
    mockChrome.tabs.remove.mockResolvedValue(undefined);
    mockChrome.debugger.attach.mockResolvedValue(undefined);
    mockChrome.debugger.sendCommand.mockImplementation(async (_d, method) =>
      method === 'WebAuthn.addVirtualAuthenticator' ? { authenticatorId: 'va-1' } : { identifier: 's1' });

    await expect(manager.createTab('https://example.com/')).rejects.toThrow('Cannot navigate');
    expect(mockChrome.tabs.remove).toHaveBeenCalledWith(8);
  });

  it('disconnectTab stops pinning frames of the tab it leaves', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });
    mockChrome.debugger.attach.mockResolvedValue(undefined);
    mockChrome.debugger.sendCommand.mockImplementation(async (_d, method) =>
      method === 'WebAuthn.addVirtualAuthenticator' ? { authenticatorId: 'va-1' } : { identifier: 's1' });

    await manager.connectTab(101, 'https://example.com');
    const listener = mockChrome.webNavigation.onCommitted.addListener.mock.calls.at(-1)?.[0];
    await manager.disconnectTab(101);

    expect(mockChrome.webNavigation.onCommitted.removeListener).toHaveBeenCalledWith(listener);
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

describe('TabManager auto-attach flag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChrome.tabs.get.mockResolvedValue({ id: 7, url: 'https://a.example/', title: 'a', windowId: 1 });
    mockChrome.debugger.getTargets.mockResolvedValue([]);
    mockChrome.debugger.attach.mockResolvedValue(undefined);
    mockChrome.debugger.sendCommand.mockResolvedValue({});
  });

  it('a tab bound by auto-attach is flagged, and persisted so a service-worker restart keeps the flag', async () => {
    const manager = new TabManager();

    await manager.connectTab(7, 'https://a.example/', { autoAttached: true });

    expect(manager.isAutoAttached(7)).toBe(true);
    expect(mockChrome.storage.local.set).toHaveBeenLastCalledWith({ drivenTabIds: [7], autoAttachedTabIds: [7] });
  });

  it('connecting the same tab on purpose (switch_tab, popup) clears the flag', async () => {
    const manager = new TabManager();
    await manager.connectTab(7, 'https://a.example/', { autoAttached: true });

    await manager.connectTab(7);

    expect(manager.isAutoAttached(7)).toBe(false);
    expect(mockChrome.storage.local.set).toHaveBeenLastCalledWith({ drivenTabIds: [7], autoAttachedTabIds: [] });
  });

  it('a plain connect (new_tab) is not flagged', async () => {
    const manager = new TabManager();

    await manager.connectTab(7);

    expect(manager.isAutoAttached(7)).toBe(false);
  });

  it('initialize restores the flag only for the tab it was set on', async () => {
    mockChrome.storage.local.get.mockResolvedValueOnce({ connectedTabId: 7, autoAttachedTabId: 7 });
    mockChrome.tabs.get.mockResolvedValue({ id: 7, url: 'https://a.example/' });
    const restored = new TabManager();
    await restored.initialize();
    expect(restored.isAutoAttached(7)).toBe(true);

    mockChrome.storage.local.get.mockResolvedValueOnce({ connectedTabId: 8, autoAttachedTabId: 7 });
    mockChrome.tabs.get.mockResolvedValue({ id: 8, url: 'https://b.example/' });
    const other = new TabManager();
    await other.initialize();
    expect(other.isAutoAttached(8)).toBe(false);
  });

  it('a call that names no tab auto-attaches the active one with the flag set', async () => {
    mockChrome.tabs.query.mockResolvedValue([{ id: 7, url: 'https://a.example/' }]);
    const manager = new TabManager();
    const ctx = createToolContext(pinnedToTab(manager, null));

    await ctx.sendToContent('getPageInfo').catch(() => undefined);

    expect(manager.drivenTabIds()).toEqual([7]);
    expect(manager.isAutoAttached(7)).toBe(true);
  });
});

describe('TabManager passkey ceremony (INFRA-585)', () => {
  const stored: Record<string, unknown> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(stored)) delete stored[key];
    mockChrome.storage.local.get.mockImplementation(async (key: string) => ({ [key]: stored[key] }));
    mockChrome.storage.local.set.mockImplementation(async (items: Record<string, unknown>) => {
      Object.assign(stored, items);
    });
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Login', url: 'https://accounts.shopify.com/lookup' });
    mockChrome.debugger.attach.mockResolvedValue(undefined);
  });

  /** The tab's authenticators as CDP sees them; the site "creates" or "uses" a credential on click. */
  function fakeWebAuthn(onClick: (credentials: Array<Record<string, unknown>>) => void) {
    let next = 0;
    const authenticators = new Map<string, Array<Record<string, unknown>>>();
    mockChrome.debugger.sendCommand.mockImplementation(async (_debuggee, method, params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (method === 'WebAuthn.addVirtualAuthenticator') {
        const id = `va-${++next}`;
        authenticators.set(id, []);
        return { authenticatorId: id };
      }
      if (method === 'WebAuthn.removeVirtualAuthenticator') authenticators.delete(String(p.authenticatorId));
      if (method === 'WebAuthn.addCredential') authenticators.get(String(p.authenticatorId))?.push({ ...(p.credential as object) });
      if (method === 'WebAuthn.getCredentials') return { credentials: authenticators.get(String(p.authenticatorId)) ?? [] };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 's1' };
      return {};
    });
    const click = vi.fn(async () => {
      const ceremony = [...authenticators.entries()].at(-1)!;
      onClick(ceremony[1]);
      return { clicked: 'e1' };
    });
    return { authenticators, click };
  }

  function webauthnCalls() {
    return mockChrome.debugger.sendCommand.mock.calls
      .filter(([, method]) => String(method).startsWith('WebAuthn.'))
      .map(([, method, params]) => [method, params] as [string, Record<string, unknown>]);
  }

  it('enroll: lets the site create a passkey, keeps it in the extension and puts the guard back', async () => {
    const manager = new TabManager();
    const { authenticators, click } = fakeWebAuthn((creds) => creds.push({
      credentialId: 'cred-1', isResidentCredential: true, rpId: 'accounts.shopify.com',
      privateKey: 'PKCS8-KEY', userHandle: 'user-1', signCount: 0,
    }));
    await manager.connectTab(101, 'https://accounts.shopify.com/lookup');
    mockChrome.debugger.sendCommand.mockClear();

    const { result, passkey } = await manager.runPasskeyCeremony(101, 'enroll', click);

    expect(result).toEqual({ clicked: 'e1' });
    expect(passkey).toEqual({
      mode: 'enroll', host: 'accounts.shopify.com', ceremony: 'completed',
      passkeys: [{ rpId: 'accounts.shopify.com', enrolledAt: expect.any(String) }],
    });
    // The key is stored in the extension, and never in what the tool answers.
    expect(JSON.stringify(stored)).toContain('PKCS8-KEY');
    expect(JSON.stringify(passkey)).not.toContain('PKCS8-KEY');
    expect(JSON.stringify(passkey)).not.toContain('user-1');
    // Guard out, ceremony authenticator (user verified) in, then the reverse.
    const calls = webauthnCalls();
    expect(calls[0]).toEqual(['WebAuthn.removeVirtualAuthenticator', { authenticatorId: 'va-1' }]);
    expect(calls[1]).toEqual(['WebAuthn.addVirtualAuthenticator', {
      options: expect.objectContaining({ transport: 'internal', isUserVerified: true }),
    }]);
    expect(calls.slice(-3)).toEqual([
      ['WebAuthn.removeVirtualAuthenticator', { authenticatorId: 'va-2' }],
      ['WebAuthn.addVirtualAuthenticator', { options: expect.objectContaining({ isUserVerified: false }) }],
      ['WebAuthn.setResponseOverrideBits', { authenticatorId: 'va-3', isBadUP: true }],
    ]);
    expect([...authenticators.keys()]).toEqual(['va-3']);
  });

  it('enroll keeps no credential whose rpId does not cover the tab host', async () => {
    const manager = new TabManager();
    const { click } = fakeWebAuthn((creds) => creds.push({
      credentialId: 'cred-x', isResidentCredential: true, rpId: 'evil.example', privateKey: 'KX', signCount: 0,
    }));
    await manager.connectTab(101, 'https://accounts.shopify.com/lookup');

    vi.useFakeTimers();
    try {
      const running = manager.runPasskeyCeremony(101, 'enroll', click);
      await vi.advanceTimersByTimeAsync(PASSKEY_CEREMONY_TIMEOUT_MS + 1_000);
      const { passkey } = await running;
      expect(passkey.ceremony).toBe('timeout');
      expect(stored.agent_jake_passkeys).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('use: offers only the passkeys of the tab host, records the new sign count and puts the guard back', async () => {
    stored.agent_jake_passkeys = [
      { credentialId: 'cred-1', rpId: 'accounts.shopify.com', privateKey: 'K1', signCount: 3, isResidentCredential: true, enrolledAt: 't0' },
      { credentialId: 'cred-2', rpId: 'github.com', privateKey: 'K2', signCount: 1, isResidentCredential: true, enrolledAt: 't0' },
    ];
    const manager = new TabManager();
    const { click } = fakeWebAuthn((creds) => { creds[0].signCount = 4; });
    await manager.connectTab(101, 'https://accounts.shopify.com/lookup');
    mockChrome.debugger.sendCommand.mockClear();

    const { passkey } = await manager.runPasskeyCeremony(101, 'use', click);

    expect(passkey.ceremony).toBe('completed');
    const added = webauthnCalls().filter(([method]) => method === 'WebAuthn.addCredential');
    expect(added.map(([, p]) => (p.credential as { credentialId: string }).credentialId)).toEqual(['cred-1']);
    const saved = stored.agent_jake_passkeys as Array<{ credentialId: string; signCount: number }>;
    expect(saved.find((p) => p.credentialId === 'cred-1')?.signCount).toBe(4);
    expect(webauthnCalls().at(-1)).toEqual(['WebAuthn.setResponseOverrideBits', { authenticatorId: 'va-3', isBadUP: true }]);
  });

  it('use without an enrolled passkey fails before touching the guard', async () => {
    const manager = new TabManager();
    const { click } = fakeWebAuthn(() => undefined);
    await manager.connectTab(101, 'https://accounts.shopify.com/lookup');
    mockChrome.debugger.sendCommand.mockClear();

    await expect(manager.runPasskeyCeremony(101, 'use', click)).rejects.toThrow('No agent passkey enrolled for accounts.shopify.com');
    expect(click).not.toHaveBeenCalled();
    expect(webauthnCalls()).toEqual([]);
  });

  it('a site that never asks times out and still gets the guard back', async () => {
    vi.useFakeTimers();
    try {
      const manager = new TabManager();
      const { click } = fakeWebAuthn(() => undefined);
      await manager.connectTab(101, 'https://accounts.shopify.com/lookup');
      mockChrome.debugger.sendCommand.mockClear();

      const running = manager.runPasskeyCeremony(101, 'enroll', click);
      await vi.advanceTimersByTimeAsync(PASSKEY_CEREMONY_TIMEOUT_MS + 1_000);
      const { passkey } = await running;

      expect(passkey.ceremony).toBe('timeout');
      expect(stored.agent_jake_passkeys).toBeUndefined();
      expect(webauthnCalls().at(-1)).toEqual(['WebAuthn.setResponseOverrideBits', { authenticatorId: 'va-3', isBadUP: true }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reinstalls the guard when putting it back fails, and says so if that fails too', async () => {
    const manager = new TabManager();
    const { click } = fakeWebAuthn((creds) => creds.push({
      credentialId: 'cred-9', isResidentCredential: true, rpId: 'accounts.shopify.com', privateKey: 'K9', signCount: 0,
    }));
    await manager.connectTab(101, 'https://accounts.shopify.com/lookup');
    const base = mockChrome.debugger.sendCommand.getMockImplementation()!;
    let guards = 0;
    mockChrome.debugger.sendCommand.mockImplementation(async (debuggee, method, params) => {
      const options = (params as { options?: { isUserVerified?: boolean } } | undefined)?.options;
      if (method === 'WebAuthn.addVirtualAuthenticator' && options?.isUserVerified === false) {
        guards += 1;
        throw new Error('WebAuthn domain gone');
      }
      return base(debuggee, method, params);
    });

    const { passkey } = await manager.runPasskeyCeremony(101, 'enroll', click);

    expect(guards).toBe(2); // the quick restore, then the full reinstall
    expect(passkey).toEqual(expect.objectContaining({ ceremony: 'completed', guardRestored: false }));
  });

  it('puts the guard back when the click itself fails', async () => {
    const manager = new TabManager();
    fakeWebAuthn(() => undefined);
    await manager.connectTab(101, 'https://accounts.shopify.com/lookup');
    mockChrome.debugger.sendCommand.mockClear();

    await expect(manager.runPasskeyCeremony(101, 'enroll', async () => { throw new Error('element not found'); }))
      .rejects.toThrow('element not found');
    expect(webauthnCalls().slice(-3)).toEqual([
      ['WebAuthn.removeVirtualAuthenticator', { authenticatorId: 'va-2' }],
      ['WebAuthn.addVirtualAuthenticator', { options: expect.objectContaining({ isUserVerified: false }) }],
      ['WebAuthn.setResponseOverrideBits', { authenticatorId: 'va-3', isBadUP: true }],
    ]);
  });

  it('makes the tab the active one of its window for the ceremony and gives the previous one back', async () => {
    // Chrome refuses WebAuthn with «the page does not have focus» from a tab that is not active in its window, focus
    // emulation or not (webauthn.io, 05-10-2026).
    mockChrome.tabs.get.mockResolvedValue({ id: 101, active: false, windowId: 7, url: 'https://accounts.shopify.com/lookup' });
    mockChrome.tabs.query.mockResolvedValue([{ id: 55, active: true, windowId: 7 }]);
    const manager = new TabManager();
    const { click } = fakeWebAuthn((creds) => creds.push({
      credentialId: 'cred-f', isResidentCredential: true, rpId: 'accounts.shopify.com', privateKey: 'KF', signCount: 0,
    }));
    await manager.connectTab(101, 'https://accounts.shopify.com/lookup');
    mockChrome.tabs.update.mockClear();

    await manager.runPasskeyCeremony(101, 'enroll', click);

    expect(mockChrome.tabs.query).toHaveBeenCalledWith({ active: true, windowId: 7 });
    expect(mockChrome.tabs.update.mock.calls).toEqual([[101, { active: true }], [55, { active: true }]]);
  });

  it('if the tab cannot be activated, the guard is never taken off', async () => {
    mockChrome.tabs.get.mockResolvedValue({ id: 101, active: false, windowId: 7, url: 'https://accounts.shopify.com/lookup' });
    mockChrome.tabs.query.mockResolvedValue([{ id: 55, active: true, windowId: 7 }]);
    const manager = new TabManager();
    const { click } = fakeWebAuthn(() => undefined);
    await manager.connectTab(101, 'https://accounts.shopify.com/lookup');
    mockChrome.debugger.sendCommand.mockClear();
    mockChrome.tabs.update.mockRejectedValueOnce(new Error('No tab with id: 101'));

    await expect(manager.runPasskeyCeremony(101, 'enroll', click)).rejects.toThrow('No tab with id');
    expect(click).not.toHaveBeenCalled();
    expect(webauthnCalls()).toEqual([]);
  });

  it('an already active tab is left as it is', async () => {
    mockChrome.tabs.get.mockResolvedValue({ id: 101, active: true, windowId: 7, url: 'https://accounts.shopify.com/lookup' });
    const manager = new TabManager();
    const { click } = fakeWebAuthn(() => undefined);
    await manager.connectTab(101, 'https://accounts.shopify.com/lookup');
    mockChrome.tabs.update.mockClear();
    vi.useFakeTimers();
    try {
      const running = manager.runPasskeyCeremony(101, 'enroll', click);
      await vi.advanceTimersByTimeAsync(PASSKEY_CEREMONY_TIMEOUT_MS + 1_000);
      await running;
    } finally {
      vi.useRealTimers();
    }
    expect(mockChrome.tabs.update).not.toHaveBeenCalled();
  });

  it('refuses a page that is not https', async () => {
    const manager = new TabManager();
    const { click } = fakeWebAuthn(() => undefined);
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Plain', url: 'http://example.com/' });
    await manager.connectTab(101, 'http://example.com/');

    await expect(manager.runPasskeyCeremony(101, 'enroll', click)).rejects.toThrow('Passkeys need an https page');
    expect(click).not.toHaveBeenCalled();
  });
});

// INFRA-699: a page that never finishes loading must not hang new_tab, navigate or reload.
describe('TabManager bounded load waits (INFRA-699)', () => {
  type Listener = (...args: unknown[]) => void;
  type ChromeEvent = { addListener: Mock; removeListener: Mock };
  type Tracked<T> = { state: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown };
  /** The bound the spec fixes (criteria 1 and 4), written out so a changed constant is caught. */
  const GIVE_UP_MS = 20_000;
  /** Hang probe, in fake ms: a wait still pending after this long is hung. */
  const PROBE_MS = 25_000;
  const URL_THAT_HANGS = 'https://slow.example/hang';

  /** Follow a promise without awaiting it: a hang is a failed assertion, never a stuck runner. */
  function track<T>(promise: Promise<T>): Tracked<T> {
    const out: Tracked<T> = { state: 'pending' };
    promise.then(
      (value) => { out.state = 'resolved'; out.value = value; },
      (error) => { out.state = 'rejected'; out.error = error; },
    );
    return out;
  }

  /** A wait that never sees its page load: pending up to the bound, answered by the hang probe. */
  async function advanceThroughTheBound(answer: Tracked<unknown>) {
    await vi.advanceTimersByTimeAsync(GIVE_UP_MS - 1);
    expect(answer.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(PROBE_MS - GIVE_UP_MS + 1);
  }

  /** The chrome events a load wait listens to, keeping who is still subscribed. */
  function wireLoadEvents() {
    const live = { updated: new Set<Listener>(), removed: new Set<Listener>(), dcl: new Set<Listener>() };
    const wire = (event: ChromeEvent, set: Set<Listener>) => {
      event.addListener.mockImplementation((fn: Listener) => { set.add(fn); });
      event.removeListener.mockImplementation((fn: Listener) => { set.delete(fn); });
    };
    wire(mockChrome.tabs.onUpdated, live.updated);
    wire(mockChrome.tabs.onRemoved, live.removed);
    wire(mockChrome.webNavigation.onDOMContentLoaded, live.dcl);
    const fire = (set: Set<Listener>, ...args: unknown[]) => [...set].forEach((fn) => fn(...args));
    return {
      leaked: () => live.updated.size + live.removed.size + live.dcl.size,
      complete: (tabId: number) => fire(live.updated, tabId, { status: 'complete' }),
      closed: (tabId: number) => fire(live.removed, tabId, {}),
      domContentLoaded: (details: { tabId: number; frameId: number }) => fire(live.dcl, details),
    };
  }

  /** A tab that is complete until something navigates it, and then never finishes loading. */
  function tabThatNeverCompletes(id: number) {
    let status = 'complete';
    mockChrome.tabs.get.mockImplementation(async () => ({
      id, status, title: '', active: false, url: status === 'complete' ? 'about:blank' : URL_THAT_HANGS,
    }));
    const startLoading = async () => { status = 'loading'; return {}; };
    mockChrome.tabs.update.mockImplementation(startLoading);
    mockChrome.tabs.reload.mockImplementation(startLoading);
    mockChrome.tabs.create.mockResolvedValue({ id, url: 'about:blank', status: 'complete' });
    mockChrome.debugger.attach.mockResolvedValue(undefined);
    mockChrome.debugger.sendCommand.mockImplementation(async (_d, method) =>
      method === 'WebAuthn.addVirtualAuthenticator' ? { authenticatorId: 'va-1' } : { identifier: 's1' });
  }

  function connectedManager(tabId: number) {
    const manager = new TabManager();
    drive(manager, tabId);
    return { manager, handlers: createNavigationHandlers({ tabManager: pinnedToTab(manager, tabId) } as unknown as HandlerContext) };
  }

  let events: ReturnType<typeof wireLoadEvents>;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const fn of [mockChrome.tabs.get, mockChrome.tabs.update, mockChrome.tabs.reload, mockChrome.tabs.create,
      mockChrome.tabs.remove, mockChrome.debugger.attach, mockChrome.debugger.sendCommand]) fn.mockReset();
    events = wireLoadEvents();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    mockChrome.scripting.executeScript.mockReset().mockResolvedValue([]);
    mockChrome.tabs.sendMessage.mockReset().mockResolvedValue(undefined);
    mockChrome.webNavigation.getAllFrames.mockReset().mockResolvedValue([]);
    mockChrome.debugger.detach.mockReset();
  });

  // Criterion 1
  it('createTab answers connected and loaded:false when the URL never completes', async () => {
    tabThatNeverCompletes(9);
    const manager = new TabManager();

    const answer = track(manager.createTab(URL_THAT_HANGS));
    await advanceThroughTheBound(answer);

    expect(answer.state).toBe('resolved');
    expect(answer.value).toMatchObject({ tab: { id: 9, connected: true }, loaded: false });
    expect(mockChrome.tabs.remove).not.toHaveBeenCalled();
    expect(mockChrome.debugger.attach).toHaveBeenCalled();
    expect(mockChrome.tabs.onUpdated.removeListener.mock.calls).toEqual(mockChrome.tabs.onUpdated.addListener.mock.calls);
    expect(mockChrome.tabs.onRemoved.removeListener.mock.calls).toEqual(mockChrome.tabs.onRemoved.addListener.mock.calls);
    expect(events.leaked()).toBe(0);
  });

  // Criterion 2
  describe('waitForTabLoad', () => {
    it('answers at once when the tab is already complete and no event ever comes', async () => {
      mockChrome.tabs.get.mockResolvedValue({ id: 7, status: 'complete' });
      const manager = new TabManager();

      const answer = track(manager.waitForTabLoad(7));
      await vi.advanceTimersByTimeAsync(0);

      expect(answer).toMatchObject({ state: 'resolved', value: true });
      expect(events.leaked()).toBe(0);
    });

    it('answers when a loading tab completes', async () => {
      mockChrome.tabs.get.mockResolvedValue({ id: 7, status: 'loading' });
      const manager = new TabManager();

      const answer = track(manager.waitForTabLoad(7));
      await vi.advanceTimersByTimeAsync(0);
      expect(answer.state).toBe('pending');
      events.complete(8); // another tab's load is not ours
      await vi.advanceTimersByTimeAsync(0);
      expect(answer.state).toBe('pending');
      events.complete(7);
      await vi.advanceTimersByTimeAsync(0);

      expect(answer).toMatchObject({ state: 'resolved', value: true });
      expect(events.leaked()).toBe(0);
    });

    it('rejects when the tab is closed while loading', async () => {
      mockChrome.tabs.get.mockResolvedValue({ id: 7, status: 'loading' });
      const manager = new TabManager();

      const answer = track(manager.waitForTabLoad(7));
      await vi.advanceTimersByTimeAsync(0);
      events.closed(7);
      await vi.advanceTimersByTimeAsync(0);

      expect(answer.state).toBe('rejected');
      expect(events.leaked()).toBe(0);
    });

    it('rejects when the tab does not exist', async () => {
      const gone = new Error('No tab with id: 7');
      mockChrome.tabs.get.mockRejectedValue(gone);
      const manager = new TabManager();

      const answer = track(manager.waitForTabLoad(7));
      await vi.advanceTimersByTimeAsync(0);

      expect(answer.error).toBe(gone);
      expect(events.leaked()).toBe(0);
    });

    it('gives up quietly with loaded:false when the tab stays loading', async () => {
      mockChrome.tabs.get.mockResolvedValue({ id: 7, status: 'loading' });
      const manager = new TabManager();

      const answer = track(manager.waitForTabLoad(7));
      await advanceThroughTheBound(answer);

      expect(answer).toMatchObject({ state: 'resolved', value: false });
      expect(events.leaked()).toBe(0);
    });
  });

  // Criteria 5 and 6, at the manager
  describe('waitForNextTabLoad', () => {
    it('listens before the trigger runs, so a load that ends inside the trigger is not lost', async () => {
      const manager = new TabManager();
      const trigger = vi.fn(async () => { events.complete(7); });

      const answer = track(manager.waitForNextTabLoad(7, trigger));
      await vi.advanceTimersByTimeAsync(0);

      expect(trigger).toHaveBeenCalledOnce();
      expect(answer).toMatchObject({ state: 'resolved', value: true });
      expect(events.leaked()).toBe(0);
    });

    it('does not take a tab that is already complete for the load it is waiting for', async () => {
      mockChrome.tabs.get.mockResolvedValue({ id: 7, status: 'complete' });
      const manager = new TabManager();

      const answer = track(manager.waitForNextTabLoad(7, async () => undefined));
      await advanceThroughTheBound(answer); // pending all the way: the complete tab is not the load it waits for

      expect(answer).toMatchObject({ state: 'resolved', value: false });
      expect(events.leaked()).toBe(0);
    });

    it('rejects with the trigger\'s own error and leaves no listeners', async () => {
      const refused = new Error('Cannot navigate');
      const manager = new TabManager();

      const answer = track(manager.waitForNextTabLoad(7, async () => { throw refused; }));
      await vi.advanceTimersByTimeAsync(0);

      expect(answer.error).toBe(refused);
      expect(events.leaked()).toBe(0);
    });

    it('stops at DOMContentLoaded of the top frame of that tab when asked to', async () => {
      const manager = new TabManager();

      const answer = track(manager.waitForNextTabLoad(7, async () => undefined, TIMEOUTS.TAB_LOAD_WAIT, 'domcontentloaded'));
      await vi.advanceTimersByTimeAsync(0);
      events.domContentLoaded({ tabId: 7, frameId: 3 });
      events.domContentLoaded({ tabId: 8, frameId: 0 });
      await vi.advanceTimersByTimeAsync(0);
      expect(answer.state).toBe('pending');
      events.domContentLoaded({ tabId: 7, frameId: 0 });
      await vi.advanceTimersByTimeAsync(0);

      expect(answer).toMatchObject({ state: 'resolved', value: true });
      expect(events.leaked()).toBe(0);
    });
  });

  // Criteria 3 to 6, at the handlers
  describe('browser_navigate', () => {
    const url = 'http://127.0.0.1:18999/dcl';

    // Criterion 3
    it('with waitUntil domcontentloaded answers at DOMContentLoaded, without waiting for complete', async () => {
      const { handlers } = connectedManager(7);
      mockChrome.tabs.update.mockResolvedValue({});

      const answer = track(handlers.browser_navigate({ url, waitUntil: 'domcontentloaded' }));
      await vi.advanceTimersByTimeAsync(0);
      events.domContentLoaded({ tabId: 7, frameId: 2 });
      events.domContentLoaded({ tabId: 9, frameId: 0 });
      await vi.advanceTimersByTimeAsync(0);
      expect(answer.state).toBe('pending');
      events.domContentLoaded({ tabId: 7, frameId: 0 });
      await vi.advanceTimersByTimeAsync(0);

      expect(answer).toMatchObject({ state: 'resolved', value: { navigated: url, loaded: true } });
      expect(events.leaked()).toBe(0);
    });

    it.each(['load', 'networkidle', undefined] as const)('with waitUntil %s waits for complete, not for DOMContentLoaded', async (waitUntil) => {
      const { handlers } = connectedManager(7);
      mockChrome.tabs.update.mockResolvedValue({});

      const answer = track(handlers.browser_navigate({ url, waitUntil }));
      await vi.advanceTimersByTimeAsync(0);
      events.domContentLoaded({ tabId: 7, frameId: 0 });
      await vi.advanceTimersByTimeAsync(0);
      expect(answer.state).toBe('pending');
      events.complete(7);
      await vi.advanceTimersByTimeAsync(0);

      expect(answer).toMatchObject({ state: 'resolved', value: { navigated: url, loaded: true } });
      expect(events.leaked()).toBe(0);
    });

    // Criterion 4
    it('answers loaded:false when the page never completes', async () => {
      tabThatNeverCompletes(7);
      const { handlers } = connectedManager(7);

      const answer = track(handlers.browser_navigate({ url: URL_THAT_HANGS }));
      await advanceThroughTheBound(answer);

      expect(answer).toMatchObject({ state: 'resolved', value: { navigated: URL_THAT_HANGS, loaded: false } });
      expect(events.leaked()).toBe(0);
    });

    // Criterion 5
    it('does not lose a load that completes while chrome.tabs.update is still running', async () => {
      const { handlers } = connectedManager(7);
      mockChrome.tabs.update.mockImplementation(async () => { events.complete(7); return {}; });

      const answer = track(handlers.browser_navigate({ url }));
      await vi.advanceTimersByTimeAsync(0);

      expect(answer).toMatchObject({ state: 'resolved', value: { navigated: url, loaded: true } });
      expect(events.leaked()).toBe(0);
    });

    // Criterion 6
    it('rejects with the very error chrome.tabs.update raised and leaves no listeners', async () => {
      const { handlers } = connectedManager(7);
      const refused = new Error('Cannot navigate');
      mockChrome.tabs.update.mockRejectedValue(refused);

      const answer = track(handlers.browser_navigate({ url }));
      await vi.advanceTimersByTimeAsync(0);

      expect(answer.error).toBe(refused);
      expect(events.leaked()).toBe(0);
    });
  });

  describe('browser_reload', () => {
    // Criterion 4
    it('answers loaded:false when the page never completes', async () => {
      tabThatNeverCompletes(7);
      const { handlers } = connectedManager(7);

      const answer = track(handlers.browser_reload({}));
      await advanceThroughTheBound(answer);

      expect(answer).toMatchObject({ state: 'resolved', value: { success: true, loaded: false } });
      expect(events.leaked()).toBe(0);
    });

    // Criterion 5
    it('does not lose a load that completes while chrome.tabs.reload is still running', async () => {
      const { handlers } = connectedManager(7);
      mockChrome.tabs.reload.mockImplementation(async () => { events.complete(7); });

      const answer = track(handlers.browser_reload({}));
      await vi.advanceTimersByTimeAsync(0);

      expect(answer).toMatchObject({ state: 'resolved', value: { success: true, loaded: true } });
      expect(events.leaked()).toBe(0);
    });

    // Criterion 6
    it('rejects with the very error chrome.tabs.reload raised and leaves no listeners', async () => {
      const { handlers } = connectedManager(7);
      const refused = new Error('Cannot reload');
      mockChrome.tabs.reload.mockRejectedValue(refused);

      const answer = track(handlers.browser_reload({}));
      await vi.advanceTimersByTimeAsync(0);

      expect(answer.error).toBe(refused);
      expect(events.leaked()).toBe(0);
    });
  });

  // INFRA-699, second round: qa found in a real Chrome that new_tab on a page that never loads answered,
  // and then state, switch_tab, close_tab and even new_tab to another page never did. In Chrome,
  // chrome.scripting.executeScript waits for document_idle unless injectImmediately is set, and a
  // document that never finishes parsing never gets there (measured: scripts/e2e-slow-page.mjs).
  describe('commands that follow a page that never loads', () => {
    const HANG_TAB = 7;
    const OTHER_TAB = 20;
    let tabs: Record<number, 'loading' | 'complete'>;
    let contentScriptIn: Set<number>;

    /** Chrome as measured: executeScript answers on a loading tab only when it injects immediately. */
    function chromeWhereScriptsWaitForTheDocument() {
      contentScriptIn = new Set();
      mockChrome.tabs.get.mockImplementation(async (id: number) => {
        if (!(id in tabs)) throw new Error(`No tab with id: ${id}`);
        return { id, status: tabs[id], url: id === HANG_TAB ? URL_THAT_HANGS : 'about:blank', title: '', active: false };
      });
      mockChrome.scripting.executeScript.mockImplementation(async (injection: { target: { tabId: number }; files?: string[]; injectImmediately?: boolean }) => {
        if (!injection.injectImmediately && tabs[injection.target.tabId] === 'loading') return new Promise(() => undefined);
        if (injection.files) contentScriptIn.add(injection.target.tabId);
        return [{ result: 0 }];
      });
      mockChrome.tabs.sendMessage.mockImplementation(async (id: number) => {
        if (!contentScriptIn.has(id)) throw new Error('Could not establish connection. Receiving end does not exist.');
        return { success: true, data: 'page state' };
      });
      mockChrome.webNavigation.getAllFrames.mockResolvedValue([{ frameId: 0, url: URL_THAT_HANGS }]);
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.detach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockImplementation(async (_d, method) =>
        method === 'WebAuthn.addVirtualAuthenticator' ? { authenticatorId: 'va-1' } : { identifier: 's1' });
      mockChrome.tabs.remove.mockResolvedValue(undefined);
    }

    /** The session as qa had it: a tab connected while blank, then sent to the page that never finishes. */
    async function managerOnTheHangingTab() {
      tabs = { [HANG_TAB]: 'complete' };
      chromeWhereScriptsWaitForTheDocument();
      const manager = new TabManager();
      await manager.connectTab(HANG_TAB);
      tabs[HANG_TAB] = 'loading';
      return manager;
    }

    it('browser_state answers from the half-loaded page', async () => {
      const manager = await managerOnTheHangingTab();
      const handlers = createStateHandlers(createToolContext(pinnedToTab(manager, HANG_TAB)) as unknown as HandlerContext);

      const answer = track(handlers.browser_state({}));
      await vi.advanceTimersByTimeAsync(PROBE_MS);

      expect(answer).toMatchObject({ state: 'resolved', value: { state: 'page state' } });
    });

    it('switch_tab to it answers', async () => {
      const manager = await managerOnTheHangingTab();

      const answer = track(manager.switchTab(HANG_TAB));
      await vi.advanceTimersByTimeAsync(PROBE_MS);

      expect(answer.state).toBe('resolved');
    });

    it('close_tab closes it', async () => {
      const manager = await managerOnTheHangingTab();

      const answer = track(manager.closeTab(HANG_TAB));
      await vi.advanceTimersByTimeAsync(PROBE_MS);

      expect(answer).toMatchObject({ state: 'resolved', value: HANG_TAB });
      expect(mockChrome.tabs.remove).toHaveBeenCalledWith(HANG_TAB);
    });

    it('another tab is connected while the loading one stays driven', async () => {
      const manager = await managerOnTheHangingTab();
      tabs[OTHER_TAB] = 'complete';

      const answer = track(manager.connectTab(OTHER_TAB));
      await vi.advanceTimersByTimeAsync(PROBE_MS);

      expect(answer.state).toBe('resolved');
      expect(manager.drivenTabIds().sort((x, y) => x - y)).toEqual([HANG_TAB, OTHER_TAB]);
    });

    it('new_tab to another page answers while the loading tab is the connected one', async () => {
      const manager = await managerOnTheHangingTab();
      mockChrome.tabs.create.mockImplementation(async () => { tabs[OTHER_TAB] = 'complete'; return { id: OTHER_TAB, url: 'about:blank', status: 'complete' }; });
      mockChrome.tabs.update.mockImplementation(async (id: number) => { events.complete(id); return {}; });

      const answer = track(manager.createTab('https://other.example/ok'));
      await vi.advanceTimersByTimeAsync(PROBE_MS);

      expect(answer).toMatchObject({ state: 'resolved', value: { tab: { id: OTHER_TAB, connected: true }, loaded: true } });
    });

    it('lifting a foreign extension frame does not wait for the page either', async () => {
      await managerOnTheHangingTab();

      const answer = track(purgeForeignExtensionFrames(HANG_TAB));
      await vi.advanceTimersByTimeAsync(PROBE_MS);

      expect(answer.state).toBe('resolved');
    });
  });

  // Criterion 7
  describe('the bound', () => {
    it('is shorter than the server\'s own cut, so the extension always answers first', () => {
      expect(Number.isFinite(TIMEOUTS.TAB_LOAD_WAIT)).toBe(true);
      expect(TIMEOUTS.TAB_LOAD_WAIT).toBeLessThan(TIMEOUTS.REQUEST_TIMEOUT);
    });

    it.each(['createTab', 'browser_navigate', 'browser_reload'] as const)('%s gives up at TAB_LOAD_WAIT: not before, not after', async (which) => {
      expect(Number.isFinite(TIMEOUTS.TAB_LOAD_WAIT)).toBe(true); // a mutated bound must fail here, not hang the fake clock
      tabThatNeverCompletes(7);
      const { manager, handlers } = connectedManager(7);
      const start = {
        createTab: () => manager.createTab(URL_THAT_HANGS),
        browser_navigate: () => handlers.browser_navigate({ url: URL_THAT_HANGS }),
        browser_reload: () => handlers.browser_reload({}),
      }[which];

      const answer = track(start());
      await vi.advanceTimersByTimeAsync(TIMEOUTS.TAB_LOAD_WAIT - 1);
      expect(answer.state).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);

      expect(answer.state).toBe('resolved');
      expect(events.leaked()).toBe(0);
    });
  });
});
