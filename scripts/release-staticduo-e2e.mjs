#!/usr/bin/env node
// Portable StaticDuo end-to-end check of the self-update, in a throwaway Chrome (not part of CI).
//   node scripts/release-staticduo-e2e.mjs             A(9000) -> B(9001) -> C(9002), asserts disk, storage and cleanup
//   node scripts/release-staticduo-e2e.mjs --tamper    B has one byte flipped after signing: stays on 9000, disk untouched
//   node scripts/release-staticduo-e2e.mjs --prompt    "Ask where to save" on: stays on 9000, does not hang
// Safety: own --user-data-dir (mkdtemp), own debugging port (never 9222), headless, only our PIDs are killed.
// Never connects to the user's Chrome and never uses his profile.
import { spawn, execFileSync } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { createServer } from 'node:http';
import { generateKeyPairSync, createHash, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { chromium } from 'playwright';
import { buildUpdateFiles } from './update-files.mjs';

const CHROME = process.env.AJB_TEST_CHROME || chromium.executablePath();
const repo = fileURLToPath(new URL('..', import.meta.url));
const mode = process.argv.includes('--wrong-key') ? 'wrong-key' : process.argv.includes('--identity') ? 'identity' : process.argv.includes('--tamper') ? 'tamper' : process.argv.includes('--prompt') ? 'prompt' : 'update';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.log(`[e2e:${mode}] ${m}`);
let failures = 0;
const check = (ok, msg) => { say(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failures++; };

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ajb-e2e-')));
const dl = join(root, 'dl');
const prof = join(root, 'profile');
const installDir = join(dl, 'agent-jake-browser');
let chrome = null;
let server = null;
let pipeId = 0, pipeBuffer = '', pipePending = new Map();
function pipeCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++pipeId;
    const timer = setTimeout(() => { pipePending.delete(id); reject(new Error(`pipe timeout ${method}`)); }, 45000);
    pipePending.set(id, { resolve, reject, timer });
    chrome.stdio[3].write(JSON.stringify({ id, method, params }) + '\0');
  });
}

async function freePort() {
  for (;;) {
    const port = await new Promise((res) => { const s = netServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
    if (port !== 9222) return port;
  }
}

// ---- builds ----------------------------------------------------------------------------------
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubB64 = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
const wrongPrivate = generateKeyPairSync('ed25519').privateKey;

function build(outDir, buildNo, httpPort) {
  const env = { ...process.env };
  for (const k of ['VITE_WS_HOST', 'VITE_WS_PORT', 'VITE_WS_PATH', 'VITE_WS_SECURE', 'VITE_WS_TOKEN', 'VITE_COPILOT_BASE_URL', 'VITE_COPILOT_API_KEY']) delete env[k];
  Object.assign(env, {
    VITE_BUILD_NUMBER: String(buildNo), VITE_BUILD_SHA: `e2e${buildNo}`,
    VITE_LATEST_URL: `http://127.0.0.1:${httpPort}/download/latest.json`, VITE_UPDATE_PUBLIC_KEY: pubB64,
  });
  execFileSync('npx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir'], { cwd: repo, env, stdio: 'pipe' });
  rmSync(join(outDir, '.vite'), { recursive: true, force: true });
  const mp = join(outDir, 'manifest.json');
  const m = JSON.parse(readFileSync(mp, 'utf8'));
  m.version = `${m.version.split('.').slice(0, 3).join('.')}.${buildNo}`;
  writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
}

function walk(dir, base = dir) {
  return readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    return statSync(full).isDirectory() ? walk(full, base) : [relative(base, full).split(sep).join('/')];
  }).sort();
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const snapshot = (dir) => Object.fromEntries(walk(dir).map((p) => [p, sha(readFileSync(join(dir, p)))]));

