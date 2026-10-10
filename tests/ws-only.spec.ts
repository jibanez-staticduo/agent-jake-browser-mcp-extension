import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import type { AddressInfo } from 'node:net';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

// A standalone ws listener returns 426 for /connections rather than serving
// authentication metadata. This models the canonical separate WS/HTTP ports.
for (const source of ['config.json', 'manual'] as const) {
  test(`tokenless ${source} connects to a dedicated WS-only listener`, async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'ajb-ws-only-'));
    const extension = join(scratch, 'extension');
    let context: BrowserContext | undefined;
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    const requests: string[] = [];
    server.on('connection', (_socket, request) => requests.push(request.url!));
    try {
      await new Promise<void>(resolve => server.once('listening', resolve));
      const port = (server.address() as AddressInfo).port;
      const wsUrl = `ws://127.0.0.1:${port}/ws`;
      expect((await fetch(`http://127.0.0.1:${port}/connections`)).status).toBe(426);
      cpSync(process.env.AJB_EXTENSION_DIR || fileURLToPath(new URL('../dist', import.meta.url)), extension, { recursive: true });
      writeFileSync(join(extension, 'config.json'), JSON.stringify({ version: 1, wsUrl }));
      context = await chromium.launchPersistentContext('', {
        channel: 'chromium', headless: true,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox', '--disable-dev-shm-usage'],
      });
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${new URL(worker.url()).host}/src/popup/index.html`);
      await expect.poll(() => requests.length).toBe(1);
      if (source === 'manual') {
        const configured = await popup.evaluate(serverUrl => chrome.runtime.sendMessage({
          action: 'saveServerConfig', payload: { serverUrl, token: '' },
        }), wsUrl);
        expect(configured.success).toBe(true);
        await expect.poll(() => requests.length).toBe(2);
      }
      const status = await popup.evaluate(() => chrome.runtime.sendMessage({ action: 'getServerConfig' }));
      expect(status).toMatchObject({ source, connected: true, awaitingToken: false, hasToken: false });
      expect(requests.every(url => !new URL(url, 'http://localhost').searchParams.has('token'))).toBe(true);
      await expect(popup.locator('.conn-state')).toHaveText('CONECTADO');
    } finally {
      await context?.close();
      server.clients.forEach(socket => socket.terminate());
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}

test('WS-only fallback leaves token authentication enforced by the handshake', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'ajb-ws-only-auth-'));
  const extension = join(scratch, 'extension');
  let context: BrowserContext | undefined;
  const token = 'FAKE_ONLY_ws_token';
  let rejected = 0;
  let accepted = 0;
  const openServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const protectedServer = new WebSocketServer({
    port: 0, host: '127.0.0.1',
    verifyClient: ({ req }) => {
      if (new URL(req.url!, 'http://localhost').searchParams.get('token') === token) return true;
      rejected++;
      return false;
    },
  });
  protectedServer.on('connection', () => accepted++);
  try {
    await Promise.all([openServer, protectedServer].map(server => new Promise<void>(resolve => server.once('listening', resolve))));
    const openPort = (openServer.address() as AddressInfo).port;
    const protectedPort = (protectedServer.address() as AddressInfo).port;
    cpSync(process.env.AJB_EXTENSION_DIR || fileURLToPath(new URL('../dist', import.meta.url)), extension, { recursive: true });
    writeFileSync(join(extension, 'config.json'), JSON.stringify({ version: 1, wsUrl: `ws://127.0.0.1:${openPort}/ws` }));
    context = await chromium.launchPersistentContext('', {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox', '--disable-dev-shm-usage'],
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${new URL(worker.url()).host}/src/popup/index.html`);
    await expect.poll(() => openServer.clients.size).toBe(1);
    const wsUrl = `ws://127.0.0.1:${protectedPort}/ws`;
    const failed = await popup.evaluate(serverUrl => chrome.runtime.sendMessage({
      action: 'saveServerConfig', payload: { serverUrl, token: '' },
    }), wsUrl);
    expect(failed.success).toBe(false);
    await expect.poll(() => rejected).toBeGreaterThan(0);
    expect(accepted).toBe(0);
    const status = await popup.evaluate(() => chrome.runtime.sendMessage({ action: 'getServerConfig' }));
    expect(status.connected).toBe(false);
    const approved = await popup.evaluate(({ serverUrl, token }) => chrome.runtime.sendMessage({
      action: 'saveServerConfig', payload: { serverUrl, token },
    }), { serverUrl: wsUrl, token });
    expect(approved).toMatchObject({ success: true, connected: true });
    expect(accepted).toBe(1);
  } finally {
    await context?.close();
    for (const server of [openServer, protectedServer]) {
      server.clients.forEach(socket => socket.terminate());
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});
