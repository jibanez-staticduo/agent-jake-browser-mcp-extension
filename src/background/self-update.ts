/**
 * Self-update: an unpacked install living in <Downloads>/agent-jake-browser rewrites itself with
 * chrome.downloads from the signed package the CI publishes, then reloads. Spike 2026-10-05:
 * needs "Ask where to save" off (saveAs:false does not override it) and Developer mode on.
 */
import { unzipSync } from 'fflate';
import { CONFIG } from '@/types/config';
import { UPDATE_PUBLIC_KEY } from '@/config/update-key';
import { activityLog } from './activity-log';
import type { PublishedBuild, UpdateState } from './update-check';
import { FILES_NAME, INSTALL_DIR, SIG_NAME, mimeFor, parseUpdateFiles, sha256Hex, toDataUrl, verifySignature, writeOrder, type UpdateFiles } from './update-package';

export type SelfUpdateProblem = 'not-in-downloads' | 'download-prompt' | 'bad-package' | 'write-failed';
export type SelfUpdateStatus = 'applied' | 'up-to-date' | 'locked' | 'busy' | 'not-eligible' | 'rejected' | 'failed';
export interface SelfUpdateResult { status: SelfUpdateStatus; reason?: string }
export class DownloadStalledError extends Error {}
export interface SelfUpdateDeps {
  currentBuild: number;
  publicKey: string;
  fetchBytes(url: string): Promise<Uint8Array>;
  unzip(bytes: Uint8Array): Record<string, Uint8Array>;
  /** Writes INSTALL_DIR/<path>; resolves the download id once complete with that exact name.
   *  Rejects with DownloadStalledError if still in progress after 15 s (it cancels it first). */
  writeFile(path: string, dataUrl: string): Promise<number>;
  removeFile(id: number): Promise<void>;
  erase(id: number): Promise<void>;
  setDownloadUi(enabled: boolean): Promise<void>;
  readOwnFile(path: string): Promise<string | null>;
  lastToolActivityAt(): Promise<number | null>;
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; remove(key: string): Promise<void> };
  reload(): void;
  notify(problem: SelfUpdateProblem, build: number): Promise<void>;
  now(): number;
  randomId(): string;
}

export const LOCK_KEY = 'ajb.selfUpdate.lock';
export const FILES_KEY = 'ajb.selfUpdate.files';
export const PENDING_KEY = 'ajb.selfUpdate.pendingCleanup';
export const NOTIFIED_KEY = 'ajb.selfUpdate.notified';
const LOCK_MS = 10 * 60_000;
const IDLE_MS = 5 * 60_000;
const STALL_MS = 15_000;

type FileMap = Record<string, number>;
interface Pending { build: number; previous: FileMap; written: FileMap }

async function warnOnce(deps: SelfUpdateDeps, problem: SelfUpdateProblem, build: number) {
  const mark = `${problem}:${build}`;
  if ((await deps.storage.get(NOTIFIED_KEY)) === mark) return;
  await deps.notify(problem, build);
  await deps.storage.set(NOTIFIED_KEY, mark);
}

async function probe(deps: SelfUpdateDeps): Promise<'ok' | SelfUpdateProblem> {
  const name = `agent-jake-probe-${deps.randomId()}.txt`;
  const token = `probe-${deps.randomId()}`;
  let id: number | undefined;
  try {
    id = await deps.writeFile(name, toDataUrl(new TextEncoder().encode(token), 'text/plain'));
    return (await deps.readOwnFile(name)) === token ? 'ok' : 'not-in-downloads';
  } catch (e) {
    return e instanceof DownloadStalledError ? 'download-prompt' : 'not-in-downloads';
  } finally {
    if (id !== undefined) { await deps.removeFile(id).catch(() => {}); await deps.erase(id).catch(() => {}); }
  }
}

async function verifiedPackage(zip: Record<string, Uint8Array>, latest: PublishedBuild, deps: SelfUpdateDeps): Promise<UpdateFiles | null> {
  const body = zip[FILES_NAME]; const sig = zip[SIG_NAME];
  if (!body || !sig) return null;
  if (!await verifySignature(body, new TextDecoder().decode(sig), deps.publicKey)) return null;
  let files: UpdateFiles | null;
  try { files = parseUpdateFiles(JSON.parse(new TextDecoder().decode(body))); } catch { return null; }
  if (!files || files.build !== latest.build || files.build <= deps.currentBuild) return null;
  for (const f of files.files) {
    const bytes = zip[f.path];
    if (!bytes || bytes.length !== f.size || await sha256Hex(bytes) !== f.sha256) return null;
  }
  return files;
}

