import { test, expect, chromium } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';

// Fake data only: exercise the real WebSocket -> extension -> CDP boundary.
test('secret typing keeps values out of replies, diagnostics and storage', async () => {
  test.setTimeout(60000);
  const fakeSecret = 'FAKE_ONLY_secret_7319';
  const responses: string[] = [];
  const pending = new Map<string, (value: any) => void>();
  let socket: WebSocket | undefined;
  let sequence = 0;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Secret fixture</title><label>Password<input id="password" type="password" value="old" oninput="console.warn(this.value)"></label><label>Name<input id="name"></label>');
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', client => {
    socket = client;
    client.on('message', data => {
      const raw = data.toString();
      responses.push(raw);
      const reply = JSON.parse(raw);
      pending.get(reply.id)?.(reply);
      pending.delete(reply.id);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const fixtureUrl = `http://127.0.0.1:${port}/fixture`;
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [
      `--disable-extensions-except=${fileURLToPath(new URL('../dist', import.meta.url))}`,
      `--load-extension=${fileURLToPath(new URL('../dist', import.meta.url))}`,
      '--no-sandbox', '--disable-dev-shm-usage',
    ],
  });
  const request = async (type: string, payload: Record<string, unknown>) => {
    const id = `secret-e2e-${++sequence}`;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${type}`)); }, 15000);
      pending.set(id, reply => { clearTimeout(timer); resolve(reply); });
      socket!.send(JSON.stringify({ id, type, payload }));
    });
  };
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    // Capture worker diagnostics without exposing input values in test output.
    await worker.evaluate(() => {
      (globalThis as any).__testDiagnostics = [];
      for (const level of ['debug', 'info', 'warn', 'error', 'log'] as const) {
        const original = console[level].bind(console);
        console[level] = (...args) => {
          (globalThis as any).__testDiagnostics.push(JSON.stringify(args));
          original(...args);
        };
      }
    });
    const extensionId = new URL(worker.url()).host;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
    const configured = await popup.evaluate(async serverUrl => chrome.runtime.sendMessage({
      action: 'saveServerConfig', payload: { serverUrl, token: '' },
    }), `ws://127.0.0.1:${port}`);
    expect(configured.success).toBe(true);
    const page = await context.newPage();
    await page.goto(fixtureUrl);
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id!, fixtureUrl);
    const connected = await popup.evaluate(async ({ tabId, tabUrl }) => chrome.runtime.sendMessage({
      action: 'connectTab', payload: { tabId, tabUrl },
    }), { tabId, tabUrl: fixtureUrl });
    expect(connected.success).toBe(true);
    await expect.poll(() => socket?.readyState).toBe(1);
    // Wait for the content script's listener, independently of WS readiness.
    await expect.poll(async () => worker.evaluate(async tabId => {
      try { return (await chrome.tabs.sendMessage(tabId, { action: 'getFieldLength', payload: { selector: '#password' } })).success; }
      catch { return false; }
    }, tabId)).toBe(true);

    const reply = await request('browser_type', { selector: '#password', text: fakeSecret, clear: true, secret: true });
    expect(reply.success).toBe(true);
    expect(reply.result).toMatchObject({ typed: true, cleared: true, verified: true, length: fakeSecret.length });
    expect(await page.locator('#password').inputValue()).toBe(fakeSecret);

    const consoleReply = await request('browser_get_console_logs', { all: true });
    expect(consoleReply.success).toBe(true);
    expect(consoleReply.result.logs).toEqual([]);

    const failure = await request('browser_type', { selector: `[data-missing="${fakeSecret}"]`, text: fakeSecret, secret: true });
    expect(failure.success).toBe(false);
    expect(JSON.stringify(failure)).not.toContain(fakeSecret);
    const ordinary = await request('browser_type', { selector: '#name', text: 'Ordinary text', clear: true });
    expect(ordinary.success).toBe(true);
    expect(ordinary.result.typed).toBe('Ordinary text');
    expect(await page.locator('#name').inputValue()).toBe('Ordinary text');

    const snapshot = await request('browser_snapshot', {});
    expect(snapshot.success).toBe(true);
    const nameRef = String(snapshot.result.snapshot).match(/\[(s\d+e\d+)\|[^\]]*#name[^\]]*\]/)?.[1];
    // Ref lookup is also covered by unit tests; require the real snapshot shape here.
    expect(nameRef).toBeTruthy();
    const byRef = await request('browser_type', { ref: nameRef!, text: fakeSecret, clear: true, secret: true });
    expect(byRef.success).toBe(true);
    expect(await page.locator('#name').inputValue()).toBe(fakeSecret);

    // Snapshot responses intentionally expose ordinary page state, so inspect only
    // typing replies for the secret contract, plus all worker diagnostics/storage.
    const typingReplies = responses.filter(raw => /secret-e2e-(1|3|4|6)"/.test(raw));
    expect(typingReplies.join('\n')).not.toContain(fakeSecret);
    const diagnostics = await worker.evaluate(() => (globalThis as any).__testDiagnostics.join('\n'));
    expect(diagnostics).not.toContain(fakeSecret);
    const storage = await worker.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
    expect(storage).not.toContain(fakeSecret);
  } finally {
    await context.close();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
