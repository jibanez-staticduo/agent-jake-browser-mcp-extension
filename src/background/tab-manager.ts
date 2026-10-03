/**
 * Manages connected tab state and tab operations.
 * Tracks which tab is currently being automated.
 */

import { log } from '@/utils/logger';
import { logTab, logError } from './activity-log';
import type { TabInfo } from '@/types/messages';
import { DEBUGGER } from '@/constants';
import { pageEvents } from './page-events';

/** chrome.storage.session key holding the ids of the windows created for the agent. */
const AGENT_WINDOWS_KEY = 'ajb.agentWindows';

/**
 * Runs in every document of a controlled tab (see installWebAuthnGuard). Pins
 * navigator.credentials.get/create to CredentialsContainer.prototype — Chrome's own
 * implementation, which a page-world override leaves untouched — so the call reaches the
 * virtual authenticator. The PublicKeyCredential capability checks are pinned too while they
 * are still native.
 *
 * In a document that was already loaded when we got there (a popup, a tab the agent switches
 * to, a cross-site iframe), 1Password has usually made its own get/create non-configurable
 * first. Then the page gets a stand-in container instead: navigator.credentials (a
 * configurable getter on Navigator.prototype) returns an object whose methods run Chrome's
 * implementation on the real container. Idempotent per document.
 *
 * Self-contained on purpose: it is serialized for CDP and injected with chrome.scripting.
 */
export function pinWebAuthn(): void {
  const mark = Symbol.for('agent-jake.webauthn-pinned');
  const nav = window.navigator;
  const creds = nav && (nav.credentials as CredentialsContainer & Record<PropertyKey, unknown>);
  const proto = window.CredentialsContainer && CredentialsContainer.prototype;
  if (!creds || !proto || creds[mark]) return;
  const methods = proto as unknown as Record<string, unknown>;
  for (const name of ['get', 'create']) {
    const native = methods[name];
    try {
      Object.defineProperty(creds, name, { configurable: false, enumerable: true, get: () => native, set: () => {} });
    } catch (_) { /* already non-configurable: the stand-in below takes over */ }
  }
  if (creds.get !== proto.get || creds.create !== proto.create) {
    const standIn = Object.create(proto) as Record<PropertyKey, unknown>;
    for (const name of ['get', 'create', 'store', 'preventSilentAccess']) {
      const native = methods[name];
      if (typeof native !== 'function') continue;
      const call = { [name](...args: unknown[]) { return native.apply(creds, args); } }[name];
      Object.defineProperty(standIn, name, { enumerable: true, value: call });
    }
    Object.defineProperty(standIn, mark, { value: true });
    try {
      Object.defineProperty(nav, 'credentials', { configurable: false, enumerable: true, get: () => standIn });
    } catch (_) { /* navigator.credentials itself is taken: nothing more we can do here */ }
  }
  const pkc = window.PublicKeyCredential as unknown as Record<string, unknown> | undefined;
  if (pkc) {
    for (const name of ['isUserVerifyingPlatformAuthenticatorAvailable', 'isConditionalMediationAvailable', 'getClientCapabilities']) {
      const fn = pkc[name];
      if (typeof fn === 'function' && /\[native code\]/.test(Function.prototype.toString.call(fn))) {
        try { Object.defineProperty(pkc, name, { configurable: false, writable: false, value: fn }); } catch (_) { /* taken */ }
      }
    }
  }
  Object.defineProperty(creds, mark, { value: true });
}

export const WEBAUTHN_PIN_SCRIPT = `(${pinWebAuthn.toString()})();`;

export interface CdpStatus {
  connectedTabId: number | null;
  debuggerAttached: boolean;
  canExecuteCdp: boolean;
  lastCdpError: string | null;
}

/**
 * Chrome refuses every debugger command on a tab that holds a frame of ANOTHER extension
 * ("Cannot access a chrome-extension:// URL of different extension"). Password managers
 * inject exactly that: 1Password's inline autofill menu is a chrome-extension:// iframe that
 * appears on any login page with a saved item, and from then on click/type/evaluate all fail.
 * Removing those frames from the DOM lifts the block; the manager re-creates them on the
 * next focus, so nothing of theirs breaks.
 */
export const FOREIGN_EXTENSION_FRAME_ERROR = 'different extension';

/** chrome.debugger.sendCommand that lifts a foreign-extension-frame block once and retries. */
async function sendCommandLiftingForeignFrames(tabId: number, method: string, params?: { [key: string]: unknown }): Promise<unknown> {
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (error) {
    if (!((error as Error).message ?? '').includes(FOREIGN_EXTENSION_FRAME_ERROR)) throw error;
    await purgeForeignExtensionFrames(tabId).catch(() => 0);
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }
}

