import { describe, expect, it, vi } from 'vitest';
import { checkForUpdate, latestUrlFor, UPDATE_STATE_KEY, type UpdateCheckDeps } from '@/background/update-check';

const POD = { secure: true, hostname: 'browser-mcp.lan.e-dani.com', port: 443, path: '/ws' };
const LATEST = { version: '2.4.0.125', build: 125, sha: 'abc1234', publishedAt: '2026-10-03T10:00:00Z', download: '/download' };

function deps(over: Partial<UpdateCheckDeps> = {}) {
  const store = new Map<string, unknown>();
  const d: UpdateCheckDeps & { store: Map<string, unknown>; badge: string[]; notified: number } = {
    store,
    badge: [],
    notified: 0,
    fetchJson: vi.fn(async () => LATEST),
    current: { version: '2.4.0.118', build: 118, sha: '1e729af' },
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => { store.set(k, v); },
      remove: async (k) => { store.delete(k); },
    },
    setBadge: async (t) => { d.badge.push(t); },
    notify: async () => { d.notified++; },
    now: () => new Date('2026-10-03T10:30:00Z'),
    ...over,
  };
  return d;
}

describe('latestUrlFor', () => {
  it('reads latest.json from the server the extension talks to', () => {
    expect(latestUrlFor(POD, '')).toBe('https://browser-mcp.lan.e-dani.com/download/latest.json');
    expect(latestUrlFor({ secure: false, hostname: 'srv.lan', port: 8000, path: '' }, '')).toBe('http://srv.lan:8000/download/latest.json');
  });

  it('does not check a local server unless the build points it somewhere', () => {
    const local = { secure: false, hostname: '127.0.0.1', port: 8765, path: '' };
    expect(latestUrlFor(local, '')).toBeNull();
    expect(latestUrlFor(local, 'https://central/download/latest.json')).toBe('https://central/download/latest.json');
  });
});

describe('checkForUpdate', () => {
  it('flags a newer build: NEW badge, state for the popup and a single notification per build', async () => {
    const d = deps();
    const url = latestUrlFor(POD, '');
    const state = await checkForUpdate(url, d);
    expect(state?.available).toBe(true);
    expect(state?.downloadUrl).toBe('https://browser-mcp.lan.e-dani.com/download');
    expect(d.store.get(UPDATE_STATE_KEY)).toMatchObject({ available: true, latest: { build: 125 } });
    expect(d.badge.at(-1)).toBe('NEW');
    expect(d.notified).toBe(1);

    await checkForUpdate(url, d); // 30 minutes later, same build
    expect(d.notified).toBe(1);
  });

  it('clears everything once this browser is on the published build', async () => {
    const d = deps({ current: { version: '2.4.0.125', build: 125, sha: 'abc1234' } });
    d.store.set(UPDATE_STATE_KEY, { available: true });
    const state = await checkForUpdate(latestUrlFor(POD, ''), d);
    expect(state?.available).toBe(false);
    expect(d.store.has(UPDATE_STATE_KEY)).toBe(false);
    expect(d.badge.at(-1)).toBe('');
    expect(d.notified).toBe(0);
  });

  it('stays quiet when it cannot know: no server URL, unknown own build, unreachable or garbage', async () => {
    expect(await checkForUpdate(null, deps())).toBeNull();
    expect(await checkForUpdate('https://x/download/latest.json', deps({ current: { version: '2.4.0', build: 0, sha: '' } }))).toBeNull();
    const offline = deps({ fetchJson: vi.fn(async () => { throw new Error('offline'); }) });
    expect(await checkForUpdate('https://x/download/latest.json', offline)).toBeNull();
    expect(offline.badge).toEqual([]);
    expect(await checkForUpdate('https://x/download/latest.json', deps({ fetchJson: vi.fn(async () => ({ build: 'x' })) }))).toBeNull();
  });
});
