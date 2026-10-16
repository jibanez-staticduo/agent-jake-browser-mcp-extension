import { test, expect, chromium } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const { wsServer: WebSocketServer } = createRequire(import.meta.url)('../node_modules/playwright-core/lib/utilsBundle.js');
const CANARY = 'QA-ONLY-SECRET-7F3A9C21';

test('internal secret reader routes refs, bounds regex and keeps canaries out of logs and storage', async () => {
  test.setTimeout(60000);
  let socket: any;
  let sequence = 0;
  const observed: string[] = [];
  const pending = new Map<string, (reply: any) => void>();
  const server = http.createServer((req, res) => {
    if (req.url === '/connections') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ authEnabled: false, connections: [] }));
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Synthetic secret fixture</title><p id="seed">${CANARY}</p><input id="input" value="${CANARY}"><p class="dup">decoy</p><p class="dup">decoy2</p><p id="poison">${'a'.repeat(65535)}!</p>${req.url === '/frame' ? '' : '<iframe src="/frame"></iframe>'}`);
    }
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', client => {
    socket = client;
    client.on('message', raw => {
      const reply = JSON.parse(raw.toString());
      pending.get(reply.id)?.(reply);
      pending.delete(reply.id);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${fileURLToPath(new URL('../dist', import.meta.url))}`, `--load-extension=${fileURLToPath(new URL('../dist', import.meta.url))}`, '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const request = (type: string, payload: Record<string, unknown>) => {
    const id = `secret-qa-${++sequence}`;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${type}`)); }, 10000);
      pending.set(id, reply => { clearTimeout(timer); resolve(reply); });
      socket.send(JSON.stringify({ id, type, payload }));
    });
  };
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    worker.on('console', msg => observed.push(msg.text()));
    const panel = await context.newPage();
    panel.on('console', msg => observed.push(msg.text()));
    await panel.goto(`chrome-extension://${new URL(worker.url()).host}/src/sidepanel/index.html`);
    await panel.evaluate(async serverUrl => chrome.runtime.sendMessage({ action: 'saveServerConfig', payload: { serverUrl, token: '' } }), origin.replace('http:', 'ws:'));
    await expect.poll(() => socket?.readyState).toBe(1);
    const created = await request('browser_new_tab', { url: `${origin}/fixture`, switchTo: true });
    expect(created.success).toBe(true);
    const tabId = created.result.tab.id;
    const page = context.pages().find(page => page.url() === `${origin}/fixture`)!;
    page.on('console', msg => observed.push(msg.text()));
    const read = (payload: Record<string, unknown>) => request('browser_read_secret', { targetTabId: tabId, ...payload });
    expect(await read({ selector: '#seed' })).toMatchObject({ success: true, result: { value: CANARY } });
    expect(await read({ selector: '#input', regex: 'QA-ONLY-(SECRET-[0-9A-F]+)' })).toMatchObject({ success: true, result: { value: 'SECRET-7F3A9C21' } });
    expect(await read({ selector: '.dup' })).toMatchObject({ success: false, error: { code: 'SECRET_AMBIGUOUS', message: 'Multiple elements match the selector' } });
    expect(await read({ selector: '#seed', regex: '(x)\\1' })).toMatchObject({ success: false, error: { code: 'SECRET_REGEX_INVALID' } });
    expect(await read({ selector: '#poison', regex: '(a+)+$' })).toMatchObject({ success: false, error: { code: 'SECRET_REGEX_NO_MATCH' } });
    expect(await read({ ref: `s999999e42${CANARY}` })).toMatchObject({ success: false, error: { code: 'SECRET_NO_MATCH' } });
    const snapshot = await request('browser_snapshot', { targetTabId: tabId });
    expect(snapshot.success).toBe(true);
    const refs = [...JSON.stringify(snapshot.result).matchAll(/\[(f\d+:s\d+e\d+)[|\]]/g)];
    expect(refs.length).toBeGreaterThan(0);
    const frames = await worker.evaluate(async id => chrome.webNavigation.getAllFrames({ tabId: id }), tabId);
    const frameId = frames!.find(frame => frame.parentFrameId === 0)!.frameId;
    const compact = await request('browser_state', { targetTabId: tabId });
    expect(JSON.stringify(compact.result)).toContain(`f${frameId}:`);
    expect(await read({ ref: `f${frameId}:0` })).toMatchObject({ success: true, result: { value: CANARY } });
    // Snapshot identity stays correct even when an open shadow root has a CSS decoy.
    const identity = await read({ ref: refs[0][1] });
    expect(identity.success || identity.error.code === 'SECRET_EMPTY').toBe(true);
    const stored = await worker.evaluate(async () => ({ local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null) }));
    expect(JSON.stringify(stored)).not.toContain(CANARY);
    expect(observed.join('\n')).not.toContain(CANARY);
  } finally {
    await context.close();
    wss.clients.forEach(client => client.terminate());
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
