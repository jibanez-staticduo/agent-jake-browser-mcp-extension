import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';

// Reuse Playwright's bundled fixture without adding a runtime product dependency.
const { wsServer: WebSocketServer } = createRequire(import.meta.url)('../../node_modules/playwright-core/lib/utilsBundle.js');

type FixtureOptions = { prefix: string; timeout: number; html: (url: string | undefined) => string };

export async function startBrowserServer({ prefix, timeout, html }: FixtureOptions) {
  let socket: any;
  let sequence = 0;
  const pending = new Map<string, (reply: any) => void>();
  const server = http.createServer((req, res) => {
    if (req.url === '/connections') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ authEnabled: false, connections: [] }));
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html(req.url));
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

  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get socket() { return socket; },
    request(type: string, payload: Record<string, unknown>) {
      const id = `${prefix}-${++sequence}`;
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${type}`)); }, timeout);
        pending.set(id, reply => { clearTimeout(timer); resolve(reply); });
        socket.send(JSON.stringify({ id, type, payload }));
      });
    },
    async close() {
      wss.clients.forEach(client => client.terminate());
      await new Promise<void>(resolve => wss.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
