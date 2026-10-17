/**
 * Tool handlers orchestrator for browser automation commands.
 * Delegates to categorized handler modules.
 */

import type { CallTab, TabManager } from './tab-manager';
import type { IncomingMessage, OutgoingMessage, ToolName as MessageToolName } from '@/types/messages';
import { log } from '@/utils/logger';
import { logTool, logError } from './activity-log';
import { redactPayload } from './redact';
import { getKeyDefinition } from '@/constants/keys';
import { createToolContext } from './tools/utils';
import type { HandlerContext } from './tools/handlers';
import {
  createNavigationHandlers,
  createInteractionHandlers,
  createQueryHandlers,
  createStateHandlers,
  createTabHandlers,
  createUtilityHandlers,
  createDevtoolsHandlers,
} from './tools/handlers';

/**
 * Build a HandlerContext from the call's pinned tab manager.
 * Extends ToolContext with typed mouse/key event wrappers.
 */
function buildHandlerContext(call: CallTab): HandlerContext {
  const ctx = createToolContext(call);

  return {
    ...ctx,

    async dispatchMouseEventTyped(type, x, y, button = 'left', clickCount = 1) {
      // INFRA-855: the drawn pointer glides on the move and ripples on the press.
      if (type === 'mouseMoved') void ctx.sendToContent('cursor', { kind: 'move', x, y }).catch(() => {});
      if (type === 'mousePressed') void ctx.sendToContent('cursor', { kind: 'click', x, y }).catch(() => {});
      await ctx.dispatchMouseEvent(type, x, y, button, clickCount);
    },

    async dispatchKeyEventTyped(type, key, text?) {
      if (type === 'char') void ctx.sendToContent('cursor', { kind: 'type' }).catch(() => {});
      const keyDef = getKeyDefinition(key);
      await call.sendDebuggerCommand('Input.dispatchKeyEvent', {
        type,
        key: keyDef.key,
        code: keyDef.code,
        windowsVirtualKeyCode: keyDef.keyCode,
        text: type === 'char' ? text : undefined,
      });
    },
  };
}

/**
 * The MCP server names the tab of the calling session in every command (`targetTabId`); the
 * copilot's lease knows its own. Take that tab out of the payload and give the call the tab it
 * works in — from here on no handler chooses a tab, which is what let one session act on
 * another's (INFRA-907).
 */
export async function routeToTargetTab(
  tabManager: Pick<TabManager, 'connectTab' | 'hasTab'>,
  payload: unknown,
): Promise<{ tabId: number | null; payload: unknown }> {
  if (!payload || typeof payload !== 'object') return { tabId: null, payload };
  const { targetTabId, ...rest } = payload as Record<string, unknown>;
  if (typeof targetTabId !== 'number') return { tabId: null, payload };
  if (!await tabManager.hasTab(targetTabId)) {
    const gone = new Error(`TAB_GONE: tab ${targetTabId} of this session no longer exists; open one with browser_new_tab or pick one with browser_switch_tab`);
    gone.name = 'TAB_GONE';
    throw gone;
  }
  await tabManager.connectTab(targetTabId);
  return { tabId: targetTabId, payload: rest };
}

/** Pinned methods that act now, so the call's tab must already be resolved when they are used. */
const SYNC_PINNED = new Set<PropertyKey>([
  'beginFileChooser', 'endFileChooser', 'startNewTabDetection', 'stopNewTabDetection',
  'isAutoAttached', 'reapplyLiveConnectionUi',
]);

/** Pinned methods that name a tab only when the caller gives one (close this tab, send this back). */
const OPTIONAL_PINNED = new Set<PropertyKey>(['closeTab', 'sendTabToBack']);

/** Pinned methods that may resolve the call's tab themselves (binding the tab in front if none). */
const ASYNC_PINNED = new Set<PropertyKey>(['sendDebuggerCommand', 'waitForDebuggerEvent', 'runPasskeyCeremony']);

/**
 * The TabManager pinned to one call's tab (see `CallTab`): a handler cannot name another session's
 * tab because it does not name any. When the server named none, the first tool that needs a tab
 * binds the tab in front as the USER's own — auto-attached, so navigating tools refuse to drive it.
 *
 * `fence` is the gate's cut: naming the tab is part of holding the browser, so a call that lost it
 * cannot even reach the content script of the tab another call is using now.
 */
