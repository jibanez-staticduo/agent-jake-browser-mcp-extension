#!/usr/bin/env node
// Manual end-to-end check of INFRA-699 in a real Chromium with this checkout's extension (not part of CI):
// a page that never finishes loading must not hang the commands that follow it.
//   xvfb-run -a node scripts/e2e-slow-page.mjs      (needs a display: extensions do not run in old headless)
// It plays the server's part: a WebSocket on 127.0.0.1:WS (the extension is built to dial it) that sends the
// commands the agent-browser-server sends, one at a time as its per-browser queue does, and cuts each at 30 s
// as it does. Pages come from tests/fixtures/slow-page-server.mjs. Own profile (mkdtemp), own ports, own
// children, nothing of the user's. Ports: PAGES_PORT and WS_PORT in the environment (default 28999, 28765).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServerSide, launchExtension, SERVER_CUT_MS } from './lib/e2e-server-socket.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const PAGES = Number(process.env.PAGES_PORT ?? 28999);
const WS = Number(process.env.WS_PORT ?? 28765);
const say = (m) => console.log(`[e2e-slow-page] ${m}`);
let failures = 0;
const check = (ok, msg) => { say(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failures++; };

// ---- the server's side of the socket (scripts/lib/e2e-server-socket.mjs) ---------------------------
const server = createServerSide(say);
const { command, answered } = server;

// ---- run ----------------------------------------------------------------------------------------
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ajb-slow-')));
const pages = spawn('node', [join(repo, 'tests/fixtures/slow-page-server.mjs'), String(PAGES)], { stdio: 'ignore' });
let context = null;
try {
  context = await launchExtension({ repo, root, wsPort: WS, server, say });

  const hang = `http://127.0.0.1:${PAGES}/hang`;
  const ok = `http://127.0.0.1:${PAGES}/ok`;

  // The case qa reported: open the page that never loads, then keep working in the same session.
  const opened = await command('browser_new_tab', { url: hang });
  check(answered(opened) && opened.ms < SERVER_CUT_MS, 'new_tab on /hang answers before the server cut');
  const hangTab = opened.result?.tab?.id;
  check(opened.result?.loaded === false && opened.result?.tab?.connected === true, 'it says loaded:false and the tab is connected');
  const session = { targetTabId: hangTab };
  check(answered(await command('browser_state', session)), 'state on the tab that is still loading answers');
  check(answered(await command('browser_switch_tab', { tabId: hangTab, ...session })), 'switch_tab to it answers');

  // Every other tool on that tab: an error is an answer (there is little to click here), a silence is not.
  const sweep = [
    ['browser_snapshot', {}], ['browser_find', { text: 'hang' }], ['browser_get_text', { selector: 'h1' }],
    ['browser_is_visible', { selector: 'h1' }], ['browser_get_attribute', { selector: 'h1', attribute: 'id' }],
    ['browser_highlight', { selector: 'h1' }], ['browser_wait_for_element', { selector: 'h1', timeout: 2 }],
    ['browser_evaluate', { code: 'document.title' }], ['browser_get_html', {}], ['browser_screenshot', {}],
    ['browser_pdf', {}], ['browser_get_console_logs', {}], ['browser_network_requests', {}],
    ['browser_click', { selector: 'h1' }], ['browser_hover', { selector: 'h1' }], ['browser_press_key', { key: 'Tab' }],
    ['browser_wait', { time: 1 }], ['browser_resize_viewport', { width: 800, height: 600 }],
    ['browser_reload', {}], ['browser_navigate', { url: hang }], ['browser_go_back', {}],
  ];
  const silent = [];
  for (const [type, payload] of sweep) if ((await command(type, { ...payload, ...session })).timedOut) silent.push(type);
  check(silent.length === 0, `every tool answers on the tab that is still loading${silent.length ? ` (silent: ${silent.join(', ')})` : ''}`);

  // And the rest of the browser: nothing may wait behind the loading tab.
  const list = await command('browser_list_tabs');
  check(answered(list), 'list_tabs answers');
  const other = await command('browser_new_tab', { url: ok });
  check(answered(other), 'new_tab on /ok answers while /hang is still loading');
  const otherTab = other.result?.tab?.id;
  check(answered(await command('browser_state', { targetTabId: otherTab })), 'state on the other tab answers');
  check(answered(await command('browser_state', session)), 'state back on the loading tab answers');
  check(answered(await command('browser_close_tab', { tabId: hangTab, targetTabId: otherTab })), 'close_tab on the loading tab answers');
  check(answered(await command('browser_close_tab', { tabId: otherTab, targetTabId: otherTab })), 'close_tab on the other tab answers');
} catch (error) {
  failures++;
  say(`FAIL ${error.message}`);
} finally {
  await context?.close().catch(() => undefined);
  pages.kill();
  server.close();
  rmSync(root, { recursive: true, force: true });
}
say(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
