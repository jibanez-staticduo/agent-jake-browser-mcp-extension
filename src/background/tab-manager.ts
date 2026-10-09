/**
 * Manages connected tab state and tab operations.
 * Tracks which tab is currently being automated.
 */

import { log } from '@/utils/logger';
import { logTab, logError } from './activity-log';
import type { TabInfo } from '@/types/messages';
import { DEBUGGER, TIMEOUTS } from '@/constants';
import { pageEvents } from './page-events';
import { passkeysForHost, rpIdMatchesHost, savePasskeys, summarize, type PasskeySummary, type StoredPasskey } from './passkey-vault';

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

/** The guard: holds no credential, verifies no user, answers without user presence. */
const GUARD_AUTHENTICATOR = {
  protocol: 'ctap2',
  transport: 'usb',
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: false,
  automaticPresenceSimulation: true,
} as const;

/** For one passkey ceremony only: a platform authenticator that verifies the user. */
const CEREMONY_AUTHENTICATOR = {
  protocol: 'ctap2',
  transport: 'internal',
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
} as const;

/** Under the server's 30 s request timeout, with room for the click itself. */
export const PASSKEY_CEREMONY_TIMEOUT_MS = 20_000;
const PASSKEY_POLL_MS = 250;

export type PasskeyMode = 'enroll' | 'use';

export interface PasskeyOutcome {
  mode: PasskeyMode;
  host: string;
  /** completed: the site created (enroll) or used (use) a credential; timeout: it never asked. */
  ceremony: 'completed' | 'timeout';
  passkeys: PasskeySummary[];
  /** Only when putting the guard back failed twice: the tab must not browse on. */
  guardRestored?: false;
}

