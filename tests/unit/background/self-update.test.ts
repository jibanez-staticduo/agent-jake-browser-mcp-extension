import { describe, expect, it, vi } from 'vitest';
import { zipSync, strToU8, unzipSync } from 'fflate';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { applyUpdate, cleanupAfterUpdate, DownloadStalledError, FILES_KEY, LOCK_KEY, PENDING_KEY, type SelfUpdateDeps } from '@/background/self-update';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUB = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
const LATEST = { version: '2.4.0.141', build: 141, sha: 'def5678', publishedAt: '2026-10-05T10:00:00Z' };

function pkg(files: Record<string, string>, meta = { version: LATEST.version, build: LATEST.build, sha: LATEST.sha }, extra: Record<string, string> = {}, tamper = false) {
  const list = { ...meta, files: Object.entries(files).map(([path, c]) => ({ path, sha256: createHash('sha256').update(c).digest('hex'), size: Buffer.byteLength(c) })) };
  const body = Buffer.from(JSON.stringify(list));
  const sig = sign(null, body, privateKey).toString('base64');
  const entries: Record<string, Uint8Array> = { 'update-files.json': new Uint8Array(body), 'update-files.json.sig': strToU8(sig) };
  for (const [p, c] of Object.entries({ ...files, ...extra })) entries[p] = strToU8(tamper && p.endsWith('.js') ? c + ';evil()' : c);
  return zipSync(entries);
}
const FILES = { 'manifest.json': '{"version":"2.4.0.141"}', 'assets/a-2.js': 'a2', 'service-worker-loader.js': 'import "./assets/a-2.js"' };

function deps(over: Partial<SelfUpdateDeps> = {}, zip = pkg(FILES)) {
  const disk = new Map<string, string>(); const store = new Map<string, unknown>(); const ids = new Map<number, string>();
  let next = 1; const writes: string[] = []; const notes: string[] = [];
  const d: SelfUpdateDeps & { disk: typeof disk; store: typeof store; writes: string[]; notes: string[]; reloaded: number; ui: boolean[] } = {
    disk, store, writes, notes, reloaded: 0, ui: [],
    currentBuild: 140, publicKey: PUB,
    fetchBytes: async () => zip,
    unzip: unzipSync,
    writeFile: async (path, url) => { writes.push(path); disk.set(path, Buffer.from(url.split(',')[1], 'base64').toString()); const id = next++; ids.set(id, path); return id; },
    removeFile: async (id) => { disk.delete(ids.get(id)!); },
    erase: async (id) => { ids.delete(id); },
    setDownloadUi: async (on) => { d.ui.push(on); },
    readOwnFile: async (p) => disk.get(p) ?? null,
    lastToolActivityAt: async () => null,
    storage: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); }, remove: async (k) => { store.delete(k); } },
    reload: () => { d.reloaded++; },
    notify: async (p) => { notes.push(p); },
    now: () => 1_000_000_000,
    randomId: () => 'r1',
    ...over,
  };
  return d;
}

const run = (d: SelfUpdateDeps, latest = LATEST) => applyUpdate(latest, 'https://pod/download', d);
type D = ReturnType<typeof deps>;
const pkgWrites = (d: D) => d.writes.filter((p) => !p.startsWith('agent-jake-probe-'));