export function pinnedToTab(tabManager: TabManager, routed: number | null, fence = new AbortController().signal): CallTab {
  let resolved: number | null = routed;
  let binding: Promise<number> | null = null;
  const tabId = (): Promise<number> => {
    fence.throwIfAborted();
    if (resolved !== null) return Promise.resolve(resolved);
    binding ??= (async () => {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!active?.id) throw new Error('No active tab to attach to');
      await tabManager.connectTab(active.id, active.url, { autoAttached: true });
      resolved = active.id;
      return resolved;
    })();
    return binding;
  };
  const currentTab = (): number => {
    if (resolved === null) throw new Error('No tab connected');
    return resolved;
  };

  return new Proxy(tabManager, {
    get(target, prop) {
      if (prop === 'tabId') return tabId;
      if (prop === 'routedTabId') return () => routed;
      if (prop === 'currentTabId') return () => resolved;
      const value = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      if (SYNC_PINNED.has(prop)) return (...args: unknown[]) => value.apply(target, [currentTab(), ...args]);
      if (OPTIONAL_PINNED.has(prop)) return (tab?: number, ...args: unknown[]) => value.apply(target, [tab ?? currentTab(), ...args]);
      if (ASYNC_PINNED.has(prop)) return async (...args: unknown[]) => value.apply(target, [await tabId(), ...args]);
      return value.bind(target);
    },
  }) as unknown as CallTab;
}

/** What a cut call may still do from its catch/finally: let go of what it took, never act. */
const LETTING_GO = new Set<PropertyKey>(['stopNewTabDetection', 'endFileChooser']);

/**
 * The TabManager as one call sees it: once the gate cuts the call (agent/bridge.ts) every method
 * that acts throws, so a handler that wakes up late — a frozen tab finally answering its content
 * script, 16-10 — cannot act on the tab another call is using by then.
 */
function fencedTabManager(tabManager: TabManager, signal: AbortSignal): TabManager {
  return new Proxy(tabManager, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const lettingGo = LETTING_GO.has(prop) || (prop === 'setFileChooserInterception' && args[1] === false);
        if (!lettingGo) signal.throwIfAborted();
        return value.apply(target, args);
      };
    },
  });
}

/**
 * Create tool handlers bound to a tab manager.
 */
export function createToolHandlers(browser: TabManager) {
  function handlersFor(call: CallTab): Record<string, (payload: unknown) => Promise<unknown>> {
    const ctx = buildHandlerContext(call);
    return {
      ...createNavigationHandlers(ctx),
      ...createInteractionHandlers(ctx),
      ...createQueryHandlers(ctx),
      ...createStateHandlers(ctx),
      ...createTabHandlers(ctx),
      ...createUtilityHandlers(ctx),
      ...createDevtoolsHandlers(ctx),

      // Reload this extension from disk (unpacked build just replaced by a deploy). Answer first,
      // reload right after: the socket drops and the new service worker reconnects on its own.
      // Deploys call it through the server's loopback-only POST /extension/reload, so no Chrome
      // debugging port, screen or human is needed to roll out a new build.
      browser_reload_extension: async () => {
        setTimeout(() => chrome.runtime.reload(), 300);
        return { reloading: true, version: chrome.runtime.getManifest().version };
      },
    };
  }

  /**
   * Handle one call (from the WebSocket or the copilot). `signal` is the gate's cut: when it
   * aborts, nothing this call left running touches the browser again.
   */
  return async function handleMessage(message: IncomingMessage, signal = new AbortController().signal): Promise<OutgoingMessage> {
    const { id, type, payload } = message;
    const startTime = performance.now();
    const tabManager = fencedTabManager(browser, signal);

    log.debug(`[Tool] Received: ${type} (id: ${id})`);

    try {
      const routed = await routeToTargetTab(tabManager, payload);
      const handlers = handlersFor(pinnedToTab(tabManager, routed.tabId, signal));
      const handler = handlers[type];
      if (!handler) {
        logError('unknown_tool', `Unknown tool: ${type}`);
        return {
          id,
          success: false,
          error: {
            code: 'UNKNOWN_TOOL',
            message: `Unknown tool: ${type}`,
          },
        };
      }

      const result = await handler(routed.payload);
      const durationMs = Math.round(performance.now() - startTime);

      const description = getToolDescription(type, payload, result);
      logTool(type, description, true, durationMs, { payload: redactPayload(payload), result });

      log.info(`[Tool] Completed: ${type} (id: ${id}) - success in ${durationMs}ms`);

      return {
        id,
        success: true,
        result,
      };
    } catch (error) {
      const durationMs = Math.round(performance.now() - startTime);
      log.error(`[Tool] Failed: ${type} (id: ${id}) - ${(error as Error).message} in ${durationMs}ms`);

      logTool(type, (error as Error).message, false, durationMs, { payload: redactPayload(payload), error: (error as Error).message });

      return {
        id,
        success: false,
        error: {
          code: (error as Error).name || 'EXECUTION_ERROR',
          message: (error as Error).message,
        },
      };
    }
  };
}