interface CdpCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
}

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
    injectImmediately: true, // see setLiveConnectionCloseGuard
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
  /** Set when the connected tab is the user's own, reached through auto-attach and not opened or chosen by the agent. */
  private autoAttachedTabId: number | null = null;
  private debuggerAttached = false;
  private captureEvents = false;
  private connectionGeneration = 0;
  private disconnecting = false;
  private lastCdpError: string | null = null;
  private pendingNewTab: TabInfo | null = null;
  private newTabListener: ((tab: chrome.tabs.Tab) => void) | null = null;
  private fileChooserInProgress = false;
  private webauthnPinScript: { tabId: number; identifier: string } | null = null;
  private webauthnGuard: { tabId: number; authenticatorId: string } | null = null;
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
      if (this.autoAttachedTabId === removedTabId) {
        this.autoAttachedTabId = addedTabId;
        void chrome.storage.local.set({ [DEBUGGER.AUTO_ATTACHED_KEY]: addedTabId });
      }
    });

    const stored = await chrome.storage.local.get([DEBUGGER.STORAGE_KEY, DEBUGGER.AUTO_ATTACHED_KEY]);
    if (stored[DEBUGGER.STORAGE_KEY]) {
      const tabId = stored[DEBUGGER.STORAGE_KEY] as number;
      // Verify tab still exists
      if (await this.tabExists(tabId)) {
        this.connectedTabId = tabId;
        // A service-worker restart must not turn the user's tab into one the agent owns.
        this.autoAttachedTabId = stored[DEBUGGER.AUTO_ATTACHED_KEY] === tabId ? tabId : null;
        await this.setLiveConnectionCloseGuard(tabId, true);
        log.info(`Restored connected tab: ${tabId}`);
      } else {
        await chrome.storage.local.remove([DEBUGGER.STORAGE_KEY, DEBUGGER.AUTO_ATTACHED_KEY]);
      }
    }
  }

  /**
   * True when the connected tab is the user's own, bound by auto-attach (see requireTabId) rather
   * than opened (browser_new_tab) or chosen (browser_switch_tab, the popup) by the agent. Whatever
   * navigates must not drive such a tab: it opens a background one instead.
   */
  isAutoAttached(): boolean {
    return this.connectedTabId !== null && this.autoAttachedTabId === this.connectedTabId;
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
  async connectTab(tabId: number, tabUrl?: string, options: { autoAttached?: boolean } = {}): Promise<void> {
    // If tab is chrome://newtab/, navigate to about:blank first
    // (Chrome blocks extensions from accessing chrome:// URLs)
    if (tabUrl === 'chrome://newtab/') {
      await this.waitForNextTabLoad(tabId, () => chrome.tabs.update(tabId, { url: 'about:blank' }));
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
      this.autoAttachedTabId = options.autoAttached ? tabId : null;
      await chrome.storage.local.set({ [DEBUGGER.STORAGE_KEY]: tabId });
      if (options.autoAttached) await chrome.storage.local.set({ [DEBUGGER.AUTO_ATTACHED_KEY]: tabId });
      else await chrome.storage.local.remove(DEBUGGER.AUTO_ATTACHED_KEY);

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
      this.autoAttachedTabId = null;
      this.cancelEventWaiters();
      pageEvents.reset();
      this.disconnecting = false;
      await chrome.storage.local.remove([DEBUGGER.STORAGE_KEY, DEBUGGER.AUTO_ATTACHED_KEY]);
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
      await this.addGuardAuthenticator(tabId);

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

  private async addGuardAuthenticator(tabId: number): Promise<void> {
    const target = { tabId };
    const { authenticatorId } = await chrome.debugger.sendCommand(target, 'WebAuthn.addVirtualAuthenticator', {
      options: GUARD_AUTHENTICATOR,
    }) as { authenticatorId: string };
    await chrome.debugger.sendCommand(target, 'WebAuthn.setResponseOverrideBits', { authenticatorId, isBadUP: true });
    this.webauthnGuard = { tabId, authenticatorId };
  }

  /**
   * Lifts the WebAuthn guard for ONE ceremony that `action` (a click) starts, then puts it back
   * (INFRA-585). The guard authenticator is swapped for one that verifies the user:
   *  - enroll: it holds nothing and lets the site create a passkey, which is kept in the
   *    extension (passkey-vault.ts);
   *  - use: it holds only the agent's passkeys whose rpId covers the tab's host, and lets the
   *    site sign in with one.
   * It waits for the site to create or use a credential, up to PASSKEY_CEREMONY_TIMEOUT_MS.
   * Whatever happens, the ceremony authenticator goes and the guard comes back.
   */
  async runPasskeyCeremony<T>(mode: PasskeyMode, action: () => Promise<T>): Promise<{ result: T; passkey: PasskeyOutcome }> {
    const tabId = this.connectedTabId;
    if (!tabId) throw new Error('No tab connected');
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url ?? '';
    if (!/^https:/.test(url)) throw new Error(`Passkeys need an https page, not ${url || 'an empty tab'}`);
    const host = new URL(url).hostname;
    const known = await passkeysForHost(host);
    if (mode === 'use' && !known.length) {
      throw new Error(`No agent passkey enrolled for ${host}: enroll one first (browser_passkey with mode: "enroll" on the site's "add a passkey" button, signed in)`);
    }

    // Chrome checks focus in the BROWSER, not in the page: a WebAuthn request from a tab that is not the active one of
    // its window fails with «the page does not have focus» even with focus emulation on (measured on webauthn.io,
    // 05-10-2026). So the tab is the active one of its window for the ceremony only, and the previous one comes back.
    const previous = tab.active ? undefined
      : (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0]?.id;
    // Before the guard comes off: if activating fails, the tab keeps its guard.
    if (!tab.active) await chrome.tabs.update(tabId, { active: true });
    const target = { tabId };
    if (this.webauthnGuard?.tabId === tabId) {
      await chrome.debugger.sendCommand(target, 'WebAuthn.removeVirtualAuthenticator', {
        authenticatorId: this.webauthnGuard.authenticatorId,
      }).catch(() => undefined);
      this.webauthnGuard = null;
    }
    let authenticatorId: string | undefined;
    let guardRestored = true;
    let result: T;
    let done: StoredPasskey[];
    try {
      ({ authenticatorId } = await chrome.debugger.sendCommand(target, 'WebAuthn.addVirtualAuthenticator', {
        options: CEREMONY_AUTHENTICATOR,
      }) as { authenticatorId: string });
      if (mode === 'use') {
        for (const p of known) {
          await chrome.debugger.sendCommand(target, 'WebAuthn.addCredential', {
            authenticatorId,
            credential: {
              credentialId: p.credentialId,
              isResidentCredential: p.isResidentCredential,
              rpId: p.rpId,
              privateKey: p.privateKey,
              ...(p.userHandle ? { userHandle: p.userHandle } : {}),
              signCount: p.signCount,
            },
          });
        }
      }
      const deadline = Date.now() + PASSKEY_CEREMONY_TIMEOUT_MS;
      result = await action();
      done = await this.waitForPasskeyCeremony(target, authenticatorId, mode, known, host, deadline);
      if (done.length) await savePasskeys(done);
    } finally {
      if (authenticatorId) {
        await chrome.debugger.sendCommand(target, 'WebAuthn.removeVirtualAuthenticator', { authenticatorId })
          .catch((error) => log.warn('[Passkey] ceremony authenticator not removed:', error));
      }
      guardRestored = await this.restoreWebAuthnGuard(tabId);
      if (previous !== undefined) {
        await chrome.tabs.update(previous, { active: true })
          .catch((error) => log.warn('[Passkey] previous tab not restored:', error));
      }
    }
    return {
      result,
      passkey: {
        mode,
        host,
        ceremony: done.length ? 'completed' : 'timeout',
        passkeys: summarize(done.length ? done : known),
        ...(guardRestored ? {} : { guardRestored: false as const }),
      },
    };
  }

  /** Guard back after a ceremony; if that fails, the full install (WebAuthn reset + guard + pin). */
  private async restoreWebAuthnGuard(tabId: number): Promise<boolean> {
    try {
      await this.addGuardAuthenticator(tabId);
      return true;
    } catch (error) {
      log.warn('[Passkey] WebAuthn guard not restored, reinstalling it:', error);
    }
    await this.installWebAuthnGuard(tabId);
    return this.webauthnGuard?.tabId === tabId;
  }

  /**
   * Polls the ceremony authenticator until the site created a credential (enroll) or signed
   * with one (use: its sign count went up). Returns those credentials, or [] at the deadline.
   * Only credentials whose rpId covers the tab host count: one for any other site is never kept.
   */
  private async waitForPasskeyCeremony(
    target: { tabId: number },
    authenticatorId: string,
    mode: PasskeyMode,
    known: StoredPasskey[],
    host: string,
    deadline: number,
  ): Promise<StoredPasskey[]> {
    const before = new Map(known.map((p) => [p.credentialId, p.signCount]));
    for (;;) {
      const { credentials } = await chrome.debugger.sendCommand(target, 'WebAuthn.getCredentials', {
        authenticatorId,
      }) as { credentials: CdpCredential[] };
      const changed = (credentials ?? []).filter((c) =>
        mode === 'enroll' ? !before.has(c.credentialId) : c.signCount > (before.get(c.credentialId) ?? Infinity));
      if (changed.length) {
        const now = new Date().toISOString();
        return changed.map((c) => ({
          credentialId: c.credentialId,
          rpId: c.rpId ?? known.find((p) => p.credentialId === c.credentialId)?.rpId ?? '',
          privateKey: c.privateKey,
          ...(c.userHandle ? { userHandle: c.userHandle } : {}),
          signCount: c.signCount,
          isResidentCredential: c.isResidentCredential,
          enrolledAt: known.find((p) => p.credentialId === c.credentialId)?.enrolledAt ?? now,
        })).filter((p) => p.rpId && rpIdMatchesHost(p.rpId, host)); // only the tab host's (security, INFRA-585)
      }
      if (Date.now() >= deadline) return [];
      await new Promise((resolve) => setTimeout(resolve, PASSKEY_POLL_MS));
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
    this.webauthnGuard = null; // and its authenticators

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
    this.webauthnGuard = null;
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
    const [currentTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const currentTabId = currentTab?.id;

    const tabs = await chrome.tabs.query({});

    return tabs.map(tab => ({
      id: tab.id!,
      url: tab.url || '',
      title: tab.title || '',
      // Only mark the specific current tab as active
      active: tab.id === currentTabId,
      connected: tab.id === this.connectedTabId,
    }));
  }

  /**
   * Create a new tab and optionally connect to it.
   *
   * The tab opens in the BACKGROUND by default: `chrome.tabs.create` without
   * `active: false` would jump the window to the new tab and steal the user's
   * view. Pass `active: true` only when the user is meant to see it.
   */
  async createTab(url: string, connect = true, active = false): Promise<{ tab: TabInfo; loaded: boolean }> {
    // The WebAuthn guard's page script only beats a password manager's content script in
    // documents created after we attach (see installWebAuthnGuard). So a tab we are going to
    // drive opens blank, we attach, and only then does it load the URL.
    const guardFirst = connect && /^https?:/i.test(url);
    const tab = await chrome.tabs.create({ url: guardFirst ? 'about:blank' : url, active });
    // Not waited for unless we connect; and a page that outlasts TAB_LOAD_WAIT is still a tab we
    // opened and drive: it stays connected and the answer says loaded:false (it is not an error).
    let loaded = tab.status === 'complete';

    if (connect && tab.id) {
      if (guardFirst) {
        await this.waitForTabLoad(tab.id);
        await this.connectTab(tab.id);
        try {
          loaded = await this.waitForNextTabLoad(tab.id, () => chrome.tabs.update(tab.id!, { url }));
        } catch (error) {
          // Do not leave a connected about:blank behind.
          await chrome.tabs.remove(tab.id).catch(() => undefined);
          throw error;
        }
      } else {
        loaded = await this.waitForTabLoad(tab.id);
        await this.connectTab(tab.id);
      }
    }

    const current = guardFirst && tab.id ? await chrome.tabs.get(tab.id).catch(() => tab) : tab;
    return {
      tab: {
        id: tab.id!,
        url: current.url || url,
        title: current.title || '',
        active: current.active,
        connected: connect && tab.id === this.connectedTabId,
      },
      loaded,
    };
  }

  /**
   * Push a tab to the background by activating another tab of its window.
   * No-op when the tab is already hidden or it is the only tab there.
   */
  async sendTabToBack(tabId?: number): Promise<number | null> {
    const targetId = tabId ?? this.connectedTabId;
    if (!targetId) {
      throw new Error('No tab specified and no connected tab');
    }

    const tab = await chrome.tabs.get(targetId);
    if (!tab.active) {
      return null;
    }

    const siblings = await chrome.tabs.query({ windowId: tab.windowId });
    const other = siblings.find((t) => t.id !== undefined && t.id !== targetId);
    if (!other?.id) {
      return null;
    }

    await chrome.tabs.update(other.id, { active: true });
    return other.id;
  }

  /**
   * Switch to a different tab.
   */
  async switchTab(tabId: number): Promise<void> {
    if (!await this.tabExists(tabId)) {
      throw new Error(`Tab ${tabId} does not exist`);
    }

    await this.connectTab(tabId);
    await chrome.tabs.update(tabId, { active: true });
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
   * Wait for the tab's current load: resolves at once when it is already complete.
   * See `tabLoadWait` for the answer and the failures.
   */
  public waitForTabLoad(tabId: number, timeout: number = TIMEOUTS.TAB_LOAD_WAIT): Promise<boolean> {
    return this.tabLoadWait(tabId, timeout, 'load');
  }

  /**
   * Run `trigger` (a navigation or a reload) and wait for the load it starts. The listeners are
   * armed first, so a load that ends while the trigger is still running is not lost, and a load
   * that was complete before the trigger does not count. If the trigger fails, its own error is
   * the answer. `until` is 'domcontentloaded' to stop at the top frame's DOMContentLoaded;
   * anything else waits for the tab's `complete`.
   */
  public waitForNextTabLoad(
    tabId: number,
    trigger: () => Promise<unknown>,
    timeout: number = TIMEOUTS.TAB_LOAD_WAIT,
    until: 'load' | 'domcontentloaded' = 'load',
  ): Promise<boolean> {
    return this.tabLoadWait(tabId, timeout, until, trigger);
  }

  /**
   * The one bounded wait for a page load. Resolves true at the milestone and false when
   * `timeout` runs out: a page that never finishes loading is not an error, the tab is still
   * ours. Rejects only if the tab is closed or does not exist, or the trigger fails. Every exit
   * removes the listeners and the timer.
   */
  private tabLoadWait(
    tabId: number,
    timeout: number,
    until: 'load' | 'domcontentloaded',
    trigger?: () => Promise<unknown>,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const watchDcl = until === 'domcontentloaded';
      let finished = false;
      const finish = (settle: () => void) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        if (watchDcl) chrome.webNavigation.onDOMContentLoaded.removeListener(onDomContentLoaded);
        settle();
      };
      const loaded = () => finish(() => resolve(true));
      const fail = (error: unknown) => finish(() => reject(error));
      const onUpdated = (id: number, changeInfo: { status?: string }) => {
        if (id === tabId && changeInfo.status === 'complete') loaded();
      };
      const onRemoved = (id: number) => {
        if (id === tabId) fail(new Error(`Tab ${tabId} was closed while loading`));
      };
      const onDomContentLoaded = (details: { tabId: number; frameId: number }) => {
        if (details.tabId === tabId && details.frameId === 0) loaded();
      };
      const timer = setTimeout(() => finish(() => resolve(false)), timeout);

      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);
      if (watchDcl) chrome.webNavigation.onDOMContentLoaded.addListener(onDomContentLoaded);

      // Run after the listeners are armed. Without a trigger the tab's current state answers.
      const start = trigger ?? (async () => { if ((await chrome.tabs.get(tabId)).status === 'complete') loaded(); });
      new Promise((run) => run(start())).catch(fail); // called now; a synchronous throw is a rejection too
    });
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
        // Without it executeScript waits for document_idle, and a page that never finishes loading never
        // gets there: connecting, switching, closing or leaving that tab would hang (INFRA-699).
        injectImmediately: true,
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
