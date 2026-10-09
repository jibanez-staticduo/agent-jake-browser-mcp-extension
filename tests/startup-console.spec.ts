import { test, expect, chromium } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('fresh authenticated install pairs and reconnects without console errors', async () => {
  test.setTimeout(60000);
  const scratch = mkdtempSync(join(tmpdir(), 'ajb-startup-console-'));
  const extension = join(scratch, 'extension');
  cpSync(process.env.AJB_EXTENSION_DIR || fileURLToPath(new URL('../dist', import.meta.url)), extension, { recursive: true });
  const errors: string[] = [];
  const diagnostics: string[] = [];
  const token = 'FAKE_ONLY_pairing_token';
  let otp = '';
  let approved = false;
  let unauthorizedUpgrades = 0;
  let authorizedUpgrades = 0;
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === '/connections') {
      res.end(JSON.stringify({ authEnabled: true, connections: [] }));
    } else if (url.pathname === '/pair/start') {
      let body = '';
      req.on('data', data => { body += data; });
      req.on('end', () => {
        otp = JSON.parse(body).otp;
        res.writeHead(201).end(JSON.stringify({ state: 'pending', otp }));
      });
    } else if (url.pathname === '/pair/status') {
      res.end(JSON.stringify(approved ? { state: 'approved', token } : { state: 'pending' }));
    } else {
      res.writeHead(404).end('{}');
    }
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url!, 'http://localhost').searchParams.get('token') !== token) {
      unauthorizedUpgrades++;
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    authorizedUpgrades++;
    sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws, req));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  writeFileSync(join(extension, 'config.json'), JSON.stringify({ version: 1, wsUrl: `ws://127.0.0.1:${port}/ws` }));
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const observe = (message: { type(): string; text(): string }) => {
    diagnostics.push(message.text());
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
  };
  context.on('console', observe);
  context.on('requestfailed', request => errors.push(`Request failed: ${request.url()} (${request.failure()?.errorText})`));
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  context.on('serviceworker', worker => worker.on('console', observe));
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    worker.on('console', observe);
    const extensionId = new URL(worker.url()).host;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
    await expect.poll(() => otp).not.toBe('');
    await expect(popup.getByRole('button', { name: 'Esperando' })).toBeVisible();
    // A rejected upgrade catches browser-generated errors even before observers attach.
    expect(unauthorizedUpgrades).toBe(0);
    expect(authorizedUpgrades).toBe(0);
    approved = true;
    await expect.poll(() => authorizedUpgrades).toBe(1);
    await expect(popup.locator('.conn-state')).toHaveText('CONECTADO');
    await popup.reload();
    await expect(popup.locator('.conn-state')).toHaveText('CONECTADO');
    const reload = await popup.evaluate(() => chrome.runtime.sendMessage({ action: 'saveServerConfig', payload: {} }));
    expect(reload.success).toBe(true);
    await expect.poll(() => authorizedUpgrades).toBe(2);
    sockets.clients.forEach(socket => socket.close(1001, 'fixture restart'));
    await expect.poll(() => authorizedUpgrades, { timeout: 15000 }).toBe(3);
    await expect(popup.locator('.conn-state')).toHaveText('CONECTADO');
    expect(unauthorizedUpgrades).toBe(0);
    expect(errors).toEqual([]);
    expect(diagnostics.some(message => message.includes(token))).toBe(false);
    // Chrome's own error store includes messages emitted during extension startup.
    const manager = await context.newPage();
    await manager.goto('chrome://extensions');
    const runtimeErrors = await manager.evaluate(async id => {
      const api = (chrome as any).developerPrivate;
      const extensions = await api.getExtensionsInfo({ includeDisabled: true, includeTerminated: true });
      const info = extensions.find((item: any) => item.id === id);
      if (!info) throw new Error('Test extension missing from Chrome manager');
      return [...(info.runtimeErrors ?? []), ...(info.manifestErrors ?? [])].map((error: any) => error.message);
    }, extensionId);
    expect(runtimeErrors).toEqual([]);
  } finally {
    await context.close();
    sockets.clients.forEach(socket => socket.terminate());
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(scratch, { recursive: true, force: true });
  }
});
