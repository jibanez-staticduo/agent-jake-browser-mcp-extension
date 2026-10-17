/**
 * Background service worker entry point.
 * Manages WebSocket connection to browser-mcp and routes tool calls.
 *
 * Uses chrome.alarms API to keep the service worker alive when a tab is connected.
 * Manifest V3 service workers can go to sleep after ~30 seconds of inactivity,
 * which would kill the WebSocket connection to browser-mcp.
 */

// MUST be first import - polyfills window/document for service worker context
import './sw-polyfill';

import { WebSocketClient } from './ws-client';
import { TabManager } from './tab-manager';
import { createToolHandlers } from './tool-handlers';
import { activityLog } from './activity-log';
import { preparePrivateStorage } from './storage-privacy';
import {
  cancelPairing,
  getPairingInfo,
  maybeAutoStartPairing,
  setOnTokenApproved,
  startPairing,
} from './pairing';
import { log } from '@/utils/logger';
import { buildProvision, chromeProvisionStorage, provisionCopilot } from './provision';
import { createCopilotTrafficGate, registerCopilotBridge } from './agent/bridge';
import { disablePanelByDefault, openPanelForTab } from './panel-open';
import {
  UPDATE_ALARM,
  UPDATE_NOTIFICATION_ID,
  UPDATE_PERIOD_MINUTES,
  UPDATE_STATE_KEY,
  checkForUpdate,
  chromeUpdateDeps,
  latestUrlFor,
  type UpdateState,
} from './update-check';
import { chromeSelfUpdateDeps, cleanupAfterUpdate, maybeSelfUpdate, restoreDownloadUi } from './self-update';
import {
  buildDisplayUrl,
  getEffectiveConfig,
  parseWsUrl,
  setServerUrl,
  setToken,
  STORAGE_KEYS,
} from '@/config/runtime';

// Keep-alive alarm name - fires every 12 seconds to prevent service worker sleep
const KEEPALIVE_ALARM = 'keepalive';
const KEEPALIVE_INTERVAL_MINUTES = 0.2; // 12 seconds

// Singleton instances
let wsClient: WebSocketClient | null = null;
let tabManager: TabManager | null = null;
let copilotGate: ReturnType<typeof createCopilotTrafficGate> | null = null;
let initialized: Promise<void> | null = null;

// Copilot side panel: its Port and the Alt+J shortcut must be registered at the top
// level, so a wake-up by either event finds the listener in place.
registerCopilotBridge(async () => {
  await initialized?.catch(() => undefined);
  return { tabManager, acquireLease: (tabId) => copilotGate?.acquire(tabId) ?? null };
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-copilot') openPanelForTab(chrome.sidePanel, tab ?? {});
});

// El botón de la barra abre el panel él mismo: con `openPanelOnActionClick` Chrome lo abre en todas
// las pestañas de la ventana, y el panel es de la pestaña que lo abrió (INFRA-875).
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch((error) => {
  log.warn('[Copilot] Could not set the panel behavior:', error);
});
disablePanelByDefault(chrome.sidePanel);
chrome.action.onClicked.addListener((tab) => openPanelForTab(chrome.sidePanel, tab));

/**
 * Initialize the extension.
 */
async function initialize(): Promise<void> {
  log.info('Initializing Agent Jake Browser MCP Extension');

  await preparePrivateStorage();

  // Create tab manager
  tabManager = new TabManager();
  await tabManager.initialize();

  // Create WebSocket client (for local MCP server)
  wsClient = new WebSocketClient();

  // When pairing stores a fresh token, reconnect so the handshake uses it.
  setOnTokenApproved(() => {
    wsClient?.reload().catch((error) => {
      log.warn('[Pairing] Reload after approval failed:', error);
    });
  });

  // Create tool handlers
  const handleMessage = createToolHandlers(tabManager);
  copilotGate = createCopilotTrafficGate(tabManager, handleMessage);
  wsClient.setMessageHandler((message) => copilotGate!.handleMcp(message));

  // Start connection loop for local MCP
  startConnectionLoop();

  // Resume or auto-start a pairing flow when the runtime config calls for it.
  maybeAutoStartPairing().catch((error) => {
    log.warn('[Pairing] Auto-start check failed:', error);
  });

  log.info('Extension initialized');
}

