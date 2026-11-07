import { describe, expect, it, vi } from 'vitest';
import { zipSync, strToU8, unzipSync } from 'fflate';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { applyUpdate, cleanupAfterUpdate, restoreDownloadUi, recordLastAuto, selfUpdateNow, DownloadStalledError, FILES_KEY, LAST_AUTO_KEY, LOCK_KEY, PENDING_KEY, ATTEMPTS_KEY, UI_DISABLED_KEY, type SelfUpdateDeps } from '@/background/self-update';
import type { UpdateState } from '@/background/update-check';

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
  const d: SelfUpdateDeps & { disk: typeof disk; store: typeof store; writes: string[]; notes: string[]; reloaded: number; ui: boolean[]; alive: number; stopped: number } = {
    disk, store, writes, notes, reloaded: 0, ui: [], alive: 0, stopped: 0,
      keepAlive: () => { d.alive++; return () => { d.stopped++; }; },
      supportsEd25519: async () => true,
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
  it('rejects an invalid packaged installation before any file write', async () => {
    const d = deps({ resolveInstallDir: async () => { throw new Error('invalid identity'); } });
    expect(await run(d)).toEqual({ status: 'not-eligible', reason: 'invalid-install-config' });
    expect(d.writes).toEqual([]);
    expect(d.notes).toContain('invalid-install-config');
  });

  it.each(['version', 'sha', 'manifest', 'config'])('rejects a signed package with invalid %s identity before writing extension files', async (kind) => {
    const files = { ...FILES, ...(kind === 'manifest' ? { 'manifest.json': '{"version":"9.9.9"}' } : {}), ...(kind === 'config' ? { 'config.json': '{"wsUrl":"wss://other.test"}' } : {}) };
    const meta = { version: LATEST.version, build: LATEST.build, sha: LATEST.sha, ...(kind === 'version' ? { version: '9.9.9' } : {}), ...(kind === 'sha' ? { sha: 'wrong' } : {}) };
    const d = deps({}, pkg(files, meta));
    expect(await run(d)).toMatchObject({ status: 'rejected' });
    expect(d.notes).toContain('bad-package');
    expect(pkgWrites(d)).toEqual([]);
  });
  it('1. applies in order, reloads once, leaves pendingCleanup + files, toggles the UI, keeps the lock until the reload', async () => {
    const d = deps();
    const r = await run(d);
    expect(r.status).toBe('applied');
    expect(d.writes[0]).toMatch(/^agent-jake-probe-/);
    expect(pkgWrites(d)).toEqual(['assets/a-2.js', 'manifest.json', 'service-worker-loader.js']);
    expect(d.reloaded).toBe(1);
    expect(d.store.has(PENDING_KEY)).toBe(true);
    expect(Object.keys(d.store.get(FILES_KEY) as object).sort()).toEqual(['assets/a-2.js', 'manifest.json', 'service-worker-loader.js']);
    expect(d.ui).toEqual([false, true]);
    expect(d.store.has(LOCK_KEY)).toBe(true);
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

describe('review round 1', () => {
  it('F1 persists the UI-disabled flag during writes and clears it after re-enabling', async () => {
    const d = deps();
    let flagDuringDisable: unknown;
    const orig = d.setDownloadUi;
    d.setDownloadUi = async (on) => { if (!on) flagDuringDisable = d.store.get(UI_DISABLED_KEY); await orig(on); };
    await run(d);
    expect(flagDuringDisable).toBe(true);
    expect(d.store.has(UI_DISABLED_KEY)).toBe(false);
  });

  it('F1 restoreDownloadUi re-enables the UI when the flag survived a dead worker, and clears it', async () => {
    const d = deps();
    d.store.set(UI_DISABLED_KEY, true);
    await restoreDownloadUi(d);
    expect(d.ui).toEqual([true]);
    expect(d.store.has(UI_DISABLED_KEY)).toBe(false);
    await restoreDownloadUi(d);
    expect(d.ui).toEqual([true]);
  });

  it('F1/F11a setDownloadUi(true) throwing still saves state and reloads, flag kept for the next start', async () => {
    const d = deps();
    d.setDownloadUi = async (on) => { if (on) throw new Error('ui boom'); };
    expect((await run(d)).status).toBe('applied');
    expect(d.reloaded).toBe(1);
    expect(d.store.has(PENDING_KEY)).toBe(true);
    expect(d.store.get(UI_DISABLED_KEY)).toBe(true);
  });

  it('F2 an unexpected probe error is reported as probe-failed, not not-in-downloads', async () => {
    const d = deps({ writeFile: async () => { throw new Error('Invalid filename'); } });
    expect(await run(d)).toEqual({ status: 'not-eligible', reason: 'probe-failed' });
    expect(d.notes).toEqual(['probe-failed']);
  });

  it('F3 a mid-way failure erases the history of files already written, but keeps the files', async () => {
    const base = deps();
    let calls = 0;
    const d = deps({ writeFile: async (p, u) => { if (++calls === 3) throw new Error('boom'); return base.writeFile(p, u); }, readOwnFile: base.readOwnFile, removeFile: base.removeFile, erase: base.erase });
    const erase = vi.spyOn(d, 'erase');
    const removeFile = vi.spyOn(d, 'removeFile');
    await run(d);
    expect(erase.mock.calls.map((c) => c[0])).toContain(2);
    expect(removeFile.mock.calls.map((c) => c[0])).not.toContain(2);
    expect(base.disk.has('assets/a-2.js')).toBe(true);
  });

  it('F4 after two attempts for the same build that never took, it stops: failed/not-applied, notified once', async () => {
    const d = deps();
    expect((await run(d)).status).toBe('applied');
    expect(d.store.get(ATTEMPTS_KEY)).toEqual({ build: 141, count: 1 });
    d.store.delete(LOCK_KEY);
    expect((await run(d)).status).toBe('applied');
    expect(d.store.get(ATTEMPTS_KEY)).toEqual({ build: 141, count: 2 });
    d.store.delete(LOCK_KEY);
    const before = d.writes.length;
    expect(await run(d)).toEqual({ status: 'failed', reason: 'not-applied' });
    expect(d.writes.length).toBe(before);
    expect(d.notes).toEqual(['not-applied']);
    expect(d.store.has(LOCK_KEY)).toBe(false);
  });

  it('F5 concurrent calls: the second returns locked and only one write set happens', async () => {
    const d = deps();
    const [a, b] = await Promise.all([run(d), run(d)]);
    expect([a.status, b.status].sort()).toEqual(['applied', 'locked']);
    expect(pkgWrites(d)).toEqual(['assets/a-2.js', 'manifest.json', 'service-worker-loader.js']);
  });

  it('F5 the storage lock stays after success and goes away on every other path', async () => {
    const ok = deps();
    await run(ok);
    expect(ok.store.has(LOCK_KEY)).toBe(true);
    const busy = deps({ lastToolActivityAt: async () => 1_000_000_000 });
    await run(busy);
    expect(busy.store.has(LOCK_KEY)).toBe(false);
  });

  it('F6 keep-alive starts after the lock and is stopped on success and on failure', async () => {
    const ok = deps();
    await run(ok);
    expect([ok.alive, ok.stopped]).toEqual([1, 1]);
    const bad = deps({ readOwnFile: async () => null });
    await run(bad);
    expect([bad.alive, bad.stopped]).toEqual([1, 1]);
  });

  it('F7 browser without Ed25519: not-eligible/unsupported-browser, notified, no fetch', async () => {
    const fetchBytes = vi.fn();
    const d = deps({ supportsEd25519: async () => false, fetchBytes });
    expect(await run(d)).toEqual({ status: 'not-eligible', reason: 'unsupported-browser' });
    expect(d.notes).toEqual(['unsupported-browser']);
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('F11b a zip over 20 MB is rejected as bad-package before unzipping', async () => {
    const unzip = vi.fn();
    const d = deps({ fetchBytes: async () => new Uint8Array(20 * 1024 * 1024 + 1), unzip });
    expect((await run(d)).status).toBe('rejected');
    expect(unzip).not.toHaveBeenCalled();
    expect(d.notes).toEqual(['bad-package']);
  });
});

describe('«Actualizar ahora» (manual)', () => {
  const recent = () => ({ lastToolActivityAt: async () => 1_000_000_000 - 60_000 });
  const manual = (d: SelfUpdateDeps, latest = LATEST) => applyUpdate(latest, 'https://pod/download', d, { manual: true });

  it('applies although the agent used a tool 1 min ago, where the automatic run returns busy for the same deps', async () => {
    const auto = deps(recent());
    expect(await run(auto)).toEqual({ status: 'busy' });
    expect(auto.writes).toEqual([]);
    const d = deps(recent());
    expect(await manual(d)).toEqual({ status: 'applied' });
    expect(d.reloaded).toBe(1);
    expect([...pkgWrites(d)].sort()).toEqual(Object.keys(FILES).sort());
  });

  it('does not even read the activity log', async () => {
    const lastToolActivityAt = vi.fn(async () => 1_000_000_000);
    expect((await manual(deps({ lastToolActivityAt }))).status).toBe('applied');
    expect(lastToolActivityAt).not.toHaveBeenCalled();
  });

  it('still stops after two attempts for the same build: failed/not-applied', async () => {
    const d = deps(recent());
    d.store.set(ATTEMPTS_KEY, { build: 141, count: 2 });
    expect(await manual(d)).toEqual({ status: 'failed', reason: 'not-applied' });
    expect(d.writes).toEqual([]);
    expect(d.reloaded).toBe(0);
  });

  it('still rejects a tampered package and a package signed with another key', async () => {
    const tampered = deps(recent(), pkg(FILES, undefined, {}, true));
    expect((await manual(tampered)).status).toBe('rejected');
    expect(pkgWrites(tampered)).toEqual([]);
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
    const badKey = deps({ ...recent(), publicKey: other });
    expect((await manual(badKey)).status).toBe('rejected');
    expect(pkgWrites(badKey)).toEqual([]);
    expect(badKey.reloaded).toBe(0);
  });

  it('still needs the probe: not-eligible when it cannot read its own folder', async () => {
    const d = deps({ ...recent(), readOwnFile: async () => null });
    expect(await manual(d)).toEqual({ status: 'not-eligible', reason: 'not-in-downloads' });
    expect(d.reloaded).toBe(0);
  });

  it('still needs Ed25519 support', async () => {
    const d = deps({ ...recent(), supportsEd25519: async () => false });
    expect(await manual(d)).toEqual({ status: 'not-eligible', reason: 'unsupported-browser' });
  });

  it('still honours a live lock and the in-worker guard', async () => {
    const held = deps(recent());
    held.store.set(LOCK_KEY, held.now() - 60_000);
    expect(await manual(held)).toEqual({ status: 'locked' });
    const d = deps(recent());
    const [a, b] = await Promise.all([manual(d), manual(d)]);
    expect([a.status, b.status].sort()).toEqual(['applied', 'locked']);
    expect(d.reloaded).toBe(1);
  });

  it('already on the published build: up-to-date', async () => {
    expect(await manual(deps(recent()), { ...LATEST, build: 140 })).toEqual({ status: 'up-to-date' });
  });
});

describe('selfUpdateNow', () => {
  const state = (over: Partial<UpdateState> = {}): UpdateState => ({
    available: true, latest: LATEST, current: { version: '2.4.0.140', build: 140, sha: 'abc' },
    downloadUrl: 'https://pod/download', checkedAt: '2026-10-05T10:00:00Z', ...over,
  });

  it('no check result (no URL, offline, nothing published): explicit failed/no-check, nothing fetched', async () => {
    const d = deps();
    const fetchBytes = vi.fn(d.fetchBytes);
    d.fetchBytes = fetchBytes;
    expect(await selfUpdateNow(null, d)).toEqual({ status: 'failed', reason: 'no-check' });
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('check without a download URL: failed/no-check', async () => {
    expect(await selfUpdateNow(state({ downloadUrl: undefined }), deps())).toEqual({ status: 'failed', reason: 'no-check' });
  });

  it('nothing newer published: up-to-date, nothing written', async () => {
    const d = deps();
    expect(await selfUpdateNow(state({ available: false }), d)).toEqual({ status: 'up-to-date' });
    expect(d.writes).toEqual([]);
  });

  it('newer build and a busy agent: applied (manual run), reload scheduled once', async () => {
    const d = deps({ lastToolActivityAt: async () => 1_000_000_000 - 60_000 });
    expect(await selfUpdateNow(state(), d)).toEqual({ status: 'applied' });
    expect(d.reloaded).toBe(1);
  });
});

describe('recordLastAuto', () => {
  it('stores status, reason and time of the automatic result', async () => {
    const d = deps();
    await recordLastAuto({ status: 'busy' }, d);
    expect(d.store.get(LAST_AUTO_KEY)).toEqual({ status: 'busy', at: 1_000_000_000 });
    await recordLastAuto({ status: 'not-eligible', reason: 'download-prompt' }, d);
    expect(d.store.get(LAST_AUTO_KEY)).toEqual({ status: 'not-eligible', reason: 'download-prompt', at: 1_000_000_000 });
  });

  it('stores the build the run was about, so the panel shows the line only for that build', async () => {
    const d = deps();
    await recordLastAuto({ status: 'busy' }, d, 142);
    expect(d.store.get(LAST_AUTO_KEY)).toEqual({ status: 'busy', build: 142, at: 1_000_000_000 });
    await recordLastAuto({ status: 'failed', reason: 'not-applied' }, d, 143);
    expect(d.store.get(LAST_AUTO_KEY)).toEqual({ status: 'failed', reason: 'not-applied', build: 143, at: 1_000_000_000 });
  });

  it('does not store a build for a null result, and keeps the old build-tagged value', async () => {
    const d = deps();
    await recordLastAuto({ status: 'busy' }, d, 142);
    await recordLastAuto(null, d, 143);
    expect(d.store.get(LAST_AUTO_KEY)).toEqual({ status: 'busy', build: 142, at: 1_000_000_000 });
  });

  it('keeps the previous value when the run did nothing (null: no update available)', async () => {
    const d = deps();
    await recordLastAuto({ status: 'busy' }, d);
    await recordLastAuto(null, d);
    expect(d.store.get(LAST_AUTO_KEY)).toMatchObject({ status: 'busy' });
  });
});
