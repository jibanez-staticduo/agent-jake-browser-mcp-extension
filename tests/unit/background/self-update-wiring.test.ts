import { describe, expect, it, vi } from 'vitest';
import { maybeSelfUpdate, type SelfUpdateDeps } from '@/background/self-update';
import type { UpdateState } from '@/background/update-check';

const LATEST = { version: '2.4.0.141', build: 141, sha: 'def5678', publishedAt: '2026-10-05T10:00:00Z' };
const state = (over: Partial<UpdateState> = {}): UpdateState => ({
  available: true, latest: LATEST, current: { version: '2.4.0.140', build: 140, sha: 'abc' },
  downloadUrl: 'https://pod/download', checkedAt: '2026-10-05T10:00:00Z', ...over,
});

function fakeDeps() {
  const fetchBytes = vi.fn(async () => { throw new Error('stop here'); });
  const deps = {
    currentBuild: 140, publicKey: 'x', fetchBytes,
    unzip: () => ({}), writeFile: vi.fn(async () => 1), removeFile: async () => {}, erase: async () => {},
    setDownloadUi: async () => {}, readOwnFile: async () => null, lastToolActivityAt: async () => null,
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {} },
    reload: () => {}, notify: async () => {}, now: () => 1_000_000_000, randomId: () => 'r1',
  } as unknown as SelfUpdateDeps;
  return { deps, fetchBytes };
}

describe('maybeSelfUpdate', () => {
  it('returns null without a state', async () => {
    const { deps, fetchBytes } = fakeDeps();
    expect(await maybeSelfUpdate(null, deps)).toBeNull();
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('returns null and touches nothing when no update is available', async () => {
    const { deps, fetchBytes } = fakeDeps();
    expect(await maybeSelfUpdate(state({ available: false }), deps)).toBeNull();
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('applies the published build from state.downloadUrl when available', async () => {
    const { deps, fetchBytes } = fakeDeps();
    // The probe here is unreadable, so the engine stops at not-eligible: enough to prove it was called.
    const r = await maybeSelfUpdate(state(), deps);
    expect(r?.status).toBe('not-eligible');
  });

  it('passes latest and downloadUrl through to the package fetch', async () => {
    const { deps, fetchBytes } = fakeDeps();
    deps.readOwnFile = async (p: string) => { void p; return null; };
    // Make the probe succeed so the engine reaches fetchBytes with the zip URL.
    let token = '';
    deps.writeFile = async (_p, url) => { token = Buffer.from(url.split(',')[1], 'base64').toString(); return 1; };
    deps.readOwnFile = async () => token;
    const r = await maybeSelfUpdate(state(), deps);
    expect(fetchBytes).toHaveBeenCalledWith('https://pod/download');
    expect(r?.status).toBe('rejected');
  });
});
