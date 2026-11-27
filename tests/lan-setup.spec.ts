import { expect, chromium, test } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverEntry = process.env.AJB_LAN_SERVER_ENTRY;
const extensionPath = fileURLToPath(new URL('../dist', import.meta.url));
const loopback = '127.0.0.1';
const apiKey = 'fixture-litellm-key';
const mcpToken = 'fixture-mcp-token';

const instances = [
  { name: 'NAS', origin: 'https://agent-browser.staticduo.com', wsPath: '/ws',
    baseUrl: 'https://litellm.staticduo.com/v1', mcpPath: '/jake/mcp', inferredHost: 'NAS laptop' },
  { name: 'Defend (Fedora)', origin: 'https://agent-browser.defend.tech', wsPath: '/ws',
    baseUrl: 'https://litellm.defend.tech/v1', mcpPath: '/jake-defend/mcp' },
  { name: 'Ari', origin: 'https://opencode-ari.staticduo.com', wsPath: '/browser-ws',
    baseUrl: 'https://litellm.staticduo.com/v1', mcpPath: '/jake/mcp' },
];

async function listen(server: net.Server) {
  server.listen(0, loopback);
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

async function localPort() {
  const socket = net.createServer();
  const port = await listen(socket);
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

async function startBackend(directory: string, config: object) {
  const wsPort = await localPort();
  const httpPort = await localPort();
  const configPath = path.join(directory, 'setup.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(process.execPath, [serverEntry!], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      PATH: process.env.PATH,
      AGENT_BROWSER_SETUP_FILE: configPath,
      BROWSER_TOKEN_STORE: path.join(directory, 'tokens.json'),
      BROWSER_EXTENSION_DIR: directory,
      BROWSER_WS_HOST: loopback,
      BROWSER_WS_PORT: String(wsPort),
      MCP_HTTP_HOST: loopback,
      MCP_HTTP_PORT: String(httpPort),
    },
  });
  let stderr = '';
  child.stderr.setEncoding('utf-8').on('data', chunk => { stderr += chunk; });
  const httpBase = `http://${loopback}:${httpPort}`;
  async function close() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }

  try {
    await expect.poll(async () => {
      if (child.exitCode !== null) throw new Error(stderr);
      return fetch(`${httpBase}/healthz`).then(res => res.status, () => 0);
    }).toBe(200);
    return { httpPort, wsPort, httpBase, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function startProxy(directory: string, host: string, wsPath: string, backend: { httpPort: number; wsPort: number }) {
  const certPath = path.join(directory, 'cert.pem');
  const keyPath = path.join(directory, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host}`, '-keyout', keyPath, '-out', certPath],
  { stdio: 'ignore' });
  const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
  const publicKey = new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' });
  const spki = createHash('sha256').update(publicKey).digest('base64');
  const requests: Array<{ path: string; origin?: string; site?: string; status?: number }> = [];
  const upgrades: string[] = [];
  const proxy = https.createServer({ cert, key }, (incoming, response) => {
    if (incoming.headers.host !== host) {
      response.writeHead(404).end();
      return;
    }
    // Preserve Chromium's Origin and Sec-Fetch headers through the TLS boundary.
    const entry = {
      path: new URL(incoming.url!, `https://${host}`).pathname,
      origin: incoming.headers.origin,
      site: incoming.headers['sec-fetch-site'] as string | undefined,
      status: undefined as number | undefined,
    };
    if (entry.path.startsWith('/setup')) requests.push(entry);
    const upstream = http.request({ host: loopback, port: backend.httpPort, method: incoming.method,
      path: incoming.url, headers: { ...incoming.headers, 'x-agent-jake-client-ip': '192.168.42.30' } }, upstreamResponse => {
      entry.status = upstreamResponse.statusCode;
      response.writeHead(upstreamResponse.statusCode!, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on('error', () => response.writeHead(502).end());
    incoming.pipe(upstream);
  });

  const sockets = new Set<net.Socket>();
  proxy.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  proxy.on('upgrade', (incoming, socket, head) => {
    const requestedPath = new URL(incoming.url!, `https://${host}`).pathname;
    upgrades.push(requestedPath);
    if (incoming.headers.host !== host || requestedPath !== wsPath) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = net.connect(backend.wsPort, loopback);
    upstream.once('error', () => socket.destroy());
    socket.once('error', () => upstream.destroy());
    socket.once('close', () => upstream.destroy());
    const headers = Object.entries(incoming.headers).map(([name, value]) => `${name}: ${value}`).join('\r\n');
    upstream.write(`${incoming.method} ${incoming.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
    upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });

  const port = await listen(proxy);
  return { port, spki, requests, upgrades, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  } };
}

test.describe('StaticDuo LAN setup with a built server', () => {
  test.skip(!serverEntry, 'Set AJB_LAN_SERVER_ENTRY to the built server dist/http-server.js');

  for (const instance of instances) {
    const expectedFields = instance.inferredHost ? 'profile' : 'host and profile';
    test(`${instance.name} asks for ${expectedFields} and connects to its WSS endpoint`, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'ajb-lan-setup-'));
      const hostname = new URL(instance.origin).hostname;
      const wsUrl = `wss://${hostname}${instance.wsPath}`;
      const mcpUrl = `https://agentgateway.staticduo.com${instance.mcpPath}`;
      let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
      let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
      let browser: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;

      try {
        backend = await startBackend(directory, {
          origin: instance.origin, wsUrl, baseUrl: instance.baseUrl, apiKey, mcpUrl, mcpToken,
          lanCidrs: ['192.168.42.0/24'], trustedProxyIps: [loopback],
          hostByIp: instance.inferredHost ? { '192.168.42.30': instance.inferredHost } : {},
        });
        proxy = await startProxy(directory, hostname, instance.wsPath, backend);
        browser = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
          channel: 'chromium', headless: true,
          args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
            '--no-proxy-server',
            `--host-resolver-rules=MAP ${hostname} ${loopback}:${proxy.port}, MAP * ~NOTFOUND`,
            `--ignore-certificate-errors-spki-list=${proxy.spki}`,
          ],
        });
        const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
        const extensionId = new URL(worker.url()).hostname;
        const extensionOrigin = `chrome-extension://${extensionId}`;
        const panel = await browser.newPage();
        await panel.goto(`${extensionOrigin}/src/sidepanel/index.html`);
        await panel.getByRole('button', { name: 'Abrir Opciones', exact: true }).click();
        const [approval] = await Promise.all([
          browser.waitForEvent('page', { timeout: 10000 }),
          panel.getByRole('group', { name: 'Emparejar con servidor' })
            .getByRole('button', { name: instance.name, exact: true }).click(),
        ]);
        await expect(approval).toHaveURL(`${instance.origin}/setup`);
        const host = approval.getByLabel('Nombre del equipo');
        const profile = approval.getByLabel('Nombre del perfil del navegador');
        await expect(profile).toBeVisible();
        if (instance.inferredHost) {
          await expect(host).toBeHidden();
          await expect(profile).toBeFocused();
        } else {
          await expect(host).toBeFocused();
          await host.fill('Fixture laptop');
        }
        await profile.fill('QA Profile');
        await approval.getByRole('button', { name: 'Emparejar', exact: true }).click();
        await expect(approval.getByRole('status')).toContainText('Emparejamiento aprobado');

        const label = `${instance.inferredHost ?? 'Fixture laptop'} - QA Profile`;
        const { httpBase } = backend;
        const uuid = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;
        await expect.poll(async () => {
          const res = await fetch(`${httpBase}/connections`);
          return res.json();
        }).toMatchObject({ authEnabled: true, connections: [expect.objectContaining({ connectionId: expect.stringMatching(uuid), label, open: true })] });
        expect(proxy.upgrades).toContain(instance.wsPath);

        const storage = await worker.evaluate(() => chrome.storage.local.get());
        expect(storage).toMatchObject({
          'ajb.serverUrl': wsUrl,
          'ajb.tokenUrl': wsUrl,
          'ajb.token': expect.any(String),
          'ajb.label': label,
          'ajb.connectionId': expect.stringMatching(uuid),
          copilotSettings: { baseUrl: instance.baseUrl, apiKey, mcpUrl, mcpToken, mcpTokenUrl: mcpUrl,
            vision: true, maxSteps: 200, stepsView: 'extended' },
        });
        expect(proxy.requests).toEqual(expect.arrayContaining([
          expect.objectContaining({ path: '/setup/start', origin: extensionOrigin, status: 201 }),
          expect.objectContaining({ path: '/setup', status: 200 }),
          expect.objectContaining({ path: '/setup/approve', origin: instance.origin, site: 'same-origin', status: 422 }),
          expect.objectContaining({ path: '/setup/approve', origin: instance.origin, site: 'same-origin', status: 200 }),
          expect.objectContaining({ path: '/setup/status', origin: extensionOrigin, status: 200 }),
        ]));
      } finally {
        await browser?.close();
        await proxy?.close();
        await backend?.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});