function sign(dir, buildNo) {
  const version = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).version;
  const manifest = buildUpdateFiles(dir, { version, build: buildNo, sha: `e2e${buildNo}` });
  if (mode === 'identity') manifest.version = '0.0.0.1';
  const body = Buffer.from(JSON.stringify(manifest));
  writeFileSync(join(dir, 'update-files.json'), body);
  writeFileSync(join(dir, 'update-files.json.sig'), cryptoSign(null, body, mode === 'wrong-key' ? wrongPrivate : privateKey).toString('base64'));
}
function zipOf(dir, tamper = false) {
  const entries = {};
  for (const p of walk(dir)) entries[p] = new Uint8Array(readFileSync(join(dir, p)));
  if (tamper) {
    const js = Object.keys(entries).find((p) => p.startsWith('assets/config-') && p.endsWith('.js'));
    entries[js] = entries[js].slice(); entries[js][entries[js].length - 1] ^= 0x01; // same size, different hash
  }
  return Buffer.from(zipSync(entries));
}

// ---- CDP helpers (always against OUR port) ---------------------------------------------------
let port = 0;
async function getJson(path) {
  for (let i = 0; i < 60; i++) { try { return await (await fetch(`http://127.0.0.1:${port}${path}`)).json(); } catch { await sleep(500); } }
  throw new Error('CDP endpoint did not answer');
}
function cdp(wsUrl, method, params, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error(`CDP timeout ${method}`)); }, timeoutMs);
    ws.onerror = () => { clearTimeout(t); reject(new Error('CDP socket error')); };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) { clearTimeout(t); ws.close(); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } };
  });
}
async function evalIn(target, expression) {
  const r = await cdp(target.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
let extId = '';
let pageTarget = null;
/** The extension's service worker when alive, else (it idles out) a page of the extension. */
async function extContext() {
  const ts = await getJson('/json');
  const sw = ts.find((t) => t.type === 'service_worker' && t.url.includes(extId));
  if (sw) return sw;
  if (pageTarget && ts.some((t) => t.id === pageTarget.id)) return pageTarget;
  pageTarget = await (await fetch(`http://127.0.0.1:${port}/json/new?chrome-extension://${extId}/src/sidepanel/index.html`, { method: 'PUT' })).json();
  await sleep(1500);
  return pageTarget;
}
async function extEval(expr) { return evalIn(await extContext(), expr); }
async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs; let last;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; last = v; } catch (e) { last = e.message; } await sleep(1000); }
  say(`timeout waiting for ${label} (last: ${String(last).slice(0, 200)})`);
  return null;
}