export async function purgeForeignExtensionFrames(tabId: number): Promise<number> {
  // Not allFrames: that includes the foreign extension frame itself, and injecting there fails
  // the whole call with the very error we are trying to lift. Web frames only.
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
  const frameIds = frames.filter((f) => /^(https?|file):/.test(f.url)).map((f) => f.frameId);
  if (!frameIds.length) return 0;
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds },
    args: [chrome.runtime.id],
    func: (ownId: string) => {
      let removed = 0;
      const foreign = (src: string) => src.startsWith('chrome-extension://') && !src.startsWith(`chrome-extension://${ownId}/`);
      const sweep = (root: Document | ShadowRoot) => {
        root.querySelectorAll('iframe').forEach((f) => {
          if (foreign(f.src || '')) { f.remove(); removed++; }
        });
        root.querySelectorAll('*').forEach((el) => {
          const tag = el.tagName.toLowerCase();
          if (tag.startsWith('com-1password-')) { el.remove(); removed++; return; }
          if (el.shadowRoot) sweep(el.shadowRoot);
        });
      };
      sweep(document);
      return removed;
    },
  });
  return results.reduce((n, r) => n + (typeof r.result === 'number' ? r.result : 0), 0);
}

export class TabManager {
  private connectedTabId: number | null = null;
  private debuggerAttached = false;
  private captureEvents = false;
  private connectionGeneration = 0;
  private disconnecting = false;
  private lastCdpError: string | null = null;
  private pendingNewTab: TabInfo | null = null;
  private newTabListener: ((tab: chrome.tabs.Tab) => void) | null = null;
  private fileChooserInProgress = false;
  private webauthnPinScript: { tabId: number; identifier: string } | null = null;
  private frameCommitListener: ((details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => void) | null = null;

  /**
   * Initialize tab manager, restoring state from storage.
   */
  async initialize(): Promise<void> {
    // Chrome swaps a tab for a new one (new id) on prerender activation and similar: without
    // following it, every command after that answers "No tab with id" on a tab that is open.
    chrome.tabs.onReplaced?.addListener((addedTabId, removedTabId) => {
      if (this.connectedTabId !== removedTabId) return;
      log.info(`Connected tab ${removedTabId} was replaced by ${addedTabId}; following it`);
      this.connectedTabId = addedTabId;
      this.debuggerAttached = false;
      void chrome.storage.local.set({ [DEBUGGER.STORAGE_KEY]: addedTabId });
    });

    const stored = await chrome.storage.local.get(DEBUGGER.STORAGE_KEY);
    if (stored[DEBUGGER.STORAGE_KEY]) {
      const tabId = stored[DEBUGGER.STORAGE_KEY] as number;
      // Verify tab still exists
      if (await this.tabExists(tabId)) {
        this.connectedTabId = tabId;
        await this.setLiveConnectionCloseGuard(tabId, true);
        log.info(`Restored connected tab: ${tabId}`);
      } else {
        await chrome.storage.local.remove(DEBUGGER.STORAGE_KEY);
      }
    }
  }

  /**
   * Get the currently connected tab ID.
   */
  getConnectedTabId(): number | null {
    return this.connectedTabId;
  }

  /**
   * Return live CDP readiness for diagnostics and preflight checks.
   * Attempts a self-heal attach when possible.
   */
  async getCdpStatus(): Promise<CdpStatus> {
    const tabId = this.connectedTabId;
    if (!tabId) {
      return {
        connectedTabId: null,
        debuggerAttached: false,
        canExecuteCdp: false,
        lastCdpError: this.lastCdpError ?? 'CDP_NOT_READY: No tab connected',
      };
    }

    let attached = await this.isDebuggerAttached(tabId);
    if (!attached) {
      try {
        await this.attachDebugger(tabId);
        attached = await this.isDebuggerAttached(tabId);
      } catch (error) {
        this.recordCdpError(error);
      }
    }

    if (!attached) {
      return {
        connectedTabId: tabId,
        debuggerAttached: false,
        canExecuteCdp: false,
        lastCdpError: this.lastCdpError ?? `CDP_NOT_READY: Debugger is not attached to tab ${tabId}`,
      };
    }

    const probe = await this.probeCdp(tabId);

    return {
      connectedTabId: tabId,
      debuggerAttached: true,
      canExecuteCdp: probe.ok,
      lastCdpError: probe.error,
    };
  }

  /**
   * Connect to a specific tab for automation.
   * If tabUrl is chrome://newtab/, navigates to about:blank first.
   */
  async connectTab(tabId: number, tabUrl?: string): Promise<void> {
    // If tab is chrome://newtab/, navigate to about:blank first
    // (Chrome blocks extensions from accessing chrome:// URLs)
    if (tabUrl === 'chrome://newtab/') {
      await chrome.tabs.update(tabId, { url: 'about:blank' });
      await this.waitForTabLoad(tabId);
    }

    // Disconnect previous tab if any
    if (this.connectedTabId && this.connectedTabId !== tabId) {
      await this.disconnectTab();
    }

    // Verify tab exists
    if (!await this.tabExists(tabId)) {
      await logError('tab_connect', `Tab ${tabId} does not exist`, { tabId });
      throw new Error(`Tab ${tabId} does not exist`);
    }

    try {
      // Attach debugger
      if (this.connectedTabId !== tabId) pageEvents.reset(); // another tab: its history is not ours
      await this.attachDebugger(tabId);

      this.connectedTabId = tabId;
      this.captureEvents = true;
      await chrome.storage.local.set({ [DEBUGGER.STORAGE_KEY]: tabId });

      // Get tab info for logging
      const tab = await chrome.tabs.get(tabId);
      const title = tab.title || tab.url || `Tab ${tabId}`;
      await this.setLiveConnectionCloseGuard(tabId, true);

      log.info(`Connected to tab: ${tabId}`);
      await logTab('tab_connect', `Connected to: ${title}`, true, { tabId, url: tab.url });
    } catch (error) {
      await logError('tab_connect', `Failed to connect: ${(error as Error).message}`, { tabId });
      throw error;
    }
  }

  /**
   * Disconnect from the current tab.
   */
  async disconnectTab(): Promise<void> {
    this.captureEvents = false;
    this.cancelEventWaiters();
    pageEvents.reset();
    if (!this.connectedTabId) {
      return;
    }

    this.disconnecting = true;
    const tabId = this.connectedTabId;
    if (this.frameCommitListener) {
      chrome.webNavigation.onCommitted.removeListener(this.frameCommitListener);
      this.frameCommitListener = null;
    }
    try {
      await this.setLiveConnectionCloseGuard(tabId, false);
    } finally {
      await this.detachDebugger();
      this.connectedTabId = null;
      this.cancelEventWaiters();
      pageEvents.reset();
      this.disconnecting = false;
      await chrome.storage.local.remove(DEBUGGER.STORAGE_KEY);
    }

    log.info(`Disconnected from tab: ${tabId}`);
    await logTab('tab_disconnect', `Disconnected from tab ${tabId}`, true, { tabId });
  }

  /** Whether a tab still exists (routeToTargetTab checks before connecting). */
  async hasTab(tabId: number): Promise<boolean> {
    return this.tabExists(tabId);
  }

  /**
   * Check if a tab exists.
   */
  private async tabExists(tabId: number): Promise<boolean> {
    try {
      await chrome.tabs.get(tabId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if debugger is actually attached to a tab.
   * Uses chrome.debugger.getTargets() for accurate state.
   */
  /**
   * Are *we* attached to that tab? `getTargets()[].attached` cannot answer: it is true for
   * any attached client — DevTools, another extension, a Playwright `connectOverCDP` — and
   * not only for us. The one thing that tells our client apart is Chrome accepting a
   * command from it; `Runtime.enable` is idempotent and is what we send next anyway.
   */
  private async isDebuggerAttached(tabId: number): Promise<boolean> {
    try {
      await sendCommandLiftingForeignFrames(tabId, 'Runtime.enable');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Attach debugger to tab for input simulation.
   *
   * We always try the attach, because Chrome allows several debugger clients on the same
   * tab and grants us one even when DevTools or a CDP client already holds it. Only when
   * Chrome answers "Another debugger" is there a question of whose it is, and a command —
   * not the target list — is what answers it.
   */
  private async attachDebugger(tabId: number): Promise<void> {
    this.captureEvents = false;
    this.cancelEventWaiters();
    pageEvents.reset();
    this.debuggerAttached = false;

    try {
      log.info(`Attaching debugger to tab ${tabId}...`);
      try {
        await chrome.debugger.attach({ tabId }, DEBUGGER.PROTOCOL_VERSION);
      } catch (error) {
        if (!((error as Error).message ?? '').includes(FOREIGN_EXTENSION_FRAME_ERROR)) throw error;
        const removed = await purgeForeignExtensionFrames(tabId).catch(() => 0);
        log.warn(`Foreign extension frame blocked the attach to tab ${tabId}; removed ${removed}, retrying`);
        await chrome.debugger.attach({ tabId }, DEBUGGER.PROTOCOL_VERSION);
      }
      this.debuggerAttached = true;
      this.lastCdpError = null;
      log.info(`Debugger attached to tab ${tabId}`);
    } catch (error) {
      const message = (error as Error).message ?? '';
      if (message.includes('Another debugger') || message.includes('Already attached')) {
        // Either the client holding it is us (then commands work), or it is DevTools.
        if (await this.isDebuggerAttached(tabId)) {
          this.debuggerAttached = true;
          this.lastCdpError = null;
          log.debug(`Debugger was already ours on tab ${tabId}`);
        } else {
          const typedError = new Error(`CDP_DEBUGGER_BUSY: ${message}`);
          this.recordCdpError(typedError);
          log.warn('Debugger already attached by another client');
          throw typedError;
        }
      } else {
        log.error('Failed to attach debugger:', error);
        this.recordCdpError(error);
        throw error;
      }
    }

    // Always enable domains after attaching or detecting existing attachment
    // These calls are idempotent (safe to call multiple times)
    await this.enableDebuggerDomains(tabId);
    if (this.connectedTabId === tabId) this.captureEvents = true;
  }

  /**
   * Enable required debugger protocol domains.
   */
  private async enableDebuggerDomains(tabId: number): Promise<void> {
    for (const domain of ['Runtime', 'Page', 'DOM'] as const) {
      try {
        await sendCommandLiftingForeignFrames(tabId, `${domain}.enable`);
        log.info(`${domain} domain enabled`);
      } catch (enableError) {
        this.recordCdpError(enableError);
        throw new Error(`CDP_NOT_READY: Failed to enable ${domain} domain: ${(enableError as Error).message}`);
      }
    }

    // Console and network capture (see page-events.ts). Not fatal: input keeps working
    // without them, only browser_network_requests / console come back empty.
    for (const domain of ['Network', 'Log'] as const) {
      try {
        await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`);
      } catch (enableError) {
        log.warn(`${domain} domain not enabled:`, enableError);
      }
    }

    // A hidden tab gets no CDP mouse/key input at all (Chrome, measured with an http page: 0
    // events, while the tools answered "clicked"/"typed") and paints lazily. With focus
    // emulation the page counts as visible and focused: it gets the input and paints for the
    // capture, so nothing has to bring the agent's tab in front of the user.
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch (error) {
      log.warn('Focus emulation not enabled: input to a hidden tab will be lost', error);
    }

    await this.installWebAuthnGuard(tabId);
    await this.installDialogAutoAccept(tabId);
  }

  /**
   * An agent cannot touch a security key, so a WebAuthn request (passkey, security-key 2FA)
   * must not raise Chrome's native "Use your security key" dialog: it covers the page, waits
   * for a hand nobody will lend and keeps the site from offering its other method — the
   * authenticator-app code that browser_fill_secret types from 1Password.
   *
   * With the native UI off and one virtual authenticator that holds no credential, every
   * navigator.credentials call fails at once with NotAllowedError and the site falls back.
   * The authenticator verifies no user and its responses carry no user presence, so it cannot
   * register a passkey either. It lives on the tab, across navigations, until we detach.
   *
   * A password-manager extension (1Password) replaces navigator.credentials.get/create in the
   * page and keeps for itself the requests that name no account (discoverable passkey sign-in,
   * registration): they wait on its own unlock UI forever and never reach the authenticator
   * above. WEBAUTHN_PIN_SCRIPT hands those entry points back to Chrome's own implementation in
   * every document of the tab, before the extension's content script runs, and in the document
   * already loaded. Not fatal: without it only the native dialog comes back.
   */
  private async installWebAuthnGuard(tabId: number): Promise<void> {
    const target = { tabId };
    try {
      // Dropping the previous session's authenticator keeps a re-attach at exactly one.
      await chrome.debugger.sendCommand(target, 'WebAuthn.disable').catch(() => undefined);
      await chrome.debugger.sendCommand(target, 'WebAuthn.enable', { enableUI: false });
      const { authenticatorId } = await chrome.debugger.sendCommand(target, 'WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          transport: 'usb',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: false,
          automaticPresenceSimulation: true,
        },
      }) as { authenticatorId: string };
      await chrome.debugger.sendCommand(target, 'WebAuthn.setResponseOverrideBits', { authenticatorId, isBadUP: true });

      // One copy per session: a re-attach on the same session would otherwise stack them.
      if (this.webauthnPinScript?.tabId === tabId) {
        await chrome.debugger.sendCommand(target, 'Page.removeScriptToEvaluateOnNewDocument', {
          identifier: this.webauthnPinScript.identifier,
        }).catch(() => undefined);
      }
      const { identifier } = await chrome.debugger.sendCommand(target, 'Page.addScriptToEvaluateOnNewDocument', {
        source: WEBAUTHN_PIN_SCRIPT,
        runImmediately: true,
      }) as { identifier: string };
      this.webauthnPinScript = { tabId, identifier };

      // CDP scripts only reach the tab's own process; cross-site iframes get the pin through
      // chrome.scripting, now and whenever one commits a document.
      if (!this.frameCommitListener) {
        this.frameCommitListener = (details) => {
          if (details.tabId === this.connectedTabId && details.frameId !== 0) {
            void this.pinWebAuthnInFrames(details.tabId, [details]);
          }
        };
        chrome.webNavigation.onCommitted.addListener(this.frameCommitListener);
      }
      await this.pinWebAuthnInFrames(tabId);
    } catch (error) {
      log.warn('WebAuthn guard not installed, native security-key dialogs may appear:', error);
    }
  }

  /**
   * Run pinWebAuthn in the tab's web frames (all of them, or the ones given). Not allFrames:
   * a foreign extension frame (1Password's) fails the whole call, so web frames only.
   */
  private async pinWebAuthnInFrames(tabId: number, frames?: Array<{ frameId: number; url: string }>): Promise<void> {
    try {
      const candidates = frames ?? (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
      const frameIds = candidates.filter((f) => /^https?:/.test(f.url)).map((f) => f.frameId);
      if (!frameIds.length) return;
      await chrome.scripting.executeScript({
        target: { tabId, frameIds },
        world: 'MAIN',
        injectImmediately: true,
        func: pinWebAuthn,
      });
    } catch (error) {
      log.debug('WebAuthn pin not injected in frames:', error);
    }
  }

  /** Only one upload may consume the next file chooser event. */
  beginFileChooser(): void {
    if (this.disconnecting) throw new Error('Tab is disconnecting');
    if (this.fileChooserInProgress) throw new Error('A file chooser upload is already in progress');
    this.fileChooserInProgress = true;
  }

  endFileChooser(): void {
    this.fileChooserInProgress = false;
  }

  private cancelEventWaiters(): void {
    this.connectionGeneration++;
    for (const waiter of [...this.eventWaiters]) {
      waiter.reject(new Error('Debugger event wait canceled because the tab changed or detached'));
    }
  }

  async setChooserFiles(tabId: number, backendNodeId: number, files: string[]): Promise<void> {
    if (this.disconnecting || this.connectedTabId !== tabId) throw new Error('Tab changed during file upload');
    // Pin the command to the original tab; reattachment would invalidate the chooser node.
    await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', { backendNodeId, files });
  }

  async setFileChooserInterception(tabId: number, enabled: boolean): Promise<void> {
    if (enabled && (this.disconnecting || this.connectedTabId !== tabId)) throw new Error('Tab changed during file upload');
    await chrome.debugger.sendCommand({ tabId }, 'Page.setInterceptFileChooserDialog', { enabled });
  }

  /** Resolve with the next matching event from the connected tab. */
  waitForDebuggerEvent<T = Record<string, unknown>>(method: string, timeout = 10000, signal?: AbortSignal): Promise<T> {
    const tabId = this.connectedTabId;
    if (tabId === null || this.disconnecting) return Promise.reject(new Error('No connected tab for debugger event wait'));
    const generation = this.connectionGeneration;
    return new Promise<T>((resolve, reject) => {
      const waiter = { method, tabId, generation, resolve: (params: unknown) => {
        cleanup();
        resolve(params as T);
      }, reject: (error: Error) => {
        cleanup();
        reject(error);
      } };
      const cleanup = () => {
        clearTimeout(timer);
        this.eventWaiters.delete(waiter);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(new Error(`Stopped waiting for ${method}`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out after ${timeout}ms waiting for ${method}`));
      }, timeout);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.eventWaiters.add(waiter);
    });
  }

  private eventWaiters = new Set<{
    method: string; tabId: number; generation: number;
    resolve: (params: unknown) => void; reject: (error: Error) => void;
  }>();

  private async installDialogAutoAccept(tabId: number): Promise<void> {
    const debuggerTarget = { tabId };

    chrome.debugger.onEvent.removeListener(this.handleDebuggerEvent);
    chrome.debugger.onEvent.addListener(this.handleDebuggerEvent);

    try {
      await chrome.debugger.sendCommand(debuggerTarget, 'Page.setInterceptFileChooserDialog', { enabled: false });
    } catch {
      // Not all Chrome versions expose this command; dialog auto-accept below is enough.
    }
  }

  private handleDebuggerEvent = async (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object
  ): Promise<void> => {
    if (!this.connectedTabId || source.tabId !== this.connectedTabId) {
      return;
    }

    if (this.captureEvents) pageEvents.handle(method, params as Record<string, unknown> | undefined);

    for (const waiter of this.eventWaiters) {
      if (waiter.method === method && waiter.tabId === source.tabId && waiter.generation === this.connectionGeneration) {
        waiter.resolve(params ?? {});
      }
    }

    if (method !== 'Page.javascriptDialogOpening') {
      return;
    }

    const eventParams = params as { type?: string } | undefined;
    const dialogType = String(eventParams?.type || '');
    const accept = dialogType === 'beforeunload' || dialogType === 'confirm' || dialogType === 'alert';

    try {
      await chrome.debugger.sendCommand(
        { tabId: this.connectedTabId },
        'Page.handleJavaScriptDialog',
        { accept }
      );
      log.info(`[Dialog] Auto-handled ${dialogType || 'javascript'} dialog`);
    } catch (error) {
      log.warn('[Dialog] Failed to auto-handle JavaScript dialog:', error);
    }
  };

  /**
   * Detach debugger from tab.
   */
  private async detachDebugger(): Promise<void> {
    if (!this.connectedTabId) {
      return;
    }

    // Always reset flag
    this.debuggerAttached = false;
    this.webauthnPinScript = null; // the session's scripts go with it

    try {
      chrome.debugger.onEvent.removeListener(this.handleDebuggerEvent);
      await chrome.debugger.detach({ tabId: this.connectedTabId });
      log.debug('Debugger detached');
    } catch (error) {
      // May already be detached
      log.warn('Failed to detach debugger:', error);
    }
  }

  /**
   * Reattach debugger to the connected tab.
   * Called when debugger is unexpectedly detached.
   */
  async reattachDebugger(): Promise<void> {
    if (!this.connectedTabId) {
      throw new Error('No tab connected');
    }

    // Mark as detached so attachDebugger will do full attach
    this.debuggerAttached = false;

    await this.attachDebugger(this.connectedTabId);
    log.info(`[TabManager] Debugger reattached to tab ${this.connectedTabId}`);
  }

  /**
   * Mark debugger as detached (called from onDetach listener).
   */
  markDebuggerDetached(): void {
    this.captureEvents = false;
    this.cancelEventWaiters();
    pageEvents.reset();
    this.debuggerAttached = false;
    this.webauthnPinScript = null;
    this.lastCdpError = 'CDP_DEBUGGER_DETACHED: Debugger detached unexpectedly';
  }

  /**
   * Send a debugger command to the connected tab.
   * Auto-reattaches debugger if it has been detached.
   */
  async sendDebuggerCommand<T>(
    method: string,
    params?: Record<string, unknown>,
    timeout: number = 25000 // 25 seconds default timeout (less than WS timeout of 30s)
  ): Promise<T> {
    if (!this.connectedTabId) {
      throw new Error('No tab connected');
    }

    let retriedAfterDetach = false;
    let retriedAfterPurge = false;

    while (true) {
      // Check actual debugger state (not just our flag) and reattach if needed
      const attached = await this.isDebuggerAttached(this.connectedTabId);
      if (!attached) {
        log.warn(`[sendDebuggerCommand] Debugger detached, reattaching to tab ${this.connectedTabId}...`);
        await this.attachDebugger(this.connectedTabId);
      }

      log.debug(`[sendDebuggerCommand] Executing ${method}`, {
        tabId: this.connectedTabId,
        hasParams: params !== undefined,
      });

      // Wrap Chrome's debugger command in a timeout
      const commandPromise = chrome.debugger.sendCommand(
        { tabId: this.connectedTabId },
        method,
        params
      ) as Promise<T>;

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Debugger command timed out after ${timeout}ms: ${method}`));
        }, timeout);
      });

      try {
        const result = await Promise.race([commandPromise, timeoutPromise]);
        this.lastCdpError = null;
        log.debug(`[sendDebuggerCommand] ${method} completed successfully`);
        return result;
      } catch (error) {
        const message = (error as Error)?.message || String(error);
        this.recordCdpError(error);
        log.error(`[sendDebuggerCommand] ${method} failed:`, error);

        if (message.includes(FOREIGN_EXTENSION_FRAME_ERROR) && !retriedAfterPurge) {
          retriedAfterPurge = true;
          const removed = await purgeForeignExtensionFrames(this.connectedTabId).catch(() => 0);
          log.warn(`[sendDebuggerCommand] foreign extension frame blocked ${method}; removed ${removed}, retrying`);
          continue;
        }

        if (message.includes('Debugger is not attached')) {
          if (retriedAfterDetach) {
            throw new Error(`CDP_NOT_READY: ${message}`);
          }

          retriedAfterDetach = true;
          await this.attachDebugger(this.connectedTabId);
          continue;
        }

        throw error;
      }
    }
  }

  private recordCdpError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.lastCdpError = message;
  }

  private async probeCdp(tabId: number): Promise<{ ok: true; error: null } | { ok: false; error: string }> {
    try {
      await chrome.debugger.sendCommand(
        { tabId },
        'Runtime.evaluate',
        { expression: '1+1', returnByValue: true }
      );
      this.lastCdpError = null;
      return { ok: true, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordCdpError(error);
      return { ok: false, error: message };
    }
  }

  /**
   * List all open tabs.
   * Only marks a tab as "active" if it's the active tab in the last focused normal window.
   */
  async listTabs(): Promise<TabInfo[]> {
    // Get the active tab in the last focused window (most reliable method)
    const currentTab = (await chrome.tabs.query({ lastFocusedWindow: true })).find((t) => t.active);
    const currentTabId = currentTab?.id;

    const tabs = await chrome.tabs.query({});

    return tabs.map(tab => ({
      id: tab.id!,
      url: tab.url || '',
      title: tab.title || '',
      // Only mark the specific current tab as active
      active: tab.id === currentTabId,
      connected: tab.id === this.connectedTabId,
      windowId: tab.windowId,
    }));
  }

  /**
   * Create a new tab and optionally connect to it.
   *
   * It opens in the BACKGROUND, in a window of its own unless `windowId` names a window this
   * extension already created for the agent (see openTab). Nothing here brings a tab or a window
   * to the front: the user's view is never touched.
   */
  async createTab(url: string, connect = true, windowId?: number): Promise<TabInfo & { windowCreated: boolean }> {
    // The WebAuthn guard's page script only beats a password manager's content script in
    // documents created after we attach (see installWebAuthnGuard). So a tab we are going to
    // drive opens blank, we attach, and only then does it load the URL.
    const guardFirst = connect && /^https?:/i.test(url);
    const { tab, windowCreated } = await this.openTab(guardFirst ? 'about:blank' : url, windowId);

    if (connect && tab.id) {
      if (guardFirst) {
        await this.whenTabComplete(tab.id, false);
        await this.connectTab(tab.id);
        const loaded = this.whenTabComplete(tab.id, true);
        try {
          await chrome.tabs.update(tab.id, { url });
        } catch (error) {
          // Do not leave a connected about:blank behind (nor an empty window of ours).
          await chrome.tabs.remove(tab.id).catch(() => undefined);
          throw error;
        }
        await loaded;
      } else {
        // Wait for tab to finish loading
        await this.waitForTabLoad(tab.id);
        await this.connectTab(tab.id);
      }
    }

    const current = guardFirst && tab.id ? await chrome.tabs.get(tab.id).catch(() => tab) : tab;
    return {
      id: tab.id!,
      url: current.url || url,
      title: current.title || '',
      active: current.active,
      connected: connect && tab.id === this.connectedTabId,
      windowId: tab.windowId,
      windowCreated,
    };
  }

  /**
   * Open a tab for the agent without focusing anything. With no `windowId`, or one that is not
   * a live window of ours, a new unfocused window is created and its only tab is the result (no
   * empty tab is left behind); with a live window of ours the tab joins it as a background tab.
   * Only windows we created are reused, so the agent never opens into one of the user's.
   */
  private async openTab(url: string, windowId?: number): Promise<{ tab: chrome.tabs.Tab; windowCreated: boolean }> {
    if (windowId !== undefined && (await this.isAgentWindow(windowId)) && (await this.windowExists(windowId))) {
      const tab = await chrome.tabs.create({ windowId, url, active: false });
      return { tab, windowCreated: false };
    }
    if (windowId !== undefined) await this.forgetAgentWindow(windowId);

    const created = await chrome.windows.create({ url, focused: false, state: 'normal' });
    const tab = created?.tabs?.[0];
    if (created?.id === undefined || !tab) {
      throw new Error('chrome.windows.create returned no window or tab');
    }
    await this.rememberAgentWindow(created.id);
    return { tab, windowCreated: true };
  }

  private async windowExists(windowId: number): Promise<boolean> {
    try {
      await chrome.windows.get(windowId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Windows this extension created for the agent. They live in chrome.storage.session because
   * the MV3 service worker restarts; the in-memory copy is only the fallback when that storage
   * is unavailable.
   */
  private agentWindows = new Set<number>();

  private async loadAgentWindows(): Promise<Set<number>> {
    try {
      const stored = (await chrome.storage.session.get(AGENT_WINDOWS_KEY))[AGENT_WINDOWS_KEY];
      if (Array.isArray(stored)) return new Set(stored.filter((id): id is number => typeof id === 'number'));
    } catch {
      // fall back to memory
    }
    return this.agentWindows;
  }

  private async saveAgentWindows(windows: Set<number>): Promise<void> {
    this.agentWindows = windows;
    try {
      await chrome.storage.session.set({ [AGENT_WINDOWS_KEY]: [...windows] });
    } catch {
      // memory copy stays
    }
  }

  /** Forget the registered windows that no longer exist (a closed tab may have been the last). */
  private async pruneAgentWindows(): Promise<void> {
    const windows = await this.loadAgentWindows();
    for (const id of [...windows]) {
      if (!await this.windowExists(id)) windows.delete(id);
    }
    await this.saveAgentWindows(windows);
  }

  private async isAgentWindow(windowId: number): Promise<boolean> {
    return (await this.loadAgentWindows()).has(windowId);
  }

  private async rememberAgentWindow(windowId: number): Promise<void> {
    const windows = await this.loadAgentWindows();
    windows.add(windowId);
    await this.saveAgentWindows(windows);
  }

  private async forgetAgentWindow(windowId: number): Promise<void> {
    const windows = await this.loadAgentWindows();
    if (windows.delete(windowId)) await this.saveAgentWindows(windows);
  }

  /**
   * Close the tabs a caller owns inside a window this extension created for the agent.
   * `tabIds` is required: nothing is closed that is not named in it, and an empty list closes
   * nothing. Chrome closes the window by itself when its last tab goes, so `windows.remove` is
   * never called: it would take along any tab of the user's dragged into the window in the
   * meantime. `closed` says whether the window is gone afterwards.
   */
  async closeWindow(windowId: number, tabIds: number[]): Promise<{ windowId: number; closed: boolean; closedTabIds: number[] }> {
    if (!await this.isAgentWindow(windowId)) {
      const err = new Error(`NOT_AGENT_WINDOW: window ${windowId} was not created by the agent; nothing was closed`);
      err.name = 'NOT_AGENT_WINDOW';
      throw err;
    }

    let insideIds: number[] = [];
    try {
      insideIds = (await chrome.tabs.query({ windowId })).map((t) => t.id).filter((id): id is number => id !== undefined);
    } catch {
      // the window is gone
    }
    const ours = tabIds.filter((id) => insideIds.includes(id));

    if (this.connectedTabId !== null && ours.includes(this.connectedTabId)) {
      await this.disconnectTab();
    }
    const closedTabIds: number[] = [];
    for (const id of ours) {
      try {
        await chrome.tabs.remove(id);
        closedTabIds.push(id);
      } catch {
        // already gone
      }
    }
    const closed = !await this.windowExists(windowId);
    if (closed) {
      await this.forgetAgentWindow(windowId);
      log.info(`Closed agent window: ${windowId}`);
    }
    return { windowId, closed, closedTabIds };
  }

  /**
   * Resolve when the tab's load is complete. With nextLoad, only a load that completes after
   * this call counts (the tab is already complete and is about to navigate); otherwise an
   * already-complete tab resolves at once. The listener goes in first, so no event is lost.
   */
  private whenTabComplete(tabId: number, nextLoad: boolean): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      };
      const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') done();
      };
      chrome.tabs.onUpdated.addListener(listener);
      if (!nextLoad) {
        chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') done(); }, () => undefined);
      }
    });
  }

  /**
   * Kept for the tool's sake, does nothing: the agent's tabs already live in windows of their own
   * and nothing here may activate a tab. The popup's own buttons are the only activations left.
   */
  async sendTabToBack(_tabId?: number): Promise<number | null> {
    return null;
  }

  /**
   * Point the agent at a different tab. It does not activate it or focus its window.
   */
  async switchTab(tabId: number): Promise<void> {
    if (!await this.tabExists(tabId)) {
      throw new Error(`Tab ${tabId} does not exist`);
    }

    await this.connectTab(tabId);
  }

  /**
   * Close a tab (the connected one when no id is given). Returns the id it closed.
   */
  async closeTab(tabId?: number): Promise<number> {
    const targetTabId = tabId || this.connectedTabId;

    if (!targetTabId) {
      throw new Error('No tab specified and no connected tab');
    }

    if (targetTabId === this.connectedTabId) {
      await this.disconnectTab();
    }

    await chrome.tabs.remove(targetTabId);
    log.info(`Closed tab: ${targetTabId}`);
    await this.pruneAgentWindows();
    return targetTabId;
  }

  /**
   * Re-apply live connection UI on the connected tab after page navigations/reloads.
   */
  async reapplyLiveConnectionUi(): Promise<void> {
    if (!this.connectedTabId) {
      return;
    }

    await this.setLiveConnectionCloseGuard(this.connectedTabId, true);
  }

  /**
   * Start listening for new tabs opened during an operation.
   * Call this before actions that might open new tabs (like clicks).
   */
  startNewTabDetection(): void {
    // Clear any previous state
    this.pendingNewTab = null;

    // Remove existing listener if any
    if (this.newTabListener) {
      chrome.tabs.onCreated.removeListener(this.newTabListener);
    }

    this.newTabListener = (tab: chrome.tabs.Tab) => {
      // Only track if we have a connected tab (automation in progress)
      // and it's not the connected tab itself
      if (this.connectedTabId && tab.id && tab.id !== this.connectedTabId) {
        log.info(`[NewTabDetection] New tab opened: ${tab.id}, url: ${tab.url || tab.pendingUrl || 'unknown'}`);
        this.pendingNewTab = {
          id: tab.id,
          url: tab.url || tab.pendingUrl || '',
          title: tab.title || '',
          active: tab.active,
          connected: false,
          windowId: tab.windowId,
        };
      }
    };

    chrome.tabs.onCreated.addListener(this.newTabListener);
    log.debug('[NewTabDetection] Started listening for new tabs');
  }

  /**
   * Stop listening for new tabs and return any detected tab.
   * Returns the new tab info if one was detected, null otherwise.
   */
  stopNewTabDetection(): TabInfo | null {
    if (this.newTabListener) {
      chrome.tabs.onCreated.removeListener(this.newTabListener);
      this.newTabListener = null;
      log.debug('[NewTabDetection] Stopped listening for new tabs');
    }

    const newTab = this.pendingNewTab;
    this.pendingNewTab = null;

    if (newTab) {
      log.info(`[NewTabDetection] Returning detected new tab: ${newTab.id}`);
    }

    return newTab;
  }

  /**
   * Wait for a tab to finish loading.
   */
  public waitForTabLoad(tabId: number): Promise<void> {
    return this.whenTabComplete(tabId, true);
  }

  /**
   * Clear any live-connection UI/guards from old extension builds.
   * Automation tabs must stay unobstructed for agent-driven clicks.
   */
  private async setLiveConnectionCloseGuard(tabId: number, _enabled: boolean): Promise<void> {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          const host = window as unknown as Record<string, unknown>;
          const keys = {
            state: '__agentJakeLiveCloseGuardMessage',
            handler: '__agentJakeLiveCloseGuardHandler',
            banner: '__agentJakeLiveCloseGuardBanner',
            moveHandler: '__agentJakeLiveBannerMoveHandler',
            overlay: '__agentJakeLiveCloseGuardOverlay',
            dismissed: '__agentJakeLiveCloseGuardOverlayDismissed',
            style: '__agentJakeLiveCloseGuardStyle',
          };

          const existingBeforeUnload = host[keys.handler];
          if (typeof existingBeforeUnload === 'function') {
            window.removeEventListener('beforeunload', existingBeforeUnload as EventListener);
          }

          const moveHandler = host[keys.moveHandler];
          if (typeof moveHandler === 'function') {
            window.removeEventListener('mousemove', moveHandler as EventListener);
          }

          for (const key of [keys.banner, keys.overlay, keys.style]) {
            const element = host[key] as Element | undefined;
            element?.remove?.();
            host[key] = null;
          }

          host[keys.state] = '';
          host[keys.handler] = null;
          host[keys.moveHandler] = null;
          host[keys.dismissed] = null;
          window.onbeforeunload = null;

          document.querySelectorAll(
            '.agent-jake-live-banner, .agent-jake-live-overlay, #agent-jake-live-close-guard-style'
          ).forEach((element) => element.remove());
        },
      });
    } catch {
      // Best effort: restricted pages cannot be scripted.
    }
  }

}
