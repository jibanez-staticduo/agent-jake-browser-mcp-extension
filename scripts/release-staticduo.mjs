#!/usr/bin/env node
// Offline neutral release builder. The private key is opened only after Vite has exited.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, unzipSync } from 'fflate';
import { buildUpdateFiles } from './update-files.mjs';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
// The source archive includes bundled fonts and exceeds Node's default 1 MiB buffer.
export const CHILD_MAX_BUFFER = 64 * 1024 * 1024;
export function sourceArchive() {
  return execFileSync('git', ['archive', 'HEAD'], { cwd: repo, maxBuffer: CHILD_MAX_BUFFER });
}
const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const fail = (message) => { throw new Error(message); };
const within = (base, target) => { const rel = relative(base, target); return !rel.startsWith('..') && !isAbsolute(rel); };
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const pinned = () => readFileSync(join(repo, 'src/config/update-key.ts'), 'utf8').match(/PINNED_UPDATE_PUBLIC_KEY = '([^']+)'/)[1];
const pubKey = (raw) => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw, 'base64')]), format: 'der', type: 'spki' });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function walk(dir, prefix = '') {
  return readdirSync(dir).sort().flatMap((name) => {
    const full = join(dir, name), rel = prefix + name, stat = lstatSync(full);
    if (stat.isSymbolicLink()) fail('symlinks are forbidden in release');
    return stat.isDirectory() ? walk(full, rel + '/') : [rel];
  });
}
export function verifyBundle(dir, rawPublicKey = pinned()) {
  const zipBytes = readFileSync(join(dir, 'agent-jake-browser-extension.zip'));
  const zip = unzipSync(zipBytes);
  const body = zip['update-files.json'], sig = zip['update-files.json.sig'];
  if (!body || !sig || !verify(null, body, pubKey(rawPublicKey), Buffer.from(Buffer.from(sig).toString().trim(), 'base64'))) fail('invalid signature');
  const manifest = JSON.parse(Buffer.from(body).toString());
  const latest = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'));
  if (latest.sha256 !== digest(zipBytes)) fail('ZIP digest mismatch');
  if (manifest.version !== latest.version || manifest.build !== latest.build || manifest.sha !== latest.sha) fail('release identity mismatch');
  if (JSON.parse(Buffer.from(zip['manifest.json']).toString()).version !== manifest.version) fail('Chrome version mismatch');
  const expected = new Set(['update-files.json', 'update-files.json.sig']);
  for (const entry of manifest.files) {
    if (entry.path === 'config.json' || expected.has(entry.path)) fail('duplicate or reserved file');
    expected.add(entry.path);
    if (!zip[entry.path] || zip[entry.path].length !== entry.size || digest(zip[entry.path]) !== entry.sha256) fail('file integrity mismatch');
  }
  if (Object.keys(zip).some((name) => !expected.has(name))) fail('unlisted file in ZIP');
  return latest;
}
async function main() {
  if (process.argv.includes('--verify')) {
    const latest = verifyBundle(resolve(arg('--verify')), arg('--public-key') || pinned());
    console.log(`verified ${latest.version} (${latest.sha})`); return;
  }
  const test = process.argv.includes('--test');
  const keyPath = arg('--key-file'), output = arg('--out');
  if (!keyPath || !output) fail('usage: release-staticduo.mjs --key-file /secure/private.pem --out /outside/repo/bundle [--test --working-tree --build N --latest-url http://127.0.0.1:PORT/download/latest.json]');
  const keyFile = realpathSync(resolve(keyPath)), out = resolve(output);
  if (within(repo, keyFile) || within(repo, out)) fail('key and output must be outside the repository');
  if ((lstatSync(keyFile).mode & 0o077) !== 0) fail('private key must have mode 0600 or stricter');
  if (existsSync(out)) fail('output already exists; use a new immutable bundle path');
  if (process.env.VITE_UPDATE_PUBLIC_KEY || process.env.AJB_UPDATE_SIGNING_KEY) fail('secret/test key environment is forbidden; use --key-file');
  if (!test && (arg('--build') || arg('--latest-url') || process.argv.includes('--working-tree'))) fail('test overrides require --test');
  const build = Number(arg('--build') || git('rev-list', '--count', 'HEAD'));
  if (!Number.isInteger(build) || build < 1 || build > 65535) fail('Chrome build component must be 1..65535; bump base version before overflow');
  const sha = git('rev-parse', '--short=12', 'HEAD');
  const version = `2.6.0.${build}`;
  const prev = arg('--previous');
  if (prev) {
    const previousBuild = JSON.parse(readFileSync(prev, 'utf8')).build;
    if (!Number.isInteger(previousBuild) || previousBuild < 1) fail('invalid previous build');
    if (previousBuild >= build) fail('build must strictly increase over --previous latest.json');
  }
  let testPub;
  if (test) testPub = createPublicKey(createPrivateKey(readFileSync(keyFile))).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const latestUrl = arg('--latest-url') || '';
  if (latestUrl && !/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+\/download\/latest\.json$/.test(latestUrl)) fail('test latest URL must be loopback');
  const temp = mkdtempSync(join(tmpdir(), 'ajb-release-'));
  try {
    const src = join(temp, 'src'), dist = join(temp, 'dist'); mkdirSync(src);
    if (process.argv.includes('--working-tree')) cpSync(repo, src, { recursive: true, filter: (p) => !['.git', 'node_modules', 'dist'].includes(relative(repo, p).split('/')[0]) && !relative(repo, p).split('/').some((n) => n.startsWith('.env')) });
    else {
      const archive = sourceArchive();
      execFileSync('tar', ['-x', '-C', src], { input: archive });
    }
    // Even committed environment files must not seed the neutral artifact.
    for (const name of readdirSync(src)) if (name.startsWith('.env')) rmSync(join(src, name), { force: true });
    symlinkSync(join(repo, 'node_modules'), join(src, 'node_modules'), 'dir');
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('VITE_') || name.startsWith('AJB_UPDATE_')) delete env[name];
    Object.assign(env, { VITE_BUILD_NUMBER: String(build), VITE_BUILD_SHA: sha, VITE_LATEST_URL: latestUrl });
    if (test) env.VITE_UPDATE_PUBLIC_KEY = testPub;
    execFileSync(join(repo, 'node_modules/.bin/vite'), ['build', '--outDir', dist, '--emptyOutDir'], { cwd: src, env, stdio: 'pipe', maxBuffer: CHILD_MAX_BUFFER });
    rmSync(join(dist, '.vite'), { recursive: true, force: true });
    rmSync(join(dist, 'config.json'), { force: true });
    const manifestPath = join(dist, 'manifest.json'), manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.version = version; writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const files = walk(dist);
    const config = files.filter((p) => /^assets\/config-.*\.js$/.test(p)).map((p) => readFileSync(join(dist, p), 'utf8')).join('');
    if (!config.includes(`BUILD_NUMBER:${build}`) || !config.includes(`BUILD_SHA:"${sha}"`) || !config.includes('WS_TOKEN:""') || !config.includes('COPILOT_API_KEY:""')) fail('neutral build identity/credential guard failed');
    const rawPublic = test ? testPub : pinned();
    if (!files.some((p) => p.endsWith('.js') && readFileSync(join(dist, p), 'utf8').includes(rawPublic))) fail('pinned public key absent from build');
    // Only now read the private key; no build child receives it.
    const privateKey = createPrivateKey(readFileSync(keyFile));
    if (privateKey.asymmetricKeyType !== 'ed25519') fail('signer must be Ed25519');
    const actualPublic = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    if (actualPublic !== rawPublic) fail('signer does not match pinned public key');
    const body = Buffer.from(JSON.stringify(buildUpdateFiles(dist, { version, build, sha }), null, 1));
    writeFileSync(join(dist, 'update-files.json'), body);
    writeFileSync(join(dist, 'update-files.json.sig'), sign(null, body, privateKey).toString('base64'));
    const entries = Object.fromEntries(walk(dist).map((p) => [p, readFileSync(join(dist, p))]));
    const bundle = join(temp, 'bundle'); mkdirSync(bundle);
    const zipBytes = zipSync(entries);
    writeFileSync(join(bundle, 'agent-jake-browser-extension.zip'), zipBytes);
    writeFileSync(join(bundle, 'latest.json'), JSON.stringify({ version, build, sha, publishedAt: new Date().toISOString(), sha256: digest(zipBytes), download: '/download/artifact.zip' }) + '\n');
    verifyBundle(bundle, rawPublic);
    mkdirSync(dirname(out), { recursive: true });
    const staged = out + '.tmp-' + process.pid;
    cpSync(bundle, staged, { recursive: true }); renameSync(staged, out);
    console.log(`${test ? 'TEST ONLY ' : ''}release ${version} (${sha}) verified at ${out}`);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`release: ${e.message}`); process.exitCode = 1; });
