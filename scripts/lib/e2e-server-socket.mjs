// The agent-browser-server's side of the extension's WebSocket, for the manual real-Chromium checks
// (scripts/e2e-*.mjs): the extension is built to dial 127.0.0.1:WS, and this plays the server that
// sends it commands one at a time, as the server's per-browser queue does, and cuts each at 30 s
// as the server does. Shared so the checks do not each carry their own copy.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

export const SERVER_CUT_MS = 30_000;

/**
 * Build this checkout's extension to dial 127.0.0.1:wsPort, load it in a Chromium with its own
 * profile under `root`, and wait until it connects to `server`. Returns the browser context.
 */
export async function launchExtension({ repo, root, wsPort, server, say }) {
  say('building the extension');
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('VITE_')) delete env[k];
  env.VITE_WS_PORT = String(wsPort);
  execFileSync('npx', ['vite', 'build', '--outDir', join(root, 'ext'), '--emptyOutDir'], { cwd: repo, env, stdio: 'pipe' });

  await server.listen(wsPort);
  const context = await chromium.launchPersistentContext(join(root, 'profile'), {
    channel: 'chromium',
    headless: process.env.AJB_HEADLESS === '1',
    args: [`--disable-extensions-except=${join(root, 'ext')}`, `--load-extension=${join(root, 'ext')}`, '--no-sandbox'],
  });
  for (let i = 0; i < 100 && !server.connected(); i++) await new Promise((r) => setTimeout(r, 100));
  if (!server.connected()) throw new Error(`the extension never connected to 127.0.0.1:${wsPort}`);
  say('extension connected');
  return context;
}

/** `say` logs a line; returns { listen, close, connected, command, answered }. */
export function createServerSide(say) {
  let socket = null;
  const waiting = new Map();
  function frame(text) {
    const body = Buffer.from(text);
    const head = body.length < 126 ? Buffer.from([0x81, body.length])
      : Buffer.concat([Buffer.from([0x81, 126]), Buffer.from([body.length >> 8, body.length & 255])]);
    return Buffer.concat([head, body]);
  }
  function onData(buf) { // client frames are masked; the extension's replies and heartbeats are text
    while (buf.length >= 2) {
      let len = buf[1] & 127, at = 2;
      if (len === 126) { len = buf.readUInt16BE(2); at = 4; } else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); at = 10; }
      const mask = buf.subarray(at, at + 4);
      const payload = Buffer.from(buf.subarray(at + 4, at + 4 + len)).map((b, i) => b ^ mask[i % 4]);
      buf = buf.subarray(at + 4 + len);
      if ((payload.length === 0) || !(payload[0] === 0x7b)) continue;
      const msg = JSON.parse(payload.toString());
      waiting.get(msg.id)?.(msg);
    }
  }
  const wsServer = createServer().on('upgrade', (req, sock) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sock.on('data', onData).on('error', () => undefined);
    socket = sock;
  });

  let n = 0;
  /** One command, then its answer or the server's cut. */
  async function command(type, payload = {}) {
    const id = `e2e-${++n}`;
    const t0 = Date.now();
    const answer = await new Promise((resolve) => {
      const cut = setTimeout(() => { waiting.delete(id); resolve({ timedOut: true }); }, SERVER_CUT_MS);
      waiting.set(id, (msg) => { clearTimeout(cut); waiting.delete(id); resolve(msg); });
      socket.write(frame(JSON.stringify({ id, type, payload })));
    });
    const ms = Date.now() - t0;
    say(`${type} ${JSON.stringify(payload)} -> ${answer.timedOut ? 'NO ANSWER (server cut)' : answer.success ? 'ok' : `error ${answer.error?.message}`} in ${ms} ms`);
    return { ...answer, ms };
  }
  const answered = (r) => !r.timedOut && r.success;

  return {
    listen: (port) => new Promise((resolve) => wsServer.listen(port, '127.0.0.1', resolve)),
    close: () => wsServer.close(),
    connected: () => socket !== null,
    command,
    answered,
  };
}
