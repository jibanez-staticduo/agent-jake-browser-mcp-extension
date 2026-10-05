import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { parseUpdateFiles, verifySignature } from '@/background/update-package';

function dist() {
  const d = mkdtempSync(join(tmpdir(), 'ajb-dist-'));
  mkdirSync(join(d, 'assets')); mkdirSync(join(d, '.vite'));
  writeFileSync(join(d, 'manifest.json'), '{"version":"2.4.0"}');
  writeFileSync(join(d, 'assets', 'a-1.js'), 'console.log(1)');
  writeFileSync(join(d, '.vite', 'manifest.json'), '{}');
  return d;
}
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

// @ts-expect-error plain .mjs without types
import { assertNoCaseDuplicates } from '../../../scripts/update-files.mjs';

// The tmp FS may be case-insensitive (macOS default): then both names cannot coexist on disk.
const caseSensitiveFs = (() => {
  const d = mkdtempSync(join(tmpdir(), 'ajb-case-'));
  writeFileSync(join(d, 'x'), '1');
  return !existsSync(join(d, 'X'));
})();

describe('update-files.mjs', () => {
  it('assertNoCaseDuplicates rejects assets/A.js + assets/a.js (listing-level, any FS)', () => {
    expect(() => assertNoCaseDuplicates(['manifest.json', 'assets/A.js', 'assets/a.js'])).toThrow(/case-insensitive/);
    expect(() => assertNoCaseDuplicates(['manifest.json', 'assets/a.js'])).not.toThrow();
  });
  it.skipIf(!caseSensitiveFs)('sign throws on a dist holding assets/A.js and assets/a.js (case-sensitive FS only)', () => {
    const d = dist(); writeFileSync(join(d, 'assets', 'A.js'), 'x'); writeFileSync(join(d, 'assets', 'a.js'), 'y');
    expect(() => execFileSync('node', ['scripts/update-files.mjs', 'sign', d, '--version', 'v', '--build', '1', '--sha', 's'], { env: { ...process.env, AJB_UPDATE_SIGNING_KEY: pem }, stdio: 'pipe' })).toThrow();
  });
  it('signs every non-dot file and the extension accepts the result', async () => {
    const d = dist();
    execFileSync('node', ['scripts/update-files.mjs', 'sign', d, '--version', '2.4.0.140', '--build', '140', '--sha', 'abc1234'], { env: { ...process.env, AJB_UPDATE_SIGNING_KEY: pem } });
    const bytes = readFileSync(join(d, 'update-files.json'));
    const files = parseUpdateFiles(JSON.parse(bytes.toString()));
    expect(files?.files.map((f) => f.path).sort()).toEqual(['assets/a-1.js', 'manifest.json']);
    expect(await verifySignature(new Uint8Array(bytes), readFileSync(join(d, 'update-files.json.sig'), 'utf8'), pub)).toBe(true);
    expect(() => execFileSync('node', ['scripts/update-files.mjs', 'verify', d, '--pub', pub])).not.toThrow();
  });
  it('fails on a file the extension would refuse to write', () => {
    const d = dist(); writeFileSync(join(d, 'tool.exe'), 'x');
    expect(() => execFileSync('node', ['scripts/update-files.mjs', 'sign', d, '--version', 'v', '--build', '1', '--sha', 's'], { env: { ...process.env, AJB_UPDATE_SIGNING_KEY: pem }, stdio: 'pipe' })).toThrow();
  });
  it.each(['assets/con.js', 'lpt1.css', 'dir./x.js'])('fails on a path the extension would refuse (%s)', (rel) => {
    const d = dist();
    const parts = rel.split('/');
    if (parts.length > 1) mkdirSync(join(d, parts[0]), { recursive: true });
    writeFileSync(join(d, ...parts), 'x');
    expect(() => execFileSync('node', ['scripts/update-files.mjs', 'sign', d, '--version', 'v', '--build', '1', '--sha', 's'], { env: { ...process.env, AJB_UPDATE_SIGNING_KEY: pem }, stdio: 'pipe' })).toThrow();
  });
  it('fails without the key and never prints it', () => {
    const d = dist();
    expect(() => execFileSync('node', ['scripts/update-files.mjs', 'sign', d, '--version', 'v', '--build', '1', '--sha', 's'], { env: { ...process.env, AJB_UPDATE_SIGNING_KEY: '' }, stdio: 'pipe' })).toThrow();
  });
});
