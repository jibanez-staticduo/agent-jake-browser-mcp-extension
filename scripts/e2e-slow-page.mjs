#!/usr/bin/env node
// Manual end-to-end check of INFRA-699 in a real Chromium with this checkout's extension (not part of CI):
// a page that never finishes loading must not hang the commands that follow it.
//   xvfb-run -a node scripts/e2e-slow-page.mjs      (needs a display: extensions do not run in old headless)
// It plays the server's part: a WebSocket on 127.0.0.1:WS (the extension is built to dial it) that sends the
// commands the agent-browser-server sends, one at a time as its per-browser queue does, and cuts each at 30 s
// as it does. Pages come from tests/fixtures/slow-page-server.mjs. Own profile (mkdtemp), own ports, own
// children, nothing of the user's. Ports: PAGES_PORT and WS_PORT in the environment (default 28999, 28765).
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repo = fileURLToPath(new URL('..', import.meta.url));
const PAGES = Number(process.env.PAGES_PORT ?? 28999);
const WS = Number(process.env.WS_PORT ?? 28765);
const SERVER_CUT_MS = 30_000;
const say = (m) => console.log(`[e2e-slow-page] ${m}`);
let failures = 0;
const check = (ok, msg) => { say(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failures++; };

// ---- the server's side of the socket ------------------------------------------------------------
let socket = null;
const waiting = new Map();
function frame(text) {
  const body = Buffer.from(text);
  const head = body.length < 126 ? Buffer.from([0x81, body.length])
    : Buffer.concat([Buffer.from([0x81, 126]), Buffer.from([body.length >> 8, body.length & 255])]);
  return Buffer.concat([head, body]);
}
function onData(buf) { // client frames are masked; the extension's replies and heartbeats are text
  while (buf.length >= 2) {
    let len = buf[1] & 127, at = 2;
    if (len === 126) { len = buf.readUInt16BE(2); at = 4; } else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); at = 10; }
    const mask = buf.subarray(at, at + 4);
    const payload = Buffer.from(buf.subarray(at + 4, at + 4 + len)).map((b, i) => b ^ mask[i % 4]);
    buf = buf.subarray(at + 4 + len);
    if ((payload.length === 0) || !(payload[0] === 0x7b)) continue;
    const msg = JSON.parse(payload.toString());
    waiting.get(msg.id)?.(msg);
  }
}
const wsServer = createServer().on('upgrade', (req, sock) => {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.on('data', onData).on('error', () => undefined);
  socket = sock;
});

let n = 0;
/** One command, then its answer or the server's cut. */
async function command(type, payload = {}) {
  const id = `e2e-${++n}`;
  const t0 = Date.now();
  const answer = await new Promise((resolve) => {
    const cut = setTimeout(() => { waiting.delete(id); resolve({ timedOut: true }); }, SERVER_CUT_MS);
    waiting.set(id, (msg) => { clearTimeout(cut); waiting.delete(id); resolve(msg); });
    socket.write(frame(JSON.stringify({ id, type, payload })));
  });
  const ms = Date.now() - t0;
  say(`${type} ${JSON.stringify(payload)} -> ${answer.timedOut ? 'NO ANSWER (server cut)' : answer.success ? 'ok' : `error ${answer.error?.message}`} in ${ms} ms`);
  return { ...answer, ms };
}
const answered = (r) => !r.timedOut && r.success;

// ---- run ----------------------------------------------------------------------------------------
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ajb-slow-')));
const pages = spawn('node', [join(repo, 'tests/fixtures/slow-page-server.mjs'), String(PAGES)], { stdio: 'ignore' });
let context = null;
try {
  say('building the extension');
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('VITE_')) delete env[k];
  env.VITE_WS_PORT = String(WS);
  execFileSync('npx', ['vite', 'build', '--outDir', join(root, 'ext'), '--emptyOutDir'], { cwd: repo, env, stdio: 'pipe' });

  await new Promise((r) => wsServer.listen(WS, '127.0.0.1', r));
  context = await chromium.launchPersistentContext(join(root, 'profile'), {
    headless: false,
    args: [`--disable-extensions-except=${join(root, 'ext')}`, `--load-extension=${join(root, 'ext')}`, '--no-sandbox'],
  });
  for (let i = 0; i < 100 && !socket; i++) await new Promise((r) => setTimeout(r, 100));
  if (!socket) throw new Error(`the extension never connected to 127.0.0.1:${WS}`);
  say('extension connected');

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
  wsServer.close();
  rmSync(root, { recursive: true, force: true });
}
say(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
