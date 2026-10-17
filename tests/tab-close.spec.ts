import { test, expect, chromium } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';

test('closeById closes only the requested tab and rejects invalid IDs', async () => {
  test.setTimeout(60000);
  let socket: WebSocket | undefined;
  let sequence = 0;
  const pending = new Map<string, (reply: any) => void>();
  const server = http.createServer((req, res) => {
    if (req.url === '/connections') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ authEnabled: false, connections: [] }));
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Tab close fixture</title><p>Disposable test tab</p>');
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
    args: [
      `--disable-extensions-except=${fileURLToPath(new URL('../dist', import.meta.url))}`,
      `--load-extension=${fileURLToPath(new URL('../dist', import.meta.url))}`,
      '--no-sandbox', '--disable-dev-shm-usage',
    ],
  });
  const request = (type: string, payload: Record<string, unknown>) => {
    const id = `tab-close-${++sequence}`;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${type}`)); }, 10000);
      pending.set(id, reply => { clearTimeout(timer); resolve(reply); });
      socket!.send(JSON.stringify({ id, type, payload }));
    });
  };
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${new URL(worker.url()).host}/src/sidepanel/index.html`);
    const configured = await popup.evaluate(async serverUrl => chrome.runtime.sendMessage({
      action: 'saveServerConfig', payload: { serverUrl, token: '' },
    }), origin.replace('http:', 'ws:'));
    expect(configured.success).toBe(true);
    const connectedPage = await context.newPage();
    await connectedPage.goto(`${origin}/connected`);
    const otherPage = await context.newPage();
    await otherPage.goto(`${origin}/other`);
    const [connectedId, otherId] = await worker.evaluate(async origin => {
      const tabs = await chrome.tabs.query({});
      return ['/connected', '/other'].map(path => tabs.find(tab => tab.url === origin + path)!.id!);
    }, origin);
    expect((await popup.evaluate(async ({ tabId, tabUrl }) => chrome.runtime.sendMessage({
      action: 'connectTab', payload: { tabId, tabUrl },
    }), { tabId: connectedId, tabUrl: `${origin}/connected` })).success).toBe(true);
    await expect.poll(() => socket?.readyState).toBe(1);
    const listing = await request('browser_list_tabs', {});
    expect(listing.success).toBe(true);
    expect(listing.result.closeById).toBe(true);
    for (const tabId of [0, -1, 1.5, '0', null]) {
      expect((await request('browser_close_tab', { tabId })).success).toBe(false);
      expect(connectedPage.isClosed()).toBe(false);
      expect(otherPage.isClosed()).toBe(false);
    }
    const closed = await request('browser_close_tab', { tabId: otherId });
    expect(closed).toMatchObject({ success: true, result: { closed: true, tabId: otherId } });
    await expect.poll(() => otherPage.isClosed()).toBe(true);
    expect(connectedPage.isClosed()).toBe(false);
    expect((await popup.evaluate(() => chrome.runtime.sendMessage({ action: 'getStatus' }))).tabs.find((tab: any) => tab.id === connectedId).connected).toBe(true);
    const legacy = await request('browser_close_tab', { targetTabId: connectedId });
    expect(legacy).toMatchObject({ success: true, result: { closed: true, tabId: connectedId } });
    await expect.poll(() => connectedPage.isClosed()).toBe(true);
  } finally {
    await context.close();
    wss.clients.forEach(client => client.terminate());
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
