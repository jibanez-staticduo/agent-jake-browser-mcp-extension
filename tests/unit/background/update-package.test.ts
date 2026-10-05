import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { supportsEd25519, isSafePath, mimeFor, parseUpdateFiles, sha256Hex, verifySignature, writeOrder, toDataUrl } from '@/background/update-package';

const enc = (s: string) => new TextEncoder().encode(s);

describe('isSafePath', () => {
  it.each(['manifest.json', 'assets/index.ts-loader-BAV7mLrc.js', 'src/sidepanel/index.html', 'icons/icon16.png'])('accepts %s', (p) => expect(isSafePath(p)).toBe(true));
  it.each(['', '/etc/x.js', '../x.js', 'a/../b.js', '.vite/manifest.json', 'assets/.hidden.js', 'a\\b.js', 'x.exe', 'a//b.js', 'config.json ', 'dir./x.js', 'con.js', 'assets/NUL.js', 'a/lpt1.css', 'COM9.json', 'aux.min.js'])('rejects %j', (p) => expect(isSafePath(p)).toBe(false));
});

describe('mimeFor', () => {
  it('maps by extension, case-insensitive', () => {
    expect(mimeFor('a.js')).toBe('text/javascript');
    expect(mimeFor('manifest.json')).toBe('application/json');
    expect(mimeFor('i/x.PNG')).toBe('image/png');
    expect(mimeFor('x.exe')).toBeNull();
  });
});

describe('parseUpdateFiles', () => {
  const ok = { version: '2.4.0.140', build: 140, sha: 'abc1234', files: [{ path: 'manifest.json', sha256: 'a'.repeat(64), size: 10 }] };
  it('accepts a well-formed list', () => expect(parseUpdateFiles(ok)).toEqual(ok));
  it('rejects case-insensitive duplicate paths', () => expect(parseUpdateFiles({ ...ok, files: [...ok.files, { path: 'assets/A.js', sha256: 'a'.repeat(64), size: 1 }, { path: 'assets/a.js', sha256: 'a'.repeat(64), size: 1 }] })).toBeNull());
  it('requires manifest.json', () => expect(parseUpdateFiles({ ...ok, files: [{ path: 'a.js', sha256: 'a'.repeat(64), size: 1 }] })).toBeNull());
  it('rejects unsafe paths, bad hashes, duplicates and bad builds', () => {
    expect(parseUpdateFiles({ ...ok, files: [...ok.files, { path: '../x.js', sha256: 'a'.repeat(64), size: 1 }] })).toBeNull();
    expect(parseUpdateFiles({ ...ok, files: [{ path: 'manifest.json', sha256: 'XYZ', size: 1 }] })).toBeNull();
    expect(parseUpdateFiles({ ...ok, files: [ok.files[0], ok.files[0]] })).toBeNull();
    expect(parseUpdateFiles({ ...ok, build: 1.5 })).toBeNull();
    expect(parseUpdateFiles(null)).toBeNull();
  });
});

describe('verifySignature', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
  const msg = enc('{"build":1}');
  const sig = sign(null, Buffer.from(msg), privateKey).toString('base64');
  it('accepts a valid signature', async () => expect(await verifySignature(msg, sig, pub)).toBe(true));
  it('rejects a tampered message', async () => expect(await verifySignature(enc('{"build":2}'), sig, pub)).toBe(false));
  it('rejects garbage without throwing', async () => expect(await verifySignature(msg, 'not-base64!!', pub)).toBe(false));
});

describe('writeOrder', () => {
  it('writes hashed assets first, then manifest.json, then entry files', () => {
    const f = (path: string) => ({ path, sha256: 'a'.repeat(64), size: 1 });
    const order = writeOrder([f('service-worker-loader.js'), f('manifest.json'), f('assets/a-1.js'), f('icons/i.png'), f('assets/b-2.css')]).map((e) => e.path);
    expect(order).toEqual(['assets/a-1.js', 'assets/b-2.css', 'manifest.json', 'icons/i.png', 'service-worker-loader.js']);
  });
});

it('sha256Hex and toDataUrl', async () => {
  expect(await sha256Hex(enc('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  expect(toDataUrl(enc('hi'), 'text/plain')).toBe('data:text/plain;base64,aGk=');
});

it('supportsEd25519 is true where WebCrypto has Ed25519', async () => {
  expect(await supportsEd25519()).toBe(true);
});
