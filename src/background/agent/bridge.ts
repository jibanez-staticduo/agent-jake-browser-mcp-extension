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
import { log } from '@/utils/logger';
import { AgentStopped, runAgent, type ToolOutcome } from './loop';
import { formatPageContext } from './context';

type HandleMessage = (message: IncomingMessage) => Promise<OutgoingMessage>;

/** Las dos herramientas que se llevan el objetivo a otra pestaña; con la chincheta puesta, no. */
const LEAVES_TAB = new Set<string>(['browser_switch_tab', 'browser_new_tab']);

export function createCopilotTrafficGate(tabManager: TabManager, handleMessage: HandleMessage) {
  let copilotActive = false;
  let mcpInFlight = 0;

  return {
    async handleMcp(message: IncomingMessage): Promise<OutgoingMessage> {
      // La recarga es control del despliegue, no una herramienta: si se gatea, un panel con una
      // aprobación pendiente bloquea para siempre que este navegador se ponga al día (medido 16-10,
      // el primer merge tras INFRA-858: `502 Copilot is using this browser` y el job rojo).
      // Recargar mata el proceso de todos modos, así que no pisa ninguna acción en curso.
      if (copilotActive && message.type !== 'browser_reload_extension') {
        return {
          id: message.id,
          success: false,
          error: { code: 'COPILOT_BUSY', message: 'Copilot is using this browser; retry when it finishes.' },
        };
      }
      mcpInFlight++;
      try {
        return await handleMessage(message);
      } finally {
        mcpInFlight--;
      }
    },
    acquire(): (() => Promise<void>) | null {
      if (copilotActive || mcpInFlight > 0) return null;
      copilotActive = true;
      const previousTabId = tabManager.getConnectedTabId();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          const currentTabId = tabManager.getConnectedTabId();
          if (currentTabId !== previousTabId) {
            if (previousTabId !== null) await tabManager.connectTab(previousTabId);
            else if (currentTabId !== null) await tabManager.disconnectTab();
          }
        } finally {
          copilotActive = false;
        }
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
  handleMessage: HandleMessage | null;
  acquireLease?: () => (() => Promise<void>) | null;
};

export function registerCopilotBridge(getDeps: () => Promise<BridgeDeps>): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== COPILOT_PORT) return;
    let controller: AbortController | null = null;
    let releaseLease: (() => Promise<void>) | null = null;
    // La chincheta de la cabecera: con `pinned` el agente no mueve su objetivo a otra pestaña (INFRA-875).
    let pinned = false;
    const pending = new Map<string, { resolve: (r: UserResponse) => void; reject: (e: Error) => void }>();

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
      if (pinned && LEAVES_TAB.has(name)) {
        return { ok: false, error: 'La pestaña está chinchetada: el usuario quiere que trabajes aquí. Pídele que quite la chincheta si necesitas ir a otra.' };
      }
      const { tabManager, handleMessage } = await getDeps();
      if (!handleMessage) return { ok: false, error: 'Extension not initialized yet' };
      const res = await handleMessage({ id: `copilot-${++seq}`, type: name as ToolName, payload: args });
      // El panel sigue a su pestaña; si el agente se ha ido a otra, hay que decírselo por su nombre.
      if (res.success && LEAVES_TAB.has(name)) {
        const id = tabManager?.getConnectedTabId() ?? null;
        const tab = id !== null ? await chrome.tabs.get(id).catch(() => null) : null;
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
      if (msg.type !== 'prompt' || controller) return;

      const runController = new AbortController();
      controller = runController;
      pinned = msg.pinned ?? pinned;
      let stopped = false;
      let errorMessage: string | null = null;
      try {
        const stored = await loadCopilotSettings();
        const settings: CopilotSettings = { ...stored, mode: msg.mode ?? stored.mode, model: msg.model || stored.model };
        if (!isCopilotConfigured(settings)) throw new Error('Configure a valid endpoint, API key and model before using Copilot.');
        const { tabManager, acquireLease } = await getDeps();
        if (!tabManager || !acquireLease) throw new Error('Extension not initialized yet');
        releaseLease = acquireLease();
        if (!releaseLease) throw new Error('Browser is busy with another Copilot or MCP call; retry when it finishes.');
        if (runController.signal.aborted) throw new AgentStopped();
        if (msg.targetTabId && tabManager.getConnectedTabId() !== msg.targetTabId) {
          // chrome:// and the Web Store refuse the debugger: the agent still gets the
          // tab list and the error in its context, and can switch or open another tab.
          await tabManager.connectTab(msg.targetTabId).catch((error) => {
            log.warn('[Copilot] Could not attach target tab:', error);
          });
        }

        await runAgent(msg.history, msg.prompt, settings, {
          fetch: (input, init) => fetch(input, init),
          execTool,
          emit,
          requestUser,
          signal: runController.signal,
          currentTarget: async () => {
            const tabId = tabManager.getConnectedTabId();
            const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
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
            const targetTabId = tabManager.getConnectedTabId() ?? msg.targetTabId;
            const state = await execTool('browser_state', { max: 120 });
            return formatPageContext({
              tabs,
              targetTabId,
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
          await releaseLease?.();
        } catch (error) {
          log.warn('[Copilot] Could not restore the previous tab:', error);
          errorMessage = `Could not restore the previous tab: ${(error as Error).message}`;
        }
        controller = null;
        pending.clear();
        if (errorMessage) emit({ type: 'error', message: errorMessage });
        emit({ type: 'done', stopped });
      }
    });

    // Cerrar el panel no es detener la ejecución: si la llamada a una herramienta cuelga, el
    // `finally` del `prompt` nunca llega y la puerta deja el navegador bloqueado para siempre —
    // ni copiloto ni MCP ni la recarga del despliegue. La liberamos aquí; el `finally` la vuelve a
    // pedir y su bandera interna la hace idempotente.
    port.onDisconnect.addListener(() => {
      abortAll();
      void releaseLease?.();
    });
  });
}
