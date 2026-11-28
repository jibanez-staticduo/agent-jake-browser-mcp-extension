import { chromium, expect, test } from '@playwright/test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const extension = process.env.AJB_EXTENSION_DIR ?? fileURLToPath(new URL('../dist', import.meta.url));

test('a server token draft in one window cannot replace a new connection from another', async () => {
  const ws = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(ws, 'listening');
  const { port } = ws.address() as AddressInfo;
  const urlA = `ws://127.0.0.1:${port}/a`;
  const urlB = `ws://127.0.0.1:${port}/b`;
  const requests: string[] = [];
  ws.on('connection', (_socket, request) => requests.push(request.url!));
  let browser: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    browser = await chromium.launchPersistentContext('', {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox'],
    });
    const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
    const panelUrl = `chrome-extension://${new URL(worker.url()).host}/src/sidepanel/index.html`;
    const first = await browser.newPage();
    await first.goto(panelUrl);
    const setup = await first.evaluate(async serverUrl => chrome.runtime.sendMessage({
      action: 'saveServerConfig', payload: { serverUrl, token: 'token-a' },
    }), urlA);
    expect(setup.success).toBe(true);
    const [second] = await Promise.all([
      browser.waitForEvent('page'),
      worker.evaluate(url => chrome.windows.create({ url }), panelUrl),
    ]);
    const windowIds = await Promise.all([first, second].map(page =>
      page.evaluate(async () => (await chrome.windows.getCurrent()).id)));
    expect(windowIds[0]).not.toBe(windowIds[1]);
    for (const panel of [first, second]) {
      await panel.getByRole('button', { name: 'Opciones', exact: false }).first().click();
      await expect(panel.getByLabel('URL del servidor')).toHaveValue(urlA);
    }
    await first.getByLabel('Token', { exact: true }).fill('draft-token-a');
    await second.getByLabel('URL del servidor').fill(urlB);
    await expect(second.getByLabel('Token', { exact: true })).toHaveValue('');
    await second.getByLabel('Token', { exact: true }).fill('token-b');
    await second.getByRole('button', { name: 'Guardar servidor' }).click();
    await expect(second.getByText('Guardado', { exact: true }).last()).toBeVisible();
    await expect(first.getByText(`En uso: ${urlB}`, { exact: false })).toBeVisible();
    await expect(first.getByLabel('URL del servidor')).toHaveValue(urlA);
    await first.evaluate(() => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      (chrome.runtime as any).sendMessage = (...args: [message: { action?: string }, callback: (response: unknown) => void]) => {
        if (args[0].action !== 'saveServerConfig') return send(...args);
        (globalThis as any).releaseServerSave = () => { send(...args); };
      };
    });
    await first.getByRole('button', { name: 'Guardar servidor' }).click();
    await expect(first.getByLabel('URL del servidor')).toBeDisabled();
    await expect(first.getByLabel('Token', { exact: true })).toBeDisabled();
    await expect(first.getByLabel('Nombre del equipo / navegador')).toBeDisabled();
    await first.evaluate(() => (globalThis as any).releaseServerSave());
    await expect(first.getByText('La configuración del servidor cambió.', { exact: false })).toBeVisible();
    await expect(first.getByLabel('Token', { exact: true })).toBeEnabled();
    await expect(first.getByLabel('URL del servidor')).toHaveValue(urlB);
    await expect(first.getByLabel('Token', { exact: true })).toHaveValue('token-b');
    expect(requests.map(url => {
      const endpoint = new URL(url, urlA);
      return [endpoint.pathname, endpoint.searchParams.get('token')];
    })).toEqual([['/a', 'token-a'], ['/b', 'token-b']]);
  } finally {
    await browser?.close();
    ws.clients.forEach(socket => socket.terminate());
    await new Promise<void>(resolve => ws.close(() => resolve()));
  }
});

test('two overlapping saves finish when the newer WebSocket replaces a pending handshake', async () => {
  const http = createServer((_request, response) => response.writeHead(426).end());
  const ws = new WebSocketServer({ noServer: true });
  const deferredSockets = new Set<import('node:stream').Duplex>();
  let reportPending!: () => void;
  const pending = new Promise<void>(resolve => { reportPending = resolve; });
  http.on('upgrade', (request, socket, head) => {
    if (request.url?.startsWith('/pending?')) {
      deferredSockets.add(socket);
      reportPending();
      socket.once('close', () => deferredSockets.delete(socket));
      socket.on('error', () => socket.destroy());
      socket.on('end', () => socket.destroy());
      return;
    }
    ws.handleUpgrade(request, socket, head, client => ws.emit('connection', client, request));
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const { port } = http.address() as AddressInfo;
  const server = `ws://127.0.0.1:${port}`;
  let browser: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    browser = await chromium.launchPersistentContext('', {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
    const panelUrl = `chrome-extension://${new URL(worker.url()).host}/src/sidepanel/index.html`;
    const first = await browser.newPage();
    const second = await browser.newPage();
    await Promise.all([first.goto(panelUrl), second.goto(panelUrl)]);
    const firstSave = first.evaluate(serverUrl => {
      // Store the promise without making Playwright wait for the blocked handshake.
      (globalThis as any).pendingSave = chrome.runtime.sendMessage({
        action: 'saveServerConfig', payload: { serverUrl, token: '' },
      });
    }, server + '/pending');
    await Promise.all([firstSave, expect(pending).resolves.toBeUndefined()]);
    const latest = await second.evaluate(serverUrl => chrome.runtime.sendMessage({
      action: 'saveServerConfig', payload: { serverUrl, token: '' },
    }), server + '/latest');
    expect(latest).toMatchObject({ success: true, connected: true });
    await expect(first.evaluate(() => (globalThis as any).pendingSave)).resolves.toMatchObject({ success: true });
    expect(await second.evaluate(() => chrome.runtime.sendMessage({ action: 'getServerConfig' })))
      .toMatchObject({ connected: true, effectiveUrl: server + '/latest' });
    expect(ws.clients.size).toBe(1);
  } finally {
    await browser?.close();
    deferredSockets.forEach(socket => socket.destroy());
    ws.clients.forEach(socket => socket.terminate());
    ws.close();
    await new Promise<void>(resolve => http.close(() => resolve()));
  }
});