describe('applyUpdate', () => {
  it('1. applies in order, reloads once, leaves pendingCleanup + files, toggles the UI, releases the lock', async () => {
    const d = deps();
    const r = await run(d);
    expect(r.status).toBe('applied');
    expect(d.writes[0]).toMatch(/^agent-jake-probe-/);
    expect(pkgWrites(d)).toEqual(['assets/a-2.js', 'manifest.json', 'service-worker-loader.js']);
    expect(d.reloaded).toBe(1);
    expect(d.store.has(PENDING_KEY)).toBe(true);
    expect(Object.keys(d.store.get(FILES_KEY) as object).sort()).toEqual(['assets/a-2.js', 'manifest.json', 'service-worker-loader.js']);
    expect(d.ui).toEqual([false, true]);
    expect(d.store.has(LOCK_KEY)).toBe(false);
  });

  it('2. already on the published build: up-to-date, no writes, no fetch', async () => {
    const fetchBytes = vi.fn();
    const d = deps({ currentBuild: 141, fetchBytes });
    expect((await run(d)).status).toBe('up-to-date');
    expect(d.writes).toEqual([]);
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('3. a live lock blocks, an expired one does not', async () => {
    const d1 = deps();
    d1.store.set(LOCK_KEY, d1.now() - 60_000);
    expect((await run(d1)).status).toBe('locked');
    expect(d1.writes).toEqual([]);
    const d2 = deps();
    d2.store.set(LOCK_KEY, d2.now() - 11 * 60_000);
    expect((await run(d2)).status).toBe('applied');
  });

  it('4. recent MCP tool activity: busy, nothing written, lock released', async () => {
    const d = deps({ lastToolActivityAt: async () => 1_000_000_000 - 2 * 60_000 });
    expect((await run(d)).status).toBe('busy');
    expect(d.writes).toEqual([]);
    expect(d.store.has(LOCK_KEY)).toBe(false);
  });

  it('5. unreadable probe: not-eligible, not-in-downloads notice, only the probe written (and removed)', async () => {
    const d = deps({ readOwnFile: async () => null });
    expect(await run(d)).toEqual({ status: 'not-eligible', reason: 'not-in-downloads' });
    expect(d.notes).toEqual(['not-in-downloads']);
    expect(d.writes).toHaveLength(1);
    expect(d.disk.size).toBe(0);
  });

  it('6. stalled probe: not-eligible with download-prompt notice', async () => {
    const d = deps({ writeFile: async () => { throw new DownloadStalledError('probe'); } });
    expect(await run(d)).toEqual({ status: 'not-eligible', reason: 'download-prompt' });
    expect(d.notes).toEqual(['download-prompt']);
  });

  it('7. invalid signature (other key): rejected, bad-package notice, only the probe written', async () => {
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
    const d = deps({ publicKey: other });
    expect((await run(d)).status).toBe('rejected');
    expect(d.notes).toEqual(['bad-package']);
    expect(pkgWrites(d)).toEqual([]);
  });

  it('8. hash mismatch: rejected, no package file written', async () => {
    const d = deps({}, pkg(FILES, undefined, {}, true));
    expect((await run(d)).status).toBe('rejected');
    expect(pkgWrites(d)).toEqual([]);
  });

  it('9. build in the signed list differs from latest, or is not newer than current: rejected', async () => {
    const d1 = deps({}, pkg(FILES));
    expect((await run(d1, { ...LATEST, build: 142 })).status).toBe('rejected');
    expect(pkgWrites(d1)).toEqual([]);
    const d2 = deps({ currentBuild: 141 }, pkg(FILES));
    expect((await run(d2, { ...LATEST, build: 142 })).status).toBe('rejected');
    expect(pkgWrites(d2)).toEqual([]);
  });

  it('10. a config.json present in the zip but not in the signed list is never written', async () => {
    const d = deps({}, pkg(FILES, undefined, { 'config.json': '{}' }));
    expect((await run(d)).status).toBe('applied');
    expect(d.writes).not.toContain('config.json');
  });

  it('11. a write failing mid-way: failed, write-failed notice, no pendingCleanup, no lock, UI restored, no reload', async () => {
    const base = deps();
    let calls = 0;
    const d = deps({ writeFile: async (p, u) => { if (++calls === 3) throw new Error('boom'); return base.writeFile(p, u); }, readOwnFile: base.readOwnFile, removeFile: base.removeFile, erase: base.erase });
    const r = await run(d);
    expect(r.status).toBe('failed');
    expect(d.notes).toEqual(['write-failed']);
    expect(d.store.has(PENDING_KEY)).toBe(false);
    expect(d.store.has(LOCK_KEY)).toBe(false);
    expect(d.ui.at(-1)).toBe(true);
    expect(d.reloaded).toBe(0);
  });

  it('12. same problem and build on two passes notifies once', async () => {
    const d = deps({ readOwnFile: async () => null });
    await run(d);
    await run(d);
    expect(d.notes).toHaveLength(1);
  });

  it('13. republished same build: up-to-date, nothing rewritten', async () => {
    const d = deps({ currentBuild: 141 });
    expect((await run(d, { ...LATEST, build: 141 })).status).toBe('up-to-date');
    expect(d.writes).toEqual([]);
  });
});

describe('cleanupAfterUpdate', () => {
  const seed = (d: D) => {
    d.disk.set('manifest.json', 'new'); d.disk.set('assets/a-1.js', 'old');
    d.store.set(FILES_KEY, { 'manifest.json': 1, 'assets/a-1.js': 2 });
    d.store.set(PENDING_KEY, { build: 141, previous: { 'manifest.json': 1, 'assets/a-1.js': 2 }, written: { 'manifest.json': 5, 'assets/a-2.js': 6 } });
  };

  it('14. removes only files that left the list, erases every old entry, keeps shared paths', async () => {
    const d = deps({ currentBuild: 141 });
    const removeFile = vi.spyOn(d, 'removeFile');
    const erase = vi.spyOn(d, 'erase');
    seed(d);
    await cleanupAfterUpdate(d);
    expect(removeFile.mock.calls.map((c) => c[0])).toEqual([2]);
    expect(erase.mock.calls.map((c) => c[0]).sort()).toEqual([1, 2]);
    expect(d.disk.has('manifest.json')).toBe(true);
    expect(d.store.has(PENDING_KEY)).toBe(false);
  });

  it('14b. does nothing while the running build is not the new one', async () => {
    const d = deps({ currentBuild: 140 });
    const removeFile = vi.spyOn(d, 'removeFile');
    seed(d);
    await cleanupAfterUpdate(d);
    expect(removeFile).not.toHaveBeenCalled();
    expect(d.store.has(PENDING_KEY)).toBe(true);
  });
});
