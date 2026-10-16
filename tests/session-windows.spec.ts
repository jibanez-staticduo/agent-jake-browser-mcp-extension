import { test, expect, chromium } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';

test('session windows survive extension reload and preserve user tabs without changing focus', async () => {
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
      // Chromium otherwise disables unpacked extensions on runtime.reload (Playwright #34711).
      '--disable-features=ExtensionDisableUnsupportedDeveloper',
    ],
  });
  const request = (type: string, payload: Record<string, unknown>) => {
    const id = `tab-close-${++sequence}`;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${type} ${JSON.stringify(payload)}`)); }, 20000);
      pending.set(id, reply => { clearTimeout(timer); resolve(reply); });
      socket!.send(JSON.stringify({ id, type, payload }));
    });
  };
  try {
    let worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const popupUrl = `chrome-extension://${new URL(worker.url()).host}/src/popup/index.html`;
    let popup = await context.newPage();
    await popup.goto(popupUrl);
    await popup.evaluate(async serverUrl => chrome.runtime.sendMessage({ action: 'saveServerConfig', payload: { serverUrl, token: '' } }), origin.replace('http:', 'ws:'));
    await expect.poll(() => socket?.readyState).toBe(1);
    const userPage = await context.newPage();
    await userPage.goto(`${origin}/human`);
    const baseline = await worker.evaluate(async () => (await chrome.windows.getLastFocused()).id);
    const listing = await request('browser_list_tabs', {});
    expect(listing.result).toMatchObject({ closeById: true, closeWindow: true, windowPerSession: true });
    const first = await request('browser_new_tab', { url: `${origin}/agent-a`, switchTo: true });
    expect(first.success).toBe(true);
    expect(first.result.windowCreated).toBe(true);
    expect(first.result.windowId).not.toBe(baseline);
    const agentWindow = first.result.windowId;
    const firstId = first.result.tab.id;
    expect(await worker.evaluate(async () => (await chrome.windows.getLastFocused()).id)).toBe(baseline);
    const second = await request('browser_new_tab', { url: `${origin}/agent-b`, windowId: agentWindow, switchTo: true });
    expect(second).toMatchObject({ success: true, result: { windowId: agentWindow, windowCreated: false } });
    const secondId = second.result.tab.id;
    expect(await worker.evaluate(async id => (await chrome.tabs.get(id)).active, secondId)).toBe(false);
    const screenshot = await request('browser_screenshot', {});
    expect(screenshot.success).toBe(true);
    expect(screenshot.result.image).toMatch(/^data:image\/png;base64,/);
    expect(await worker.evaluate(async id => (await chrome.tabs.get(id)).active, secondId)).toBe(false);
    expect(await worker.evaluate(async () => (await chrome.windows.getLastFocused()).id)).toBe(baseline);
    const oldTargets = await worker.evaluate(async () => chrome.debugger.getTargets());
    const oldUuid = oldTargets.find(target => target.tabId === firstId)!.id;
    const previousSocket = socket;
    await worker.evaluate(() => setTimeout(() => chrome.runtime.reload(), 0));
    popup = await context.newPage();
    await expect(async () => { await popup.goto(popupUrl); }).toPass({ timeout: 20000 });
    // Observe extension recovery through its page; Playwright can reuse its Worker handle.
    await expect.poll(() => socket !== previousSocket && socket?.readyState === 1, { timeout: 20000 }).toBe(true);
    expect((await popup.evaluate(async () => chrome.debugger.getTargets())).find(target => target.tabId === firstId)!.id).toBe(oldUuid);
    const third = await request('browser_new_tab', { url: `${origin}/agent-after-reload`, windowId: agentWindow });
    expect(third).toMatchObject({ success: true, result: { windowId: agentWindow, windowCreated: false } });
    const thirdId = third.result.tab.id;
    const userId = await popup.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id!, `${origin}/human`);
    await popup.evaluate(async ({ userId, agentWindow }) => chrome.tabs.move(userId, { windowId: agentWindow, index: -1 }), { userId, agentWindow });
    expect((await request('browser_close_window', { windowId: baseline, tabIds: [userId] })).success).toBe(false);
    const empty = await request('browser_close_window', { windowId: agentWindow, tabIds: [] });
    expect(empty).toMatchObject({ success: true, result: { closed: false, closedTabIds: [] } });
    const closed = await request('browser_close_window', { windowId: agentWindow, tabIds: [firstId, secondId, thirdId] });
    expect(closed).toMatchObject({ success: true, result: { windowId: agentWindow, closed: false, closedTabIds: [firstId, secondId, thirdId] } });
    expect(userPage.isClosed()).toBe(false);
    expect(await popup.evaluate(async id => (await chrome.tabs.get(id)).url, userId)).toBe(`${origin}/human`);
    const stale = await request('browser_new_tab', { url: `${origin}/new-session`, windowId: agentWindow });
    expect(stale.result.windowCreated).toBe(true);
    expect(stale.result.windowId).not.toBe(agentWindow);
  } finally {
    await context.close();
    wss.clients.forEach(client => client.terminate());
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