/**
 * Get a concise description for the tool action.
 */
function getToolDescription(type: string, payload: unknown, result: unknown): string {
  const p = payload as Record<string, unknown>;
  const r = result as Record<string, unknown>;

  switch (type) {
    case 'browser_navigate':
      return `Navigate to ${p?.url || 'unknown'}`;
    case 'browser_click':
      return `Click on "${p?.ref || p?.selector}"`;
    case 'browser_type':
      if (p?.secret) return `Type secret into "${p?.ref || p?.selector}"`;
      return `Type "${String(p?.text || '').slice(0, 20)}${(String(p?.text || '').length > 20) ? '...' : ''}"`;
    case 'browser_hover':
      return `Hover on "${p?.ref || p?.selector}"`;
    case 'browser_press_key':
      return `Press key "${p?.key}"`;
    case 'browser_wait':
      return `Wait ${p?.time}s`;
    case 'browser_screenshot':
      return 'Take screenshot';
    case 'browser_snapshot':
      return `Snapshot: ${r?.title || 'page'}`;
    case 'browser_new_tab':
      return `New tab: ${p?.url || 'unknown'}`;
    case 'browser_find_tab':
      return `Find tabs "${p?.query}"`;
    case 'browser_switch_tab':
      return `Switch to tab ${p?.tabId}`;
    case 'browser_close_tab':
      return 'Close tab';
    case 'browser_evaluate':
      return `Evaluate JS via CDP (${String(p?.code || '').length} chars)`;
    case 'browser_get_html':
      return `Get page HTML (${(r?.html as string)?.length || 0} chars)`;
    case 'browser_iframe_eval':
      return `Evaluate JS in iframe ${p?.iframeSelector || 'unknown'} (${String(p?.code || '').length} chars)`;
    case 'browser_iframe_click':
      return `Click ${p?.targetSelector || 'unknown'} inside iframe ${p?.iframeSelector || 'unknown'}`;
    case 'browser_resize_viewport':
      return `Resize to ${p?.width}x${p?.height}`;
    case 'browser_upload_file':
      return `Upload file: ${p?.filePath ?? (p?.filePaths as string[] | undefined)?.join(', ')}`;
    case 'browser_network_requests':
      return `Network requests (${((r?.requests as unknown[]) ?? []).length})`;
    case 'browser_network_request':
      return `Network request [${p?.index}]${p?.part ? ` ${p.part}` : ''}`;
    case 'browser_get_console_logs':
      return `Console logs (${((r?.logs as unknown[]) ?? []).length})`;
    case 'browser_cdp':
      return `CDP ${p?.method}`;
    case 'browser_drop':
      return `Drop on "${p?.ref || p?.selector}"`;
    case 'browser_fill_form':
      return `Fill form (${((p?.fields as unknown[]) ?? []).length} fields)`;
    case 'browser_passkey':
      return `Passkey ${p?.mode} on "${p?.ref || p?.selector}"`;
    case 'browser_select_option':
      return `Select option in "${p?.ref || p?.selector}"`;
    case 'browser_pdf':
      return `Print page to PDF (${Math.round(String((r as Record<string, unknown>)?.pdf ?? '').length * 0.75)} bytes)`;
    default:
      return type.replace('browser_', '').replace(/_/g, ' ');
  }
}