export async function applyUpdate(latest: PublishedBuild, zipUrl: string, deps: SelfUpdateDeps): Promise<SelfUpdateResult> {
  if (latest.build <= deps.currentBuild) return { status: 'up-to-date' };
  const held = await deps.storage.get(LOCK_KEY);
  if (typeof held === 'number' && deps.now() - held < LOCK_MS) return { status: 'locked' };
  await deps.storage.set(LOCK_KEY, deps.now());
  try {
    const last = await deps.lastToolActivityAt();
    if (last !== null && deps.now() - last < IDLE_MS) return { status: 'busy' };

    const eligible = await probe(deps);
    if (eligible !== 'ok') { await warnOnce(deps, eligible, latest.build); return { status: 'not-eligible', reason: eligible }; }

    let files: UpdateFiles | null = null; let zip: Record<string, Uint8Array> = {};
    try { zip = deps.unzip(await deps.fetchBytes(zipUrl)); files = await verifiedPackage(zip, latest, deps); } catch { files = null; }
    if (!files) { await warnOnce(deps, 'bad-package', latest.build); return { status: 'rejected' }; }

    const previous = ((await deps.storage.get(FILES_KEY)) as FileMap | undefined) ?? {};
    const written: FileMap = {};
    await deps.setDownloadUi(false);
    try {
      for (const f of writeOrder(files.files)) written[f.path] = await deps.writeFile(f.path, toDataUrl(zip[f.path], mimeFor(f.path)!));
    } catch (e) {
      await warnOnce(deps, 'write-failed', latest.build);
      return { status: 'failed', reason: String((e as Error)?.message ?? e) };
    } finally {
      await deps.setDownloadUi(true);
    }
    const pending: Pending = { build: files.build, previous, written };
    await deps.storage.set(PENDING_KEY, pending);
    await deps.storage.set(FILES_KEY, written);
    await deps.storage.remove(LOCK_KEY);
    deps.reload();
    return { status: 'applied' };
  } finally {
    await deps.storage.remove(LOCK_KEY);
  }
}

export async function cleanupAfterUpdate(deps: SelfUpdateDeps): Promise<void> {
  const pending = (await deps.storage.get(PENDING_KEY)) as Pending | undefined;
  if (!pending || pending.build !== deps.currentBuild) return;
  for (const [path, id] of Object.entries(pending.previous)) {
    if (!(path in pending.written)) await deps.removeFile(id).catch(() => {});
    await deps.erase(id).catch(() => {});
  }
  await deps.storage.remove(PENDING_KEY);
}

export async function maybeSelfUpdate(state: UpdateState | null, deps: SelfUpdateDeps = chromeSelfUpdateDeps()): Promise<SelfUpdateResult | null> {
  if (!state?.available || !state.latest || !state.downloadUrl) return null;
  return applyUpdate(state.latest, state.downloadUrl, deps);
}

const NOTICE_TEXT: Record<SelfUpdateProblem, string> = {
  'not-in-downloads': 'Agent Jake no puede actualizarse sola: instálala desde Descargas/agent-jake-browser',
  'download-prompt': 'Agent Jake no puede actualizarse sola: desactiva "Preguntar dónde guardar cada archivo" en los ajustes de Chrome',
  'bad-package': 'Actualización de Agent Jake rechazada: paquete o firma no válidos',
  'write-failed': 'La actualización de Agent Jake falló a mitad; se reintenta en 30 min',
};

/** Resolves with the finished download id; throws if interrupted, renamed, or stalled past STALL_MS. */
function waitForDownload(id: number, path: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      fn();
    };
    const check = async () => {
      const [item] = await chrome.downloads.search({ id });
      if (!item) return;
      if (item.state === 'complete') {
        if (item.filename.replace(/\\/g, '/').endsWith(`/${INSTALL_DIR}/${path}`)) finish(() => resolve(id));
        else finish(() => reject(new Error('renamed: ' + item.filename.split(/[\\/]/).pop())));
      } else if (item.state === 'interrupted') {
        finish(() => reject(new Error(`download interrupted: ${path} (${item.error ?? 'unknown'})`)));
      }
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id === id && (delta.state || delta.error)) void check().catch((e) => finish(() => reject(e)));
    };
    const timer = setTimeout(() => {
      void chrome.downloads.cancel(id).catch(() => {});
      finish(() => reject(new DownloadStalledError(path)));
    }, STALL_MS);
    chrome.downloads.onChanged.addListener(onChanged);
    void check().catch((e) => finish(() => reject(e)));
  });
}

export function chromeSelfUpdateDeps(): SelfUpdateDeps {
  return {
    currentBuild: CONFIG.BUILD_NUMBER,
    publicKey: UPDATE_PUBLIC_KEY,
    unzip: unzipSync,
    async fetchBytes(url) {
      const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async writeFile(path, url) {
      const id = await chrome.downloads.download({ url, filename: `${INSTALL_DIR}/${path}`, conflictAction: 'overwrite', saveAs: false });
      return waitForDownload(id, path);
    },
    removeFile: (id) => chrome.downloads.removeFile(id),
    erase: async (id) => { await chrome.downloads.erase({ id }); },
    setDownloadUi: (enabled) => chrome.downloads.setUiOptions({ enabled }),
    async readOwnFile(path) {
      try {
        const res = await fetch(chrome.runtime.getURL(path), { cache: 'no-store' });
        return res.ok ? await res.text() : null;
      } catch {
        return null;
      }
    },
    async lastToolActivityAt() {
      // activityLog.getLatest returns newest first; scan for the most recent tool call.
      const { activities } = await activityLog.getLatest(100);
      return activities.find((a) => a.type === 'tool')?.timestamp ?? null;
    },
    storage: {
      get: async (key) => (await chrome.storage.local.get(key))[key],
      set: (key, value) => chrome.storage.local.set({ [key]: value }),
      remove: (key) => chrome.storage.local.remove(key),
    },
    reload: () => { setTimeout(() => chrome.runtime.reload(), 300); },
    async notify(problem, build) {
      await chrome.notifications.create('ajb-self-update-' + problem, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'Agent Jake',
        message: NOTICE_TEXT[problem],
        contextMessage: `Build ${build}`,
      });
    },
    now: Date.now,
    randomId: () => crypto.randomUUID().slice(0, 8),
  };
}
