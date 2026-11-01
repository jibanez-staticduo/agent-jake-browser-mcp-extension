import { test, expect } from '@playwright/test';
import { launchAgentHarness } from './helpers/agent-harness';

// INFRA-450 (P5 of INFRA-413) — criterion 4 of the epic: a real login on a local test page by the
// browser-login skill's flow (state → click field → fill → submit → verify), with browser_fill_secret
// semantics for the password and the TOTP, without ever bringing the tab to the front.
// browser_fill_secret resolves its op:// reference on the server (src/tools/interaction.ts:fillSecretTool)
// and sends exactly `browser_type {text, secret: true, clear}` to the extension: that downstream
// message is what this e2e drives, so no 1Password is needed here (the op read is covered by the
// server's fill-secret.test.ts). The credentials are fake and committed — the page itself checks
// them and only says LOGUEADO when both are right. Not run in CI (Playwright is not in CI).

const FAKE_PASSWORD = 'FAKE-CLAVE-INFRA450';
const FAKE_TOTP = '424242';

const loginPage = `<!doctype html><html><head><meta charset="utf-8"><title>login</title></head><body>
<h1>Acceso (fixture INFRA-450)</h1>
<input id="usuario" type="text" aria-label="usuario">
<input id="clave" type="password" aria-label="clave">
<input id="totp" type="text" aria-label="codigo">
<button id="entrar" type="button">Entrar</button>
<script>
  document.getElementById('entrar').addEventListener('click', () => {
    const ok = document.getElementById('clave').value === '${FAKE_PASSWORD}'
      && document.getElementById('totp').value === '${FAKE_TOTP}';
    document.title = ok ? 'LOGUEADO-INFRA450' : 'LOGIN-FALLIDO';
    document.body.innerHTML = '<p id="resultado">' + (ok ? 'SESION-INICIADA-INFRA450' : 'credenciales incorrectas') + '</p>';
  });
</script></body></html>`;

const html = (url: string | undefined) =>
  (url ?? '/').startsWith('/login') ? loginPage
    : '<!doctype html><title>Dani fixture</title><body style="background:#eeeeee"><h1>Ventana de Dani (fixture)</h1>';

test('C4 · login real por fill_secret (password + TOTP) en pestaña de fondo, sin traerla al frente', async () => {
  test.setTimeout(180_000);
  const harness = await launchAgentHarness(html);
  try {
    const loginUrl = `${harness.origin}/login`;
    const opened = await harness.command('browser_new_tab', { url: loginUrl });
    expect(opened.success).toBe(true);
    expect(opened.result.windowCreated).toBe(true);
    const tabId = opened.result.tab.id;
    const agentTabId = tabId;
    const agentWindowId = opened.result.windowId;
    const page = await (async () => {
      for (let i = 0; i < 100; i++) {
        const found = harness.context.pages().find(p => p.url() === loginUrl);
        if (found) return found;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('la página de login no apareció');
    })();

    const step = async (label: string, run: () => Promise<any>) => {
      const reply = await run();
      expect(reply.success, label).toBe(true);
      // The agent's own tab is the active one inside its own window (windows.create): what must
      // not move is Dani's tab and window (architect P5 invariant), checked after every step.
      const dani = await harness.daniState();
      expect(dani.activeTabId, `pestaña de Dani tras ${label}`).toBe(harness.daniTabId);
      expect(dani.focusedWindowId, `ventana enfocada tras ${label}`).toBe(harness.baselineWindowId);
      return reply;
    };

    // Flujo de la skill browser-login: snapshot, campos, fill_secret (secreto: solo longitudes), submit.
    const state = await step('snapshot', () => harness.command('browser_state', { targetTabId: tabId }));
    expect(String(state.result.state)).toContain('usuario');
    await step('click usuario', () => harness.command('browser_click', { selector: '#usuario', targetTabId: tabId }));
    await step('type usuario', () => harness.command('browser_type', { selector: '#usuario', text: 'agente-e2e', clear: true, targetTabId: tabId }));

    const pass = await step('fill_secret password', () =>
      harness.command('browser_type', { selector: '#clave', text: FAKE_PASSWORD, secret: true, clear: true, targetTabId: tabId }));
    expect(pass.result).toMatchObject({ typed: true, verified: true, length: FAKE_PASSWORD.length });
    expect(JSON.stringify(pass)).not.toContain(FAKE_PASSWORD); // la respuesta lleva longitudes, nunca el valor

    const totp = await step('fill_secret TOTP', () =>
      harness.command('browser_type', { selector: '#totp', text: FAKE_TOTP, secret: true, clear: true, targetTabId: tabId }));
    expect(totp.result).toMatchObject({ typed: true, verified: true, length: FAKE_TOTP.length });
    expect(JSON.stringify(totp)).not.toContain(FAKE_TOTP);

    await step('submit', () => harness.command('browser_click', { selector: '#entrar', targetTabId: tabId }));
    await expect(page.locator('#resultado')).toHaveText('SESION-INICIADA-INFRA450', { timeout: 15_000 });
    const title = await harness.worker.evaluate(async (id: number) => (await chrome.tabs.get(id)).title, tabId);
    expect(title).toBe('LOGUEADO-INFRA450');

    // 0 onActivated/onFocusChanged provocados por el agente durante todo el flujo.
    const events = await harness.agentEvents();
    const violations = events.filter(e =>
      (e.type === 'onActivated' && e.tabId !== agentTabId) ||
      (e.type === 'onFocusChanged' && e.windowId !== agentWindowId));
    console.log(`[background-login] eventos del flujo (${events.length}): ${JSON.stringify(events)}`);
    expect(violations).toEqual([]);
    const dani = await harness.daniState();
    expect(dani.activeTabId).toBe(harness.daniTabId);
    expect(dani.focusedWindowId).toBe(harness.baselineWindowId);
  } finally {
    await harness.close();
  }
});
