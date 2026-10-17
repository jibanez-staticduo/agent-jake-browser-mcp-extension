/**
 * Copilot bridge: the side panel opens a Port, sends prompts, answers the agent's
 * requests (approvals, questions, plans) and gets its progress back. Tools run through
 * the same handleMessage the MCP WebSocket uses.
 */
import type { TabManager } from '../tab-manager';
import type { IncomingMessage, OutgoingMessage, ToolName } from '@/types/messages';
import {
  COPILOT_ALLOWED_ORIGINS_KEY,
  COPILOT_PORT,
  COPILOT_SETTINGS_KEY,
  DEFAULT_COPILOT_SETTINGS,
  isCopilotConfigured,
  type CopilotSettings,
  type PanelToWorker,
  type UserRequest,
  type UserResponse,
  type WorkerToPanel,
} from '@/types/copilot';
import { TIMEOUTS } from '@/constants/timeouts';
import { log } from '@/utils/logger';
import { AgentStopped, runAgent, type ToolOutcome } from './loop';
import { LOCAL_TOOL_NAMES } from './tools-catalog';
import { openServer, type ServerPlugin } from './mcp-server';
import { formatPageContext } from './context';

type HandleMessage = (message: IncomingMessage, signal?: AbortSignal) => Promise<OutgoingMessage>;

/** Las dos herramientas que se llevan el objetivo a otra pestaña; con la chincheta puesta, no. */
const LEAVES_TAB = new Set<string>(['browser_switch_tab', 'browser_new_tab']);
/** They touch no tab and cannot hang (a bounded sleep, the deploy's reload): no queue, no gate. */
const UNGATED = new Set<string>(['browser_wait', 'browser_reload_extension']);
/** They pick, list or need no tab, so the copilot's calls go out without its tab (the server's NOT_ROUTED). */
const NOT_ROUTED = new Set<string>(['browser_new_tab', 'browser_switch_tab', 'browser_list_tabs', ...UNGATED]);
/** Tab management that names its own tab in `tabId` (the server's NAMES_TAB). */
const NAMES_TAB = new Set<string>(['browser_switch_tab', 'browser_close_tab', 'browser_send_to_back']);

/** A copilot panel's hold on its tab. */
export interface CopilotLease {
  /** The tab it works in; it moves with the copilot's own browser_switch_tab and browser_new_tab. */
  tabId(): number;
  exec(name: string, args: Record<string, unknown>): Promise<OutgoingMessage>;
  /** Gives the browser back as MCP had it and frees the tab. Idempotent. */
  release(): Promise<void>;
}

const refusal = (id: string, code: string, message: string): OutgoingMessage => ({ id, success: false, error: { code, message } });

/**
 * MCP and the copilot panels share one browser that follows a single connected tab, so every call
 * runs alone, in one queue, and is cut at TIMEOUTS.TOOL_CALL — for MCP counted from its arrival, so
 * the extension answers before the server gives up. A cut call is fenced (createToolHandlers) and
 * the queue moves on: a tab that never answers cannot hold the browser (16-10, a click hung on a
 * frozen tab kept the old in-flight counter up for hours). Each panel holds its own tab: MCP stays
 * out of that tab, and only of that one.
 */