// ---- run -------------------------------------------------------------------------------------
async function main() {
  const dist = { A: join(root, 'distA'), B: join(root, 'distB'), C: join(root, 'distC') };
  // Fixed HTTP port first: it is baked into LATEST_URL of the builds.
  const httpPort = await freePort();
  say(`building A(9000) B(9001)${mode === 'update' ? ' C(9002)' : ''} from the working tree (http :${httpPort})`);
  build(dist.A, 9000, httpPort);
  build(dist.B, 9001, httpPort);
  if (mode === 'update') {
    writeFileSync(join(dist.B, 'assets/b-only.js'), '// only in B: C drops it, so the cleanup after the second update must delete it\n');
    build(dist.C, 9002, httpPort);
  }
  const listOf = (d) => JSON.parse(readFileSync(join(d, 'update-files.json'), 'utf8')).files.map((f) => f.path).sort();
  sign(dist.B, 9001);
  if (mode === 'update') sign(dist.C, 9002);
  const zipB = zipOf(dist.B, mode === 'tamper');
  const zipC = mode === 'update' ? zipOf(dist.C) : null;

  const published = { build: 9001, zip: zipB };
  server = createServer((req, res) => {
    if (req.url === '/download/latest.json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ version: JSON.parse(readFileSync(join(published.build === 9002 ? dist.C : dist.B, 'manifest.json'), 'utf8')).version, build: published.build, sha: `e2e${published.build}`, publishedAt: new Date().toISOString(), download: '/download/artifact.zip' }));
    } else if (req.url === '/download/artifact.zip' || req.url === '/download') {
      res.setHeader('content-type', 'application/zip'); res.end(published.zip);
    } else { res.statusCode = 404; res.end(); }
  }).listen(httpPort, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));

  // Profile: downloads go to <root>/dl without prompt (or with it for --prompt).
  mkdirSync(join(prof, 'Default'), { recursive: true });
  mkdirSync(dl, { recursive: true });
  writeFileSync(join(prof, 'Default/Preferences'), JSON.stringify({
    download: { default_directory: dl, prompt_for_download: mode === 'prompt' },
    savefile: { default_directory: dl },
  }));
  // A is the "initial install": the unpacked folder inside Downloads.
  execFileSync('cp', ['-R', dist.A, installDir]);
  const configBytes = JSON.stringify({ wsUrl: `ws://127.0.0.1:${httpPort}/ws`, browserName: 'preserve-instance-config' }) + '\n';
  writeFileSync(join(installDir, 'config.json'), configBytes);
  const diskA = snapshot(installDir);

  port = await freePort();
  say(`launching throwaway Chrome (port ${port}, profile ${prof})`);
  chrome = spawn(CHROME, [`--user-data-dir=${prof}`, `--remote-debugging-port=${port}`, '--remote-debugging-pipe', '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check', '--disable-sync', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  chrome.stdio[4].on('data', (chunk) => {
    pipeBuffer += chunk.toString();
    let end;
    while ((end = pipeBuffer.indexOf('\0')) >= 0) {
      const body = pipeBuffer.slice(0, end); pipeBuffer = pipeBuffer.slice(end + 1);
      if (!body) continue;
      const message = JSON.parse(body), pending = pipePending.get(message.id);
      if (!pending) continue;
      pipePending.delete(message.id); clearTimeout(pending.timer);
      message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
    }
  });
  const ver = await getJson('/json/version');
  say(`browser ${ver.Browser}`);

  // Developer mode first: otherwise chrome.runtime.reload() leaves the extension disabled (spike).
  await fetch(`http://127.0.0.1:${port}/json/new?chrome://extensions/`, { method: 'PUT' });
  await sleep(2500);
  const extPage = (await getJson('/json')).find((t) => t.url.startsWith('chrome://extensions'));
  const dev = await evalIn(extPage, 'chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true}).then(()=>chrome.developerPrivate.getProfileConfiguration()).then(c=>c.inDeveloperMode)');
  check(dev === true, 'Developer mode enabled');

  const load = await pipeCall('Extensions.loadUnpacked', { path: installDir });
  extId = load.id;
  say(`loaded A as ${extId}`);

  const versionNow = () => extEval('chrome.runtime.getManifest().version');
  const stor = () => extEval('chrome.storage.local.get(null)');

  if (mode === 'update') {
    const v1 = await waitFor(async () => (await versionNow()).endsWith('.9001') && (await versionNow()), 90000, 'B (.9001)');
    check(!!v1, `running ${v1}: the service worker answers a version ending in .9001`);
    const listB = listOf(dist.B);
    const st = await waitFor(async () => { const s = await stor(); return !s['ajb.selfUpdate.pendingCleanup'] ? s : null; }, 20000, 'pendingCleanup to clear');
    check(!!st, 'no ajb.selfUpdate.pendingCleanup left');
    const s1 = st ?? await stor();
    check(JSON.stringify(Object.keys(s1['ajb.selfUpdate.files'] ?? {}).sort()) === JSON.stringify(listB), `ajb.selfUpdate.files has all ${listB.length} paths of B`);
    const diskB = snapshot(installDir);
    const mismatched = listB.filter((p) => diskB[p] !== sha(readFileSync(join(dist.B, p))));
    check(mismatched.length === 0, `every file of B is on disk with B's hash (${mismatched.join(',') || 'ok'})`);
    // The lock is the success marker (expires in 10 min, by design); it must be fresh, never stale.
    const lock = s1['ajb.selfUpdate.lock'];
    check(lock === undefined || Date.now() - lock < 10 * 60_000, `lock absent or a fresh success marker (${lock === undefined ? 'absent' : `${Math.round((Date.now() - lock) / 1000)}s old`})`);
    check(existsSync(join(installDir, 'assets/b-only.js')), 'assets/b-only.js (only in B) is on disk after the first update');
    check(!Object.keys(diskB).some((p) => p.startsWith('agent-jake-probe')), 'no probe file left');

    // Second hop B -> C: files of the first update that C does not ship must be deleted.
    published.build = 9002; published.zip = zipC;
    await extEval(`chrome.storage.local.remove('ajb.selfUpdate.lock')`); // test-only: skip the 10 min success marker
    await extEval(`chrome.alarms.create('ajb-update-check', { when: Date.now() + 500 })`); // the real 30-min trigger, brought forward
    const v2 = await waitFor(async () => (await versionNow()).endsWith('.9002') && (await versionNow()), 90000, 'C (.9002)');
    check(!!v2, `running ${v2}: second update applied`);
    const st2 = await waitFor(async () => { const s = await stor(); return !s['ajb.selfUpdate.pendingCleanup'] ? s : null; }, 20000, 'pendingCleanup to clear (2)');
    check(!!st2, 'no ajb.selfUpdate.pendingCleanup left after the second update');
    check(readFileSync(join(installDir, 'config.json'), 'utf8') === configBytes, 'config.json byte-identical after A -> B -> C');
    check(!existsSync(join(installDir, 'assets/b-only.js')), 'assets/b-only.js (in B, not in C) no longer exists on disk');
    const diskC = snapshot(installDir);
    const listC = listOf(dist.C);
    check(listC.every((p) => diskC[p] === sha(readFileSync(join(dist.C, p)))), `every file of C is on disk with C's hash`);
    const orphansA = Object.keys(diskA).filter((p) => !listC.includes(p) && p in diskC);
    say(`initial-install files not in the lists (kept by design, harmless): ${orphansA.join(', ') || 'none'}`);
  } else if (['tamper', 'wrong-key', 'identity'].includes(mode)) {
    await sleep(20000); // long enough for probe + download + verification
    const s = await stor();
    check((await versionNow()).endsWith('.9000'), 'tampered package: still running .9000');
    const after = snapshot(installDir);
    check(JSON.stringify(after) === JSON.stringify(diskA), 'tampered package: the disk is byte-identical to A');
    check(String(s['ajb.selfUpdate.notified'] ?? '') === 'bad-package:9001', `rejected with a bad-package notice (${s['ajb.selfUpdate.notified']})`);
    check(s['ajb.selfUpdate.lock'] === undefined && s['ajb.selfUpdate.pendingCleanup'] === undefined, 'no lock and no pendingCleanup left');
  } else {
    // 15 s stall + margin; the worker must stay responsive (no hang).
    const s = await waitFor(async () => { const x = await stor(); return x['ajb.selfUpdate.notified'] ? x : null; }, 60000, 'download-prompt notice');
    check(!!s && s['ajb.selfUpdate.notified'] === 'download-prompt:9001', `not-eligible / download-prompt (notified=${s?.['ajb.selfUpdate.notified']})`);
    check((await versionNow()).endsWith('.9000'), 'with the save prompt on: still running .9000');
    const after = snapshot(installDir);
    check(JSON.stringify(after) === JSON.stringify(diskA), 'disk byte-identical to A (probe removed, nothing written)');
    const s2 = await stor();
    check(s2['ajb.selfUpdate.lock'] === undefined, 'no lock left (did not hang)');
  }
}

function killOurChrome() {
  // Only processes started with OUR unique profile dir: the user's Chrome is never touched.
  if (chrome && chrome.exitCode === null) chrome.kill('SIGTERM');
  try {
    const pids = execFileSync('pgrep', ['-f', `user-data-dir=${prof}`]).toString().split('\n').filter(Boolean).map(Number);
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  } catch { /* pgrep exits 1 when nothing matches */ }
}

try {
  await main();
} catch (e) {
  console.error(`[e2e:${mode}] ERROR`, e);
  failures++;
} finally {
  killOurChrome();
  await sleep(1000);
  if (server) server.close();
  rmSync(root, { recursive: true, force: true });
}
say(failures === 0 ? 'ALL ASSERTIONS PASSED' : `${failures} assertion(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
