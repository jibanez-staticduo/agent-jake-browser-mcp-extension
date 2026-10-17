#!/usr/bin/env node
// Manual check of what INFRA-907 is for (criteria 1-3 of INFRA-413), in a real Chromium with THIS
// checkout's extension and the server's own commands over the WebSocket:
//   1. two sessions drive their own tabs at the same time, without waiting for each other;
//   2. every answer belongs to the tab that was named (`targetTabId`), not to whichever is in front;
//   3. both tabs stay attached afterwards, and the user's tab is never brought forward.
// Unlike scripts/e2e-multi-attach.mjs (which asks chrome.debugger directly and measures the
// platform), this goes through handleMessage: it measures our routing.
// Not part of CI:  xvfb-run -a node scripts/e2e-two-sessions.mjs
// Own profile (mkdtemp), own ports, own children, nothing of the user's. Ports: PAGES_PORT, WS_PORT.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServerSide, launchExtension } from './lib/e2e-server-socket.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const PAGES = Number(process.env.PAGES_PORT ?? 28998);
const WS = Number(process.env.WS_PORT ?? 28767);
const say = (m) => console.log(`[e2e-two-sessions] ${m}`);
let failures = 0;
const check = (ok, msg) => { say(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failures++; };

const server = createServerSide(say);
const { command, answered } = server;
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ajb-two-')));
const pages = spawn('node', [join(repo, 'tests/fixtures/typing-page-server.mjs'), String(PAGES)], { stdio: 'ignore' });
let context = null;
try {
  context = await launchExtension({ repo, root, wsPort: WS, server, say });
  await new Promise((r) => setTimeout(r, 1500));

  let worker = context.serviceWorkers()[0];
  for (let i = 0; i < 50 && !worker; i++) { await new Promise((r) => setTimeout(r, 100)); worker = context.serviceWorkers()[0]; }
  const tabOf = (id) => worker.evaluate((tabId) => chrome.tabs.get(tabId).then((t) => ({ url: t.url, active: t.active })), id);
  // `attached` is Chrome's flag for any debugger on the target: Playwright keeps its own session on
  // the page it opened, so the list can carry a tab we never touched. What matters is our two.
  const attachedIds = () => worker.evaluate(() => chrome.debugger.getTargets().then((ts) => ts.filter((t) => t.attached && t.type === 'page').map((t) => t.tabId)));
  const domValue = async (url) => {
    const page = context.pages().find((p) => p.url() === url);
    if (!page) throw new Error(`no page for ${url}`);
    return page.evaluate(() => document.getElementById('plain')?.value ?? null);
  };
  const form = (marker) => `http://127.0.0.1:${PAGES}/form#${marker}`;

  // The user's own tab, which must never move. It gets a real page: a read with no named tab
  // auto-attaches whatever is in front, and about:blank is not readable by a content script.
  const userTabId = await worker.evaluate(() => chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((ts) => ts[0]?.id));
  await worker.evaluate((arg) => chrome.tabs.update(arg.id, { url: arg.url }), { id: userTabId, url: form('U') });
  await new Promise((r) => setTimeout(r, 1200));
  const userTab = (await tabOf(userTabId)).url;

  // Two sessions, two tabs of their own (the server adopts the id each browser_new_tab returns).
  const openA = await command('browser_new_tab', { url: form('A') });
  const openB = await command('browser_new_tab', { url: form('B') });
  const ta = openA.result?.tab?.id;
  const tb = openB.result?.tab?.id;
  check(answered(openA) && answered(openB) && ta && tb && ta !== tb, `dos sesiones abren su pestaña (${ta}, ${tb})`);

  const attachedBefore = await attachedIds();
  check(attachedBefore.includes(ta) && attachedBefore.includes(tb), `las dos están adjuntas ANTES de la tanda (${attachedBefore.join(', ')})`);

  // 1 + 2: both navigate at once, each to its own page. The old single connected tab would have
  // sent one of them to the other's tab (or serialized them behind a detach/attach).
  const [navA, navB] = await Promise.all([
    command('browser_navigate', { url: `http://127.0.0.1:${PAGES}/form#A2`, targetTabId: ta }),
    command('browser_navigate', { url: `http://127.0.0.1:${PAGES}/form#B2`, targetTabId: tb }),
  ]);
  const [afterA, afterB] = await Promise.all([tabOf(ta), tabOf(tb)]);
  check(answered(navA) && answered(navB), 'los dos navigate responden');
  check(afterA.url.endsWith('#A2') && afterB.url.endsWith('#B2'), `cada navigate acaba en su pestaña (${afterA.url} · ${afterB.url})`);

  // Click + type interleaved, different text in each; the value must land in its own field.
  const [clickA, clickB] = await Promise.all([
    command('browser_click', { selector: '#plain', targetTabId: ta }),
    command('browser_click', { selector: '#plain', targetTabId: tb }),
  ]);
  const [typeA, typeB] = await Promise.all([
    command('browser_type', { selector: '#plain', text: 'AAAA', clear: true, targetTabId: ta }),
    command('browser_type', { selector: '#plain', text: 'BBBB', clear: true, targetTabId: tb }),
  ]);
  check(answered(clickA) && answered(clickB) && answered(typeA) && answered(typeB), 'click y type de las dos sesiones responden');
  const [va, vb] = await Promise.all([domValue(afterA.url), domValue(afterB.url)]);
  check(va === 'AAAA' && vb === 'BBBB', `lo escrito va al campo de su sesión (${va} · ${vb})`);

  // Snapshot and screenshot of both at once: each answer is about its own tab.
  const [stateA, stateB, shotA, shotB] = await Promise.all([
    command('browser_state', { targetTabId: ta }),
    command('browser_state', { targetTabId: tb }),
    command('browser_screenshot', { targetTabId: ta }),
    command('browser_screenshot', { targetTabId: tb }),
  ]);
  const hasFields = (r) => /plain|password|area/.test(String(r.result?.state ?? ''));
  check(answered(stateA) && answered(stateB) && hasFields(stateA) && hasFields(stateB), 'browser_state de las dos pestañas responde con su DOM');
  const png = (r) => String(r.result?.image ?? '');
  check(png(shotA).length > 1000 && png(shotB).length > 1000 && png(shotA) !== png(shotB), 'cada captura es la de su pestaña (bytes distintos)');

  // 3: both tabs still attached, and the user's tab never moved.
  const attached = await attachedIds();
  check(attached.includes(ta) && attached.includes(tb), `las dos pestañas siguen adjuntas DESPUÉS de la tanda (${attached.join(', ')})`);
  const stillUser = await worker.evaluate((id) => chrome.tabs.get(id).then((t) => t.active), userTabId);
  check(stillUser === true, `la pestaña del usuario sigue en frente (${userTab})`);

  // A command naming no tab takes the one in front and must not disturb the sessions.
  const readout = await command('browser_state', {});
  const attachedAfter = await attachedIds();
  check(answered(readout), 'una lectura sin pestaña responde (auto-engancha la de enfrente)');
  check(attachedAfter.includes(ta) && attachedAfter.includes(tb), 'y deja adjuntas las dos sesiones');

  await command('browser_close_tab', { tabId: ta, targetTabId: tb });
  await command('browser_close_tab', { tabId: tb, targetTabId: tb });
} catch (error) {
  check(false, `excepción: ${error.message}`);
} finally {
  pages.kill();
  await context?.close().catch(() => undefined);
  server.close();
  rmSync(root, { recursive: true, force: true });
}
say(failures ? `${failures} FAIL` : 'todo PASS');
process.exit(failures ? 1 : 0);