export function createCopilotTrafficGate(tabManager: TabManager, handleMessage: HandleMessage) {
  const copilotTabs = new Set<number>();
  let tail: Promise<unknown> = Promise.resolve();

  function queued<T>(job: (signal: AbortSignal) => Promise<T>, expired: () => T, arrivedAt?: number): Promise<T> {
    const run = async (): Promise<T> => {
      const left = (arrivedAt ?? Date.now()) + TIMEOUTS.TOOL_CALL - Date.now();
      if (left <= 0) return expired();
      const cut = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([job(cut.signal), new Promise<T>((resolve) => { timer = setTimeout(() => resolve(expired()), left); })]);
      } finally {
        clearTimeout(timer);
        // Its turn is over: whatever it left running may not touch the browser again.
        cut.abort(new Error('CALL_CUT: this call no longer holds the browser'));
      }
    };
    const result = tail.then(run, run);
    tail = result.catch(() => undefined);
    return result;
  }

  const timedOut = (message: IncomingMessage) => (): OutgoingMessage => {
    log.warn(`[Gate] ${message.type} (${message.id}) cut after ${TIMEOUTS.TOOL_CALL} ms`);
    return refusal(message.id, 'TIMEOUT', `${message.type} did not finish in ${TIMEOUTS.TOOL_CALL / 1000} s (the page is not answering: frozen or hung). It was cut and does nothing more; retry it, or reload the tab.`);
  };

  /** The tab an MCP command acts on: null when none, undefined when it would take the user's active tab. */
  function tabOf({ type, payload }: IncomingMessage): number | null | undefined {
    if (typeof payload?.targetTabId === 'number') return payload.targetTabId;
    if (NAMES_TAB.has(type) && typeof payload?.tabId === 'number') return payload.tabId;
    if (type === 'browser_new_tab' || type === 'browser_list_tabs') return null;
    return tabManager.getConnectedTabId() ?? undefined;
  }

  return {
    handleMcp(message: IncomingMessage): Promise<OutgoingMessage> {
      // La recarga es control del despliegue, no una herramienta: si se gatea, un panel con una
      // aprobación pendiente bloquea para siempre que este navegador se ponga al día (medido 16-10,
      // el primer merge tras INFRA-858: `502 Copilot is using this browser` y el job rojo).
      // Recargar mata el proceso de todos modos, así que no pisa ninguna acción en curso.
      if (UNGATED.has(message.type)) return handleMessage(message);
      const arrivedAt = Date.now();
      return queued(async (signal) => {
        const tab = tabOf(message);
        if (tab === undefined ? copilotTabs.size > 0 : tab !== null && copilotTabs.has(tab)) {
          return refusal(message.id, 'COPILOT_BUSY', 'Copilot is using this tab; retry when it finishes.');
        }
        return handleMessage(message, signal);
      }, timedOut(message), arrivedAt);
    },

    acquire(tabId: number): CopilotLease | null {
      if (copilotTabs.has(tabId)) return null;
      copilotTabs.add(tabId);
      let tab = tabId;
      // What MCP had connected before the copilot last came in: what release gives back.
      let previous = tabManager.getConnectedTabId();
      let released = false;
      return {
        tabId: () => tab,
        exec(name, args) {
          const message: IncomingMessage = {
            id: `copilot-${++seq}`, type: name as ToolName, payload: NOT_ROUTED.has(name) ? args : { ...args, targetTabId: tab },
          };
          if (released) return Promise.resolve(refusal(message.id, 'COPILOT_STOPPED', 'This Copilot run has ended.'));
          if (UNGATED.has(name)) return handleMessage(message);
          return queued(async (signal) => {
            const into = name === 'browser_switch_tab' ? args.tabId : undefined;
            if (typeof into === 'number' && into !== tab && copilotTabs.has(into)) {
              return refusal(message.id, 'COPILOT_BUSY', 'Another Copilot panel is working in that tab.');
            }
            const before = tabManager.getConnectedTabId();
            if (before !== tab) previous = before;
            const response = await handleMessage(message, signal);
            const moved = name === 'browser_new_tab' ? (response.result as { tab?: { id?: unknown } } | undefined)?.tab?.id : into;
            if (response.success && !signal.aborted && typeof moved === 'number' && moved !== tab) {
              copilotTabs.delete(tab);
              copilotTabs.add(moved);
              tab = moved;
            }
            return response;
          }, timedOut(message));
        },
        release() {
          if (released) return Promise.resolve();
          released = true;
          const free = () => { copilotTabs.delete(tab); };
          return queued(async () => {
            try {
              if (tabManager.getConnectedTabId() === tab && previous !== tab) {
                if (previous !== null && await tabManager.hasTab(previous)) await tabManager.connectTab(previous);
                else await tabManager.disconnectTab();
              }
            } finally {
              free();
            }
          }, free);
        },
      };
    },
  };
}