/**
 * Keep the service worker awake. The alarm runs ALWAYS: without it MV3 sleeps after ~30s, takes the
 * WebSocket down with it, and the agent sees "Extension not connected" with no way to wake it —
 * there is no UI to poke when the MCP client is a headless session.
 */
async function updateKeepAliveAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(KEEPALIVE_ALARM);
  if (!existing) {
    await chrome.alarms.create(KEEPALIVE_ALARM, {
      periodInMinutes: KEEPALIVE_INTERVAL_MINUTES,
    });
    log.info('[KeepAlive] Alarm started - service worker stays awake');
  }
}

/**
 * New-version check (update-check.ts): when the browser starts, after an install or reload of
 * the extension, and every UPDATE_PERIOD_MINUTES.
 */
async function runUpdateCheck(): Promise<void> {
  try {
    const config = await getEffectiveConfig();
    const state = await checkForUpdate(latestUrlFor(config), chromeUpdateDeps());
    if (state?.available) log.info(`[Update] ${state.latest?.version} published; running ${state.current.version}`);
    const result = await maybeSelfUpdate(state);
    if (result) log.info(`[SelfUpdate] ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
  } catch (error) {
    log.warn('[Update] check failed:', error);
  }
}

// On every service-worker start: after a self-update reload, drop the files the new build no longer ships.
void cleanupAfterUpdate(chromeSelfUpdateDeps()).catch((e) => log.warn('[SelfUpdate] cleanup failed:', e));
void restoreDownloadUi(chromeSelfUpdateDeps()).catch((e) => log.warn('[SelfUpdate] could not restore the downloads UI:', e));

async function ensureUpdateAlarm(): Promise<void> {
  if (!await chrome.alarms.get(UPDATE_ALARM)) {
    await chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: UPDATE_PERIOD_MINUTES, periodInMinutes: UPDATE_PERIOD_MINUTES });
  }
}

/** Copilot endpoint/key seeded by the build (provision.ts); runs on install, reload and browser start. */
function runProvision(): void {
  provisionCopilot(buildProvision(), chromeProvisionStorage()).catch((error) => {
    log.warn('[Provision] copilot settings not seeded:', error);
  });
}

chrome.runtime.onStartup.addListener(() => {
  runProvision();
  void ensureUpdateAlarm();
  void runUpdateCheck();
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (notificationId !== UPDATE_NOTIFICATION_ID) return;
  const state = (await chrome.storage.local.get(UPDATE_STATE_KEY))[UPDATE_STATE_KEY] as UpdateState | undefined;
  if (state?.downloadUrl) await chrome.tabs.create({ url: state.downloadUrl });
  await chrome.notifications.clear(notificationId);
});

/**
 * Handle keep-alive alarm - triggers connection check.
 */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) {
    void runUpdateCheck();
    return;
  }
  if (alarm.name === KEEPALIVE_ALARM) {
    log.debug('[KeepAlive] Alarm fired - checking connection');
    wsClient?.sendHeartbeat();
    tryConnect();
  }
});

/**
 * Keep the WebSocket up whether or not a tab is attached: tools that do not touch the DOM
 * (list_tabs, navigate, new_tab) must work, and each command's tab attaches on demand.
 */
async function tryConnect(): Promise<void> {
  if (!wsClient) return;

  const wsConnected = wsClient?.isConnected();
  log.debug(`[Loop] tryConnect - wsConnected: ${wsConnected}`);

  // Skip if ws-client already has a reconnect scheduled
  if (wsClient.isReconnecting()) {
    log.debug('[Loop] Reconnect already scheduled, skipping');
    return;
  }

  if (!wsConnected) {
    log.info('[Loop] Not connected, attempting WebSocket connect...');
    try {
      await wsClient.connect();
      log.info('[Loop] Connected to browser-mcp');
    } catch (error) {
      log.warn(`[Loop] Connect failed: ${(error as Error).message}`);
    }
  }
}

/**
 * Connection loop - keeps trying to connect to browser-mcp.
 */
async function startConnectionLoop(): Promise<void> {
  if (!wsClient) return;

  // Try immediately
  await tryConnect();

  // Update keep-alive alarm based on current state
  await updateKeepAliveAlarm();

  // The ws-client handles its own reconnection via handleDisconnect().
  // The keep-alive alarm (every 12s) serves as a backup.
}

/**
 * Handle messages from popup.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Log all incoming messages for debugging
  log.debug('Message received, url:', sender.url, 'action:', message?.action);

  // Check if message is from our extension pages (popup, etc.)
  // When popup is opened as a page (Playwright), sender.tab is set but URL is still chrome-extension://
  const isFromExtension = sender.url?.startsWith('chrome-extension://');
  const isFromContentScript = sender.tab && !isFromExtension;

  if (isFromContentScript) {
    // Message from content script in a regular web page - handle separately
    // Don't return false - just don't respond to popup-style messages
    return;
  }

  // This is from popup or other extension page
  (async () => {
    try {
      const response = await handlePopupMessage(message);
      log.debug('Sending popup response');
      sendResponse(response);
    } catch (error) {
      log.error('Message handler error:', error);
      sendResponse({ success: false, error: (error as Error).message });
    }
  })();

  return true; // Keep sendResponse channel open for async response
});

/**
 * Handle popup messages.
 */
async function handlePopupMessage(message: {
  action: string;
  payload?: unknown;
}): Promise<unknown> {
  const { action, payload } = message;

  switch (action) {
    case 'getStatus': {
      // Which tabs the agent drives is a property of each tab (`connected`), not of the browser.
      const tabs = tabManager ? await tabManager.listTabs() : [];
      return {
        connected: wsClient?.isConnected() || false,
        tabs,
      };
    }

    case 'getServerConfig': {
      const cfg = await getEffectiveConfig();
      const stored = await chrome.storage.local.get([STORAGE_KEYS.serverUrl, STORAGE_KEYS.token]);
      return {
        effectiveUrl: buildDisplayUrl(cfg),
        fromStorage: cfg.fromStorage,
        source: cfg.source,
        storedServerUrl: typeof stored[STORAGE_KEYS.serverUrl] === 'string'
          ? (stored[STORAGE_KEYS.serverUrl] as string)
          : '',
        storedToken: typeof stored[STORAGE_KEYS.token] === 'string'
          ? (stored[STORAGE_KEYS.token] as string)
          : '',
        hasToken: cfg.token !== '',
        connectionId: cfg.connectionId,
        connected: wsClient?.isConnected() || false,
        pairing: getPairingInfo(),
      };
    }

    case 'saveServerConfig': {
      const { serverUrl, token } = (payload || {}) as { serverUrl?: string; token?: string };
      if (typeof serverUrl === 'string') {
        const trimmed = serverUrl.trim();
        if (trimmed && parseWsUrl(trimmed) === null) {
          return { success: false, error: `Invalid server URL: ${trimmed}` };
        }
        await setServerUrl(trimmed || null);
      }
      if (typeof token === 'string') {
        await setToken(token.trim());
      }
      // Reconnect immediately so the new URL/token take effect.
      cancelPairing();
      wsClient?.disconnect();
      await wsClient?.reload();
      const cfg = await getEffectiveConfig();
      return {
        success: true,
        connected: wsClient?.isConnected() || false,
        effectiveUrl: buildDisplayUrl(cfg),
      };
    }

    case 'startPairing': {
      const result = await startPairing();
      return { success: true, ...result };
    }

    case 'pairingStatus': {
      return getPairingInfo();
    }

    case 'connectTab': {
      const { tabId, tabUrl } = payload as { tabId: number; tabUrl?: string };
      await tabManager?.connectTab(tabId, tabUrl);
      // Reset reconnect counter and try to connect immediately
      wsClient?.resetReconnectAttempts();
      wsClient?.connect().catch(() => {}); // Fire and forget
      // Start keep-alive alarm to prevent service worker sleep
      await updateKeepAliveAlarm();
      return { success: true };
    }

    // No tab is needed to connect MCP: each command binds the tab of its own session.
    case 'toggleMcp': {
      if (wsClient?.isConnected()) {
        wsClient.disconnect();
        return { success: true, connected: false };
      }

      wsClient?.resetReconnectAttempts();
      await wsClient?.connect();
      await updateKeepAliveAlarm();
      return { success: true, connected: true };
    }

    // Letting go of one tab leaves the other sessions and the WebSocket alone.
    case 'disconnectTab': {
      const { tabId } = payload as { tabId: number };
      await tabManager?.disconnectTab(tabId);
      return { success: true };
    }

    case 'getActivity': {
      try {
        const { limit } = (payload as { limit?: number }) || {};
        if (limit) {
          return await activityLog.getLatest(limit);
        }
        return await activityLog.getAll();
      } catch (error) {
        log.error('Failed to get activity:', error);
        // Return empty response on error
        return { activities: [], total: 0 };
      }
    }

    case 'clearActivity': {
      await activityLog.clear();
      return { success: true };
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

/**
 * Handle extension install/update.
 */
chrome.runtime.onInstalled.addListener((details) => {
  log.info(`Extension installed: ${details.reason}`);
  runProvision();
  void ensureUpdateAlarm();
  void runUpdateCheck();
});

/**
 * Handle debugger detach for ONE tab: clean up that tab and reattach it if the drop was not the
 * user's. The tabs other sessions drive are not touched (INFRA-907).
 */
chrome.debugger.onDetach.addListener(async (source, reason) => {
  const tabId = source.tabId;
  if (!tabId) return;
  log.warn(`Debugger detached from tab ${tabId}: ${reason}`);

  if (tabManager?.markDebuggerDetached(tabId) && reason !== 'canceled_by_user') {
    // Small delay to let Chrome settle
    await new Promise(resolve => setTimeout(resolve, 500));

    try {
      await tabManager.reattachDebugger(tabId);
      log.info('[onDetach] Debugger reattached successfully');
    } catch (error) {
      log.error('[onDetach] Failed to reattach debugger:', error);
      // Don't throw - the next tool call will try again via sendDebuggerCommand
    }
  }
});

/**
 * Re-apply the live connection guard UI on the tab that reloaded or navigated, when we drive it.
 */
chrome.tabs.onUpdated.addListener((updatedTabId, changeInfo) => {
  if (changeInfo.status !== 'complete') {
    return;
  }

  if (!tabManager?.drivenTabIds().includes(updatedTabId)) {
    return;
  }

  tabManager.reapplyLiveConnectionUi(updatedTabId).catch((error) => {
    log.warn('[onUpdated] Failed to re-apply live connection UI:', error);
  });
});

// Initialize on load
const extensionVersion = chrome.runtime.getManifest().version;
console.log('========================================');
console.log(`Agent Jake Browser MCP Extension v${extensionVersion}`);
console.log('========================================');
initialized = initialize();
initialized.catch(error => {
  log.error('Failed to initialize:', error);
});

// Expose debug helpers for service worker console
(globalThis as Record<string, unknown>).__debug = {
  getStatus: () => ({
    wsConnected: wsClient?.isConnected(),
    drivenTabs: tabManager?.drivenTabIds(),
    reconnectAttempts: (wsClient as unknown as { reconnectAttempts?: number })?.reconnectAttempts,
  }),
  forceConnect: () => wsClient?.connect(),
  forceDisconnect: () => wsClient?.disconnect(),
  resetReconnect: () => wsClient?.resetReconnectAttempts(),
};
