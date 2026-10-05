import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
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

describe('update-files.mjs', () => {
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