export async function loadCopilotSettings(): Promise<CopilotSettings> {
  const stored = await chrome.storage.local.get(COPILOT_SETTINGS_KEY);
  return { ...DEFAULT_COPILOT_SETTINGS, ...(stored[COPILOT_SETTINGS_KEY] as Partial<CopilotSettings> | undefined) };
}

async function allowedOrigins(): Promise<string[]> {
  const stored = await chrome.storage.local.get(COPILOT_ALLOWED_ORIGINS_KEY);
  const list = stored[COPILOT_ALLOWED_ORIGINS_KEY];
  return Array.isArray(list) ? list.map(String) : [];
}

function originOf(url: string | undefined): string {
  try {
    return url ? new URL(url).origin : '';
  } catch {
    return '';
  }
}

let seq = 0;

type BridgeDeps = {
  tabManager: TabManager | null;
  acquireLease?: (tabId: number) => CopilotLease | null;
};

export function registerCopilotBridge(getDeps: () => Promise<BridgeDeps>): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== COPILOT_PORT) return;
    let controller: AbortController | null = null;
    let lease: CopilotLease | null = null;
    // La chincheta de la cabecera: con `pinned` el agente no mueve su objetivo a otra pestaña (INFRA-875).
    let pinned = false;
    /** Lo que anuncia el servidor MCP emparejado en este turno, y los nombres que de verdad son suyos. */
    let plugin: ServerPlugin | null = null;
    let pluginNames = new Set<string>();
    const pending = new Map<string, { resolve: (r: UserResponse) => void; reject: (e: Error) => void }>();
    /** Lo que el usuario escribió con la ejecución en marcha; el bucle lo saca entre pasos. */
    const steering: { text: string; images?: string[] }[] = [];

    const emit = (event: WorkerToPanel) => {
      try {
        port.postMessage(event);
      } catch {
        // Panel closed mid-run: the disconnect handler aborts.
      }
    };

    const abortAll = () => {
      controller?.abort();
      for (const p of pending.values()) p.reject(new AgentStopped());
      pending.clear();
    };

    const requestUser = (request: UserRequest): Promise<UserResponse> =>
      new Promise((resolve, reject) => {
        if (controller?.signal.aborted) return reject(new AgentStopped());
        const requestId = `req-${++seq}`;
        pending.set(requestId, { resolve, reject });
        emit({ type: 'request', requestId, request });
      });

    const execTool = async (name: string, args: Record<string, unknown>): Promise<ToolOutcome> => {
      // Un plugin del servidor no toca esta pestaña: se resuelve antes que lo demás (INFRA-909).
      if (pluginNames.has(name)) return plugin!.call(name, args);
      if (pinned && LEAVES_TAB.has(name)) {
        return { ok: false, error: 'La pestaña está chinchetada: el usuario quiere que trabajes aquí. Pídele que quite la chincheta si necesitas ir a otra.' };
      }
      const held = lease;
      if (!held) return { ok: false, error: 'Extension not initialized yet' };
      const res = await held.exec(name, args);
      // El panel sigue a su pestaña; si el agente se ha ido a otra, hay que decírselo por su nombre.
      if (res.success && LEAVES_TAB.has(name)) {
        const tab = await chrome.tabs.get(held.tabId()).catch(() => null);
        emit({ type: 'target', title: (tab?.title || tab?.url || '').trim() || 'otra pestaña' });
      }
      return res.success ? { ok: true, result: res.result } : { ok: false, error: res.error?.message };
    };

    port.onMessage.addListener(async (msg: PanelToWorker) => {
      if (msg.type === 'stop') {
        abortAll();
        return;
      }
      if (msg.type === 'response') {
        const p = pending.get(msg.requestId);
        pending.delete(msg.requestId);
        p?.resolve(msg.response);
        return;
      }
      if (msg.type === 'pin') {
        pinned = msg.pinned;
        return;
      }
      if (msg.type === 'steer') {
        // Sin ejecución en marcha no hay a quién decírselo: el panel ya lo guardó en la
        // conversación y viaja con el siguiente `prompt` como turno de usuario.
        if (controller) steering.push({ text: msg.prompt, images: msg.images });
        return;
      }
      if (msg.type !== 'prompt' || controller) return;

      const runController = new AbortController();
      controller = runController;
      steering.length = 0;
      pinned = msg.pinned ?? pinned;
      let stopped = false;
      let errorMessage: string | null = null;
      try {
        const stored = await loadCopilotSettings();
        const settings: CopilotSettings = { ...stored, mode: msg.mode ?? stored.mode, model: msg.model || stored.model };
        if (!isCopilotConfigured(settings)) throw new Error('Configure a valid endpoint, API key and model before using Copilot.');
        const { tabManager, acquireLease } = await getDeps();
        if (!tabManager || !acquireLease) throw new Error('Extension not initialized yet');
        if (msg.targetTabId === null) throw new Error('This panel has no tab to work in; open it again from its tab.');
        // Every call goes to this tab on its own: one that refuses the debugger (chrome://, the Web
        // Store) leaves the error in the agent's context, and it can switch or open another tab.
        const held = acquireLease(msg.targetTabId);
        if (!held) throw new Error('This tab is busy with another Copilot panel; retry when it finishes.');
        lease = held;
        if (runController.signal.aborted) throw new AgentStopped();

        await runAgent(msg.history, msg.prompt, settings, {
          fetch: (input, init) => fetch(input, init),
          execTool,
          emit,
          requestUser,
          signal: runController.signal,
          takeSteering: () => steering.splice(0),
          serverTools: async () => {
            if (!settings.mcpUrl) return [];
            plugin = await openServer((input, init) => fetch(input, init), settings.mcpUrl, runController.signal);
            pluginNames = new Set(
              plugin.tools.map((t) => t.function.name).filter((n) => !LOCAL_TOOL_NAMES.has(n)),
            );
            return plugin.tools;
          },
          currentTarget: async () => {
            const tabId = held.tabId();
            const tab = await chrome.tabs.get(tabId).catch(() => null);
            return { tabId, origin: originOf(tab?.url) };
          },
          isOriginAllowed: async (origin) => !!origin && (await allowedOrigins()).includes(origin),
          allowOrigin: async (origin) => {
            if (!origin) return;
            const list = new Set(await allowedOrigins());
            list.add(origin);
            await chrome.storage.local.set({ [COPILOT_ALLOWED_ORIGINS_KEY]: [...list] });
          },
          getContext: async () => {
            const tabs = await tabManager.listTabs();
            const state = await execTool('browser_state', { max: 120 });
            return formatPageContext({
              tabs,
              targetTabId: held.tabId(),
              state: state.ok ? String((state.result as { state?: string })?.state ?? '') : null,
              stateError: state.ok ? undefined : state.error,
            });
          },
        }, msg.images ?? []);
      } catch (error) {
        if (error instanceof AgentStopped) {
          stopped = true;
        } else {
          log.warn('[Copilot] Run failed:', error);
          errorMessage = (error as Error).message;
        }
      } finally {
        try {
          await lease?.release();
        } catch (error) {
          log.warn('[Copilot] Could not restore the previous tab:', error);
          errorMessage = `Could not restore the previous tab: ${(error as Error).message}`;
        }
        controller = null;
        plugin = null;
        pluginNames = new Set();
        pending.clear();
        if (errorMessage) emit({ type: 'error', message: errorMessage });
        emit({ type: 'done', stopped });
      }
    });

    // Cerrar el panel no es detener la ejecución: la pestaña se libera aquí, sin esperar a que el
    // `prompt` desenrolle; el `finally` la vuelve a pedir y su bandera interna la hace idempotente.
    port.onDisconnect.addListener(() => {
      abortAll();
      void lease?.release();
    });
  });
}
