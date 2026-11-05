import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { launchAgentHarness, type AgentHarness } from './helpers/agent-harness';

// INFRA-450 (P5 of INFRA-413) — el contrato de la pestaña por sesión que la épica pide probar:
// error explícito al operar una pestaña que ya no es tuya, cierre de ventana por el reaper y el
// traspaso de browser_claim_tab.
//
// El rechazo TAB_OWNED y el propio browser_claim_tab los responde el SERVER sin enviar nada a la
// extensión (server/src/session-tabs.ts; server/tests/ownership.test.ts los cubre allí): no se
// reimplementan aquí. Lo que prueba este e2e es el contrato que la extensión debe a ese ruteo:
//  - un comando que nombra una pestaña inexistente falla con TAB_GONE explícito y no toca nada más;
//  - el reaper cierra la ventana de una sesión de una pieza (browser_close_window) sin mover a Dani;
//  - tras el traspaso, el targetTabId de la sesión nueva maneja la pestaña que abrió la anterior
//    sin activarla (windows.create activa la suya dentro de su ventana: ese es el único evento
//    de activación esperado, nota del arquitecto P5).

const html = (url: string | undefined) => {
  const { pathname } = new URL(url ?? '/', 'http://127.0.0.1');
  if (pathname === '/sesion-a' || pathname === '/sesion-b') {
    const key = pathname.slice(-1).toUpperCase();
    return `<!doctype html><html><head><meta charset="utf-8"><title>SESION-${key}</title></head>
<body style="margin:0"><h1>SESION-${key}</h1><input id="plain" type="text" aria-label="plain"></body></html>`;
  }
  return '<!doctype html><title>Dani fixture</title><body style="background:#eeeeee"><h1>Ventana de Dani (fixture)</h1>';
};

async function findPage(harness: AgentHarness, url: string): Promise<Page> {
  for (let i = 0; i < 100; i++) {
    const found = harness.context.pages().find(p => p.url() === url);
    if (found) return found;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`the fixture page ${url} never appeared in the context`);
}

// Eventos de activación/foqueo que el agente no provocó: los suyos propios (su pestaña al crear
// la ventana, su ventana) no cuentan (invariante del arquitecto P5).
const violations = (events: Awaited<ReturnType<AgentHarness['agentEvents']>>, agentTabIds: Set<number>, agentWindowIds: Set<number>) =>
  events.filter(e =>
    (e.type === 'onActivated' && !agentTabIds.has(e.tabId!)) ||
    (e.type === 'onFocusChanged' && e.windowId !== -1 && !agentWindowIds.has(e.windowId)));

test('el reaper cierra la ventana de la sesión y operar esa pestaña da TAB_GONE explícito', async () => {
  test.setTimeout(90_000);
  const harness = await launchAgentHarness(html);
  try {
    const opened = await harness.command('browser_new_tab', { url: `${harness.origin}/sesion-a` });
    expect(opened.success).toBe(true);
    expect(opened.result.windowCreated).toBe(true);
    const tabId = opened.result.tab.id;
    const windowId = opened.result.windowId;

    // Como lo hace el reaper del server (tab-reaper.ts:277): browser_close_window con windowId y
    // las tabIds rastreadas; la extensión responde la ventana y las pestañas que cerró de verdad.
    const closed = await harness.command('browser_close_window', { windowId, tabIds: [tabId] });
    expect(closed.success).toBe(true);
    expect(closed.result).toMatchObject({ windowId, closed: true, closedTabIds: [tabId] });

    // La ventana ya no existe y la de Dani no se movió: cerrar una ventana de fondo no roba foco.
    const gone = await harness.worker.evaluate(async (id: number) => {
      try { await chrome.windows.get(id); return false; } catch { return true; }
    }, windowId);
    expect(gone).toBe(true);
    const dani = await harness.daniState();
    expect(dani.activeTabId).toBe(harness.daniTabId);
    expect(dani.focusedWindowId).toBe(harness.baselineWindowId);

    // El comando que nombra la pestaña ya cerrada falla con el error explícito del ruteo, no
    // actúa sobre otra pestaña ni abre nada nuevo.
    const eventsBefore = (await harness.agentEvents()).length;
    // La respuesta de error del wire es { success: false, error: { code, message } }.
    const stale = await harness.command('browser_navigate', { url: `${harness.origin}/sesion-b`, targetTabId: tabId });
    expect(stale.success).toBe(false);
    const message = String(stale.error?.message ?? JSON.stringify(stale));
    expect(message).toContain('TAB_GONE');
    expect(message).toContain('browser_new_tab');
    const staleState = await harness.command('browser_state', { targetTabId: tabId });
    expect(String(staleState.error?.message ?? JSON.stringify(staleState))).toContain('TAB_GONE');
    const after = await harness.agentEvents();
    expect(violations(after.slice(eventsBefore), new Set([tabId]), new Set([windowId]))).toEqual([]);
    expect(await harness.daniState()).toEqual({ activeTabId: harness.daniTabId, focusedWindowId: harness.baselineWindowId });
  } finally {
    await harness.close();
  }
});

test('tras el traspaso (browser_claim_tab), la sesión nueva maneja la pestaña ajena sin activarla', async () => {
  test.setTimeout(90_000);
  const harness = await launchAgentHarness(html);
  try {
    // La sesión A abre su pestaña: windows.create la activa DENTRO de su ventana (único evento
    // esperado; no es robarle nada a Dani — nota del CTO, medida como invariante, no contador).
    const opened = await harness.command('browser_new_tab', { url: `${harness.origin}/sesion-a` });
    expect(opened.success).toBe(true);
    const tabId = opened.result.tab.id;
    const windowId = opened.result.windowId;
    const created = (await harness.agentEvents()).filter(e => e.type === 'onActivated' && e.tabId === tabId);
    expect(created.length, 'windows.create activa su propia pestaña una sola vez').toBe(1);

    // El server ya le pasó la pestaña a la sesión B (browser_claim_tab, server/src/session-tabs.ts:
    // ownership.test.ts lo cubre allí). Lado extensión: el targetTabId de B maneja la pestaña que
    // abrió A — escribir llega a su campo — sin un solo evento de activación nuevo.
    const typed = await harness.command('browser_type', { selector: '#plain', text: 'TRASPASADA', clear: true, targetTabId: tabId });
    expect(typed.success).toBe(true);
    const page = await findPage(harness, `${harness.origin}/sesion-a`);
    expect(await page.locator('#plain').inputValue()).toBe('TRASPASADA');

    const events = await harness.agentEvents();
    expect(events.filter(e => e.type === 'onActivated' && e.tabId === tabId).length, 'manejarla no la activa').toBe(1);
    expect(violations(events, new Set([tabId]), new Set([windowId]))).toEqual([]);
    const dani = await harness.daniState();
    expect(dani.activeTabId).toBe(harness.daniTabId);
    expect(dani.focusedWindowId).toBe(harness.baselineWindowId);
  } finally {
    await harness.close();
  }
});
