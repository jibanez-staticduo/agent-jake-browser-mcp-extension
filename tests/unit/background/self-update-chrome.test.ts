import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadError, DownloadStalledError, waitForDownload } from '@/background/self-update';

type Item = { state: string; filename: string; error?: string };

function fakeChrome(item: Item | null) {
  const listeners = new Set<(d: { id: number; state?: unknown; error?: unknown }) => void>();
  const downloads = {
    search: vi.fn(async () => (item ? [item] : [])),
    cancel: vi.fn(async () => {}),
    removeFile: vi.fn(async () => {}),
    erase: vi.fn(async () => []),
    onChanged: { addListener: (l: never) => listeners.add(l), removeListener: (l: never) => listeners.delete(l) },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = { downloads };
  return { downloads, listeners, setItem: (i: Item) => { item = i; } };
}

const OK = '/Users/x/Downloads/agent-jake-browser/assets/a.js';

describe('waitForDownload (chrome layer)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); delete (globalThis as { chrome?: unknown }).chrome; });

  it('resolves the id when the download completes with the exact name', async () => {
    fakeChrome({ state: 'complete', filename: OK });
    await expect(waitForDownload(7, 'assets/a.js')).resolves.toBe(7);
  });

  it('sees a download that completed before the listener attached (initial search)', async () => {
    const c = fakeChrome({ state: 'complete', filename: OK });
    const p = waitForDownload(7, 'assets/a.js');
    expect(c.listeners.size).toBe(1);
    await expect(p).resolves.toBe(7);
    expect(c.listeners.size).toBe(0);
  });

  it('resolves via onChanged when the state flips to complete later', async () => {
    const c = fakeChrome({ state: 'in_progress', filename: OK });
    const p = waitForDownload(7, 'assets/a.js');
    await vi.advanceTimersByTimeAsync(10);
    c.setItem({ state: 'complete', filename: OK });
    for (const l of c.listeners) l({ id: 7, state: { current: 'complete' } });
    await expect(p).resolves.toBe(7);
  });

  it('interrupted USER_CANCELED becomes DownloadStalledError and the entry is discarded', async () => {
    const c = fakeChrome({ state: 'interrupted', filename: OK, error: 'USER_CANCELED' });
    const err = await waitForDownload(7, 'assets/a.js').catch((e) => e);
    expect(err).toBeInstanceOf(DownloadStalledError);
    expect(err.id).toBe(7);
    expect(c.downloads.removeFile).toHaveBeenCalledWith(7);
    expect(c.downloads.erase).toHaveBeenCalledWith({ id: 7 });
  });

  it('other interruptions are a plain DownloadError, not a stall, and are discarded', async () => {
    const c = fakeChrome({ state: 'interrupted', filename: OK, error: 'FILE_FAILED' });
    const err = await waitForDownload(7, 'assets/a.js').catch((e) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect(err).not.toBeInstanceOf(DownloadStalledError);
    expect(c.downloads.erase).toHaveBeenCalledWith({ id: 7 });
  });

  it('times out after 15 s: cancel + removeFile + erase + DownloadStalledError', async () => {
    const c = fakeChrome({ state: 'in_progress', filename: OK });
    const p = waitForDownload(7, 'assets/a.js').catch((e) => e);
    await vi.advanceTimersByTimeAsync(15_001);
    const err = await p;
    expect(err).toBeInstanceOf(DownloadStalledError);
    expect(c.downloads.cancel).toHaveBeenCalledWith(7);
    expect(c.downloads.removeFile).toHaveBeenCalledWith(7);
    expect(c.downloads.erase).toHaveBeenCalledWith({ id: 7 });
  });

  it('a renamed file ("a (1).js") is removed and rejects with a DownloadError carrying the id', async () => {
    const c = fakeChrome({ state: 'complete', filename: '/Users/x/Downloads/agent-jake-browser/assets/a (1).js' });
    const err = await waitForDownload(9, 'assets/a.js').catch((e) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect(err.id).toBe(9);
    expect(err.message).toContain('renamed');
    expect(c.downloads.removeFile).toHaveBeenCalledWith(9);
    expect(c.downloads.erase).toHaveBeenCalledWith({ id: 9 });
  });
});
