#!/usr/bin/env node
// Builds and signs update-files.json for a dist directory (CI `publicar`), or verifies it.
// Same path/MIME rules as src/background/update-package.ts (shared table: src/config/update-mime.json).
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MIME = JSON.parse(readFileSync(new URL('../src/config/update-mime.json', import.meta.url), 'utf8'));
const SAFE = /^[A-Za-z0-9._\/-]+$/;
const OWN = new Set(['update-files.json', 'update-files.json.sig']);
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i; // Windows device names, any extension
const safe = (p) => p.length <= 200 && SAFE.test(p)
  && !p.split('/').some((s) => !s || s === '..' || s.startsWith('.') || s.endsWith('.') || RESERVED.test(s.split('.')[0]))
  && Object.hasOwn(MIME, p.slice(p.lastIndexOf('.') + 1).toLowerCase());

export function listFiles(dir, base = dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name.startsWith('.')) return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full, base) : [relative(base, full).split(sep).join('/')];
  }).filter((p) => !OWN.has(p)).sort();
}

export function buildUpdateFiles(dir, { version, build, sha }) {
  const files = listFiles(dir).map((path) => {
    if (!safe(path)) throw new Error(`unsupported file in package: ${path}`);
    const bytes = readFileSync(join(dir, path));
    return { path, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  });
  if (new Set(files.map((f) => f.path.toLowerCase())).size !== files.length) throw new Error('case-insensitive duplicate paths in package');
  if (!files.some((f) => f.path === 'manifest.json')) throw new Error('manifest.json missing');
  return { version, build: Number(build), sha, files };
}

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, dir] = process.argv.slice(2);
  if (cmd === 'sign') {
    const pem = process.env.AJB_UPDATE_SIGNING_KEY || '';
    if (!pem.includes('PRIVATE KEY')) { console.error('AJB_UPDATE_SIGNING_KEY missing'); process.exit(1); }
    const body = Buffer.from(JSON.stringify(buildUpdateFiles(dir, { version: arg('--version'), build: arg('--build'), sha: arg('--sha') }), null, 1));
    writeFileSync(join(dir, 'update-files.json'), body);
    writeFileSync(join(dir, 'update-files.json.sig'), sign(null, body, createPrivateKey(pem)).toString('base64'));
    console.log(`signed ${JSON.parse(body).files.length} files`);
  } else if (cmd === 'verify') {
    const raw = Buffer.from(arg('--pub') || '', 'base64');
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
    const body = readFileSync(join(dir, 'update-files.json'));
    const ok = verify(null, body, key, Buffer.from(readFileSync(join(dir, 'update-files.json.sig'), 'utf8').trim(), 'base64'));
    const files = JSON.parse(body).files;
    const bad = files.filter((f) => createHash('sha256').update(readFileSync(join(dir, f.path))).digest('hex') !== f.sha256);
    if (!ok || bad.length) { console.error(`verify failed (signature ${ok}, bad hashes ${bad.length})`); process.exit(1); }
    console.log(`verified ${files.length} files`);
  } else { console.error('usage: update-files.mjs sign|verify <dir> ...'); process.exit(2); }
}
