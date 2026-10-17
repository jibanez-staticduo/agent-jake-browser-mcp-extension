#!/usr/bin/env node
// Manual check of the assumption INFRA-413 rests on (criterion 1-3 of the epic), in a real Chromium:
// can this extension hold the debugger on SEVERAL tabs at once and drive them CONCURRENTLY, in
// windows that are not in front, without touching the tab or the window the user is looking at?
// Not part of CI:   xvfb-run -a node scripts/e2e-multi-attach.mjs
// It asks the service worker directly (chrome.debugger), so it measures the platform, not our code:
// whatever it answers is what a per-tab debugger would be built on. Own profile (mkdtemp), own port,
// nothing of the user's. Port: WS_PORT in the environment (default 28766).
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServerSide, launchExtension } from './lib/e2e-server-socket.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const WS = Number(process.env.WS_PORT ?? 28766);
const say = (m) => console.log(`[e2e-multi-attach] ${m}`);
let failures = 0;
const check = (ok, msg) => { say(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failures++; };

const server = createServerSide(say);
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ajb-multi-')));
let context = null;
try {
  context = await launchExtension({ repo, root, wsPort: WS, server, say });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

  const out = await worker.evaluate(async () => {
    const activated = [];
    chrome.tabs.onActivated.addListener((e) => activated.push(e.tabId));
    const focusChanges = [];
    chrome.windows.onFocusChanged.addListener((id) => focusChanges.push(id));
    const baselineWindow = (await chrome.windows.getLastFocused()).id;

    // Three sessions: three windows, none of them focused, one tab each.
    const sessions = [];
    for (let i = 0; i < 3; i++) {
      const w = await chrome.windows.create({ url: 'about:blank', focused: false });
      sessions.push({ windowId: w.id, tabId: w.tabs[0].id });
    }
    const target = (s) => ({ tabId: s.tabId });
    const evalIn = (s, expression, awaitPromise = false) =>
      chrome.debugger.sendCommand(target(s), 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise });

    // 1. Several tabs attached at the same time.
    const attachErrors = [];
    for (const s of sessions) {
      try { await chrome.debugger.attach(target(s), '1.3'); } catch (e) { attachErrors.push(`${s.tabId}: ${e.message}`); }
    }
    const attachedTargets = (await chrome.debugger.getTargets()).filter((t) => t.attached && t.type === 'page');
    const attachedIds = attachedTargets.map((t) => t.tabId).filter((id) => sessions.some((s) => s.tabId === id));

    // 2. A second attach on a tab that is already attached: exclusive, or not?
    let secondAttach = 'ok';
    try { await chrome.debugger.attach(target(sessions[0]), '1.3'); } catch (e) { secondAttach = e.message; }

    // 3. Each session writes a marker through its own debugger session, then all read all three.
    // The marker is painted: two blank pages screenshot to the same bytes, and that is not a clash.
    const colors = ['#f00', '#0a0', '#00f'];
    await Promise.all(sessions.map((s, i) => evalIn(s,
      `document.title = 'S' + ${i}; window.__mark = 'S' + ${i};
       document.body.innerHTML = '<div style="background:${colors[i]};width:400px;height:400px">S${i}</div>'`)));
    const matrix = await Promise.all(
      sessions.map((reader) => Promise.all(sessions.map((s) => evalIn(reader, `window.__mark`))))
    );

    // 4. Screenshots of all three at once, from windows that are behind.
    const shots = await Promise.all(
      sessions.map((s) => chrome.debugger.sendCommand(target(s), 'Page.captureScreenshot', { format: 'png' }))
    );
    const shotLengths = shots.map((r) => (r.data || '').length);
    const distinctShots = new Set(shots.map((r) => r.data)).size;

    // 5. Typing in a background tab: an input per session, text inserted through its own session.
    await Promise.all(sessions.map((s) => evalIn(s, `document.body.innerHTML = '<input id="f">'; document.getElementById('f').focus()`)));
    await Promise.all(sessions.map((s) => chrome.debugger.sendCommand(target(s), 'Emulation.setFocusEmulationEnabled', { enabled: true })));
    await Promise.all(sessions.map((s, i) => chrome.debugger.sendCommand(target(s), 'Input.insertText', { text: 'txt' + i })));
    const typed = (await Promise.all(sessions.map((s) => evalIn(s, `document.getElementById('f').value`)))).map((r) => r.result.value);

    // 6. Are the commands independent, or does a slow one hold the others? Timed when the quick one
    // answers, not when both are done: Promise.all waits for the slow one by definition.
    const slowStarted = Date.now();
    let quickMs = -1;
    const slow = await Promise.all([
      evalIn(sessions[0], `new Promise((r) => setTimeout(() => r('slow'), 1500))`, true),
      evalIn(sessions[1], `'quick'`).then((r) => { quickMs = Date.now() - slowStarted; return r; }),
    ]).then(([s]) => s);

    const result = {
      attachErrors,
      attachedIds,
      secondAttach,
      marks: matrix.map((row) => row.map((c) => c.result?.value)),
      shotLengths,
      distinctShots,
      typed,
      slow: slow.result?.value,
      quickMs,
      // Creating a window activates its own tab inside that window: that is not stealing the user's.
      activatedElsewhere: activated.filter((id) => !sessions.some((s) => s.tabId === id)),
      activatedOwnTabs: activated.length,
      focusChanges,
      baselineWindow,
      stillFocused: (await chrome.windows.getLastFocused()).id,
    };
    for (const s of sessions) await chrome.debugger.detach(target(s)).catch(() => undefined);
    for (const s of sessions) await chrome.windows.remove(s.windowId).catch(() => undefined);
    return result;
  });

  say(`attached tabs at once: ${out.attachedIds.length} ${JSON.stringify(out.attachErrors)}`);
  check(out.attachErrors.length === 0 && out.attachedIds.length === 3, 'the debugger is attached to 3 tabs at the same time');
  check(out.secondAttach !== 'ok', `a second attach on an attached tab is refused (${out.secondAttach})`);
  const diagonal = out.marks.every((row, i) => row.every((m) => m === `S${i}`));
  check(diagonal, `each debugger session reads only its own tab (matrix ${JSON.stringify(out.marks)})`);
  check(out.shotLengths.every((n) => n > 1000), `every background window screenshots (png bytes ${JSON.stringify(out.shotLengths)})`);
  check(out.distinctShots === 3, 'the three screenshots are different images, not three copies of one');
  check(out.typed.every((v, i) => v === `txt${i}`), `text lands in its own background tab (${JSON.stringify(out.typed)})`);
  check(out.slow === 'slow' && out.quickMs < 1000, `a 1.5 s command does not hold the other tab (quick answered in ${out.quickMs} ms)`);
  check(out.activatedElsewhere.length === 0,
    `no activation outside the agent's own tabs (${out.activatedElsewhere.length} elsewhere, ${out.activatedOwnTabs} inside its own windows)`);
  check(out.stillFocused === out.baselineWindow, `the window in front is still the same (${out.focusChanges.length} focus events)`);
} finally {
  await context?.close();
  server.close();
  rmSync(root, { recursive: true, force: true });
}
say(failures ? `${failures} FAIL` : 'todo medido');
process.exit(failures ? 1 : 0);
