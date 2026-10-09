#!/usr/bin/env node
// Manual end-to-end check in a real Chromium with this checkout's extension (not part of CI):
// agent tabs stay in the BACKGROUND, and typing into a background tab's field works.
//   node scripts/e2e-background-tab.mjs      (xvfb-run -a on a Linux box without a display)      (needs a display: extensions do not run in old headless)
// It plays the server's part: a WebSocket on 127.0.0.1:WS (the extension is built to dial it) that sends the
// commands the agent-browser-server sends, one at a time as its per-browser queue does, and cuts each at 30 s
// as it does. Pages come from tests/fixtures/slow-page-server.mjs. Own profile (mkdtemp), own ports, own
// children, nothing of the user's. Ports: PAGES_PORT and WS_PORT in the environment (default 28999, 28765).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServerSide, launchExtension } from './lib/e2e-server-socket.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const PAGES = Number(process.env.PAGES_PORT ?? 28999);
const WS = Number(process.env.WS_PORT ?? 28765);
const say = (m) => console.log(`[e2e-background-tab] ${m}`);
let failures = 0;
const check = (ok, msg) => { say(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failures++; };

// ---- the server's side of the socket (scripts/lib/e2e-server-socket.mjs) ---------------------------
const server = createServerSide(say);
const { command, answered } = server;

// ---- run ----------------------------------------------------------------------------------------
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ajb-bg-')));
const pages = spawn('node', [join(repo, 'tests/fixtures/typing-page-server.mjs'), String(PAGES)], { stdio: 'ignore' });
let context = null;
try {
  context = await launchExtension({ repo, root, wsPort: WS, server, say });
  await new Promise((r) => setTimeout(r, 1500));

  let worker = context.serviceWorkers()[0];
  for (let i = 0; i < 50 && !worker; i++) { await new Promise((r) => setTimeout(r, 100)); worker = context.serviceWorkers()[0]; }
  const tabInfo = (id) => worker.evaluate((tabId) => chrome.tabs.get(tabId).then((t) => ({ active: t.active, url: t.url })), id);
  const activeTabs = () => worker.evaluate(() => chrome.tabs.query({ active: true }).then((ts) => ts.map((t) => t.id)));
  const pageOf = (id, url) => context.pages().find((p) => p.url() === url);
  const probe = (page, sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    return { length: [...el.value].length, value: el.value, events: window.__ctlEvents ?? 0 };
  }, sel);

  const form = `http://127.0.0.1:${PAGES}/form`;
  const userTab = context.pages()[0];
  const userUrl = `http://127.0.0.1:${PAGES}/form?user=1`;
  await userTab.goto(userUrl);
  const [userTabId] = await activeTabs();
  say(`the "user's" tab is ${userTabId}`);

  // 0. browser_navigate never drives the user's tab.
  const ok = `http://127.0.0.1:${PAGES}/form`;
  const n1 = await command('browser_navigate', { url: ok });
  const t1 = n1.result?.tabId;
  check(answered(n1) && typeof t1 === 'number' && t1 !== userTabId, `navigate with no tab connected opens a new tab (${t1})`);
  check((await tabInfo(t1)).active === false, 'that tab is in the background');
  check((await tabInfo(userTabId)).url === userUrl && (await activeTabs()).includes(userTabId), "the user's tab was not navigated and is still in front");
  await command('browser_close_tab', { tabId: t1 });
  const st = await command('browser_state'); // read-only: auto-attaches the user's active tab
  check(answered(st), 'a read-only tool still auto-attaches the active tab');
  const n2 = await command('browser_navigate', { url: ok });
  const t2 = n2.result?.tabId;
  check(answered(n2) && typeof t2 === 'number' && t2 !== userTabId, `navigate on an auto-attached tab opens a new tab (${t2})`);
  check((await tabInfo(t2)).active === false, 'that tab is in the background');
  check((await tabInfo(userTabId)).url === userUrl, "the auto-attached user's tab was not navigated");
  const n3 = await command('browser_navigate', { url: `http://localhost:${PAGES}/form`, targetTabId: t2 });
  check(answered(n3) && n3.result?.tabId === undefined && (await tabInfo(t2)).url.startsWith('http://localhost'), 'navigate on the tab the agent opened navigates it in place');
  await command('browser_close_tab', { tabId: t2, targetTabId: t2 });

  // 1. The agent opens a tab: it stays in the background.
  const opened = await command('browser_new_tab', { url: form });
  check(answered(opened), 'new_tab answers');
  const tabId = opened.result?.tab?.id;
  const session = { targetTabId: tabId };
  check((await tabInfo(tabId)).active === false, 'the new tab is not active');
  const page = pageOf(tabId, form);
  check(!!page, 'playwright sees the new tab');

  const cases = [
    ['#plain', 'plain <input>', 'ab-123_XYZ'],
    ['#ctl', 'controlled (React-style) <input>', 'controlled-42'],
    ['#pw', 'password <input> (secret-shaped payload)', 's3cr3t-P@ss-0123456789'],
    ['#ta', '<textarea>', 'line one'],
    ['#eaten', 'input that swallows every key (in-page fallback)', 'fallback-ok-77'],
  ];
  for (const [sel, label, text] of cases) {
    const before = (await tabInfo(tabId)).active;
    const secret = sel === '#pw' || sel === '#eaten';
    const r = await command('browser_type', { selector: sel, text, clear: false, ...(secret ? { secret: true } : {}), ...session });
    const after = (await tabInfo(tabId)).active;
    const got = await probe(page, sel);
    check(answered(r), `${label}: browser_type answers`);
    check(got.length === [...text].length, `${label}: the field holds ${[...text].length} chars after typing (holds ${got.length})`);
    check(before === false && after === false, `${label}: the tab stayed in the background (active before=${before}, after=${after})`);
    if (sel === '#ctl') check(got.value === text, `${label}: the page's own state saw every character`);
    // Replace with clear:true: no leftovers, no doubling.
    const r2 = await command('browser_type', { selector: sel, text: 'Z9', clear: true, ...session });
    const got2 = await probe(page, sel);
    check(answered(r2) && got2.length === 2, `${label}: clear:true replaces the value (holds ${got2.length}, wanted 2)`);
    if (secret) check(!JSON.stringify(r).includes(text), `${label}: the answer to a secret-flagged call does not echo the text`);
    if (sel === '#eaten') check(r.result?.fallback === 'native-setter', `${label}: the answer says the in-page fallback ran`);
  }
  // Same field, other ways to end up in the background.
  const typed = async (label, sel, text, tid, pg) => {
    await pg.evaluate((s) => { document.querySelector(s).value = ''; }, sel);
    const r = await command('browser_type', { selector: sel, text, clear: true, targetTabId: tid });
    const got = await probe(pg, sel);
    check(answered(r) && got.length === [...text].length, `${label}: holds ${got.length} of ${[...text].length} chars`);
  };
  // (a) a cross-origin navigation of the connected background tab (the renderer is swapped).
  const other = `http://localhost:${PAGES}/form`;
  const nav = await command('browser_navigate', { url: other, ...session });
  check(answered(nav), 'navigate to another origin answers');
  const page2 = context.pages().find((p) => p.url() === other);
  await typed('after a cross-origin navigation', '#plain', 'after-nav-1', tabId, page2);
  check((await tabInfo(tabId)).active === false, 'still in the background after navigating');
  // (b) a tab that WAS in front and the user moved away from.
  await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), tabId);
  await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), userTabId);
  check((await tabInfo(tabId)).active === false, 'the tab went back to the background');
  await typed('a tab the user moved away from', '#plain', 'was-front-1', tabId, page2);
  // (c) the tab sits in a window that is minimized.
  const winId = (await worker.evaluate((id) => chrome.tabs.get(id), tabId)).windowId;
  await worker.evaluate((w) => chrome.windows.update(w, { state: 'minimized' }), winId);
  await new Promise((r) => setTimeout(r, 800));
  await typed('window minimized', '#plain', 'minimized-1', tabId, page2);
  await worker.evaluate((w) => chrome.windows.update(w, { state: 'normal' }), winId);
  // (d) the tab sits in a second window that is not focused and is behind the first one.
  const w2 = await worker.evaluate(() => chrome.windows.create({ url: 'about:blank', focused: false }).then((w) => ({ id: w.id, tab: w.tabs[0].id })));
  await worker.evaluate((w) => chrome.windows.update(w, { focused: true }), winId);
  const moved = await worker.evaluate(([t, w]) => chrome.tabs.move(t, { windowId: w, index: -1 }).then((x) => x.id), [tabId, w2.id]);
  await worker.evaluate((id) => chrome.tabs.update(id, { active: false }).catch(() => {}), tabId);
  await typed('tab of an unfocused second window', '#plain', 'second-win-1', tabId, page2);
  check((await activeTabs()).includes(userTabId), `the user's tab ${userTabId} is still the active one of its window`);
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
