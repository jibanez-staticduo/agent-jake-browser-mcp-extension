/**
 * Tells the user of this browser when a newer build of the extension has been published.
 *
 * The extension CI publishes /download/latest.json on the MCP server after every merge to main
 * (agent-browser-server published-extension). Every installed extension reads it when the
 * browser starts and every 30 minutes; when its `build` is ahead of the one baked into this
 * bundle, the action icon shows NEW, the popup a banner, and Chrome one notification per build.
 * Browsers the CI updates by itself (x86, Mac) are already on it by the time it is published.
 */
import { CONFIG } from '@/types/config';
import type { ParsedServerUrl } from '@/config/runtime';

export const UPDATE_ALARM = 'ajb-update-check';
export const UPDATE_PERIOD_MINUTES = 30;
export const UPDATE_STATE_KEY = 'ajb.update';
const NOTIFIED_KEY = 'ajb.updateNotifiedBuild';
export const UPDATE_NOTIFICATION_ID = 'ajb-update';

export interface PublishedBuild {
  version: string;
  build: number;
  sha: string;
  publishedAt: string;
}

export interface UpdateState {
  available: boolean;
  latest?: PublishedBuild;
  current: { version: string; build: number; sha: string };
  downloadUrl?: string;
  checkedAt: string;
}

const isLoopback = (host: string) => host === '127.0.0.1' || host === 'localhost' || host === '::1';

/**
 * Where this install reads the published build: the build-time override, else its own server
 * over https/http (the pod serves /download/latest.json next to /ws). A local server publishes
 * nothing, so loopback without an override means "do not check".
 */
export function latestUrlFor(server: ParsedServerUrl, override = CONFIG.LATEST_URL): string | null {
  if (override) return override;
  if (isLoopback(server.hostname)) return null;
  const scheme = server.secure ? 'https' : 'http';
  const defaultPort = server.secure ? 443 : 80;
  const port = server.port && server.port !== defaultPort ? `:${server.port}` : '';
  return `${scheme}://${server.hostname}${port}/download/latest.json`;
}

export function parsePublished(raw: unknown): PublishedBuild | null {
  const r = raw as Partial<PublishedBuild> | null;
  if (!r || typeof r.version !== 'string' || typeof r.build !== 'number' || !Number.isInteger(r.build)) return null;
  return { version: r.version, build: r.build, sha: String(r.sha ?? ''), publishedAt: String(r.publishedAt ?? '') };
}

export interface UpdateCheckDeps {
  fetchJson(url: string): Promise<unknown>;
  current: { version: string; build: number; sha: string };
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; remove(key: string): Promise<void> };
  setBadge(text: string): Promise<void>;
  notify(state: UpdateState): Promise<void>;
  now(): Date;
}

/** One check. Never throws: a server without a publication, or offline, just leaves things as they are. */
export async function checkForUpdate(latestUrl: string | null, deps: UpdateCheckDeps): Promise<UpdateState | null> {
  if (!latestUrl || deps.current.build <= 0) return null;
  let latest: PublishedBuild | null;
  try {
    latest = parsePublished(await deps.fetchJson(latestUrl));
  } catch {
    return null;
  }
  if (!latest) return null;
  const state: UpdateState = {
    available: latest.build > deps.current.build,
    latest,
    current: deps.current,
    downloadUrl: new URL('/download', latestUrl).toString(),
    checkedAt: deps.now().toISOString(),
  };
  if (!state.available) {
    await deps.storage.remove(UPDATE_STATE_KEY);
    await deps.setBadge('');
    return state;
  }
  await deps.storage.set(UPDATE_STATE_KEY, state);
  await deps.setBadge('NEW');
  if ((await deps.storage.get(NOTIFIED_KEY)) !== latest.build) {
    await deps.notify(state);
    await deps.storage.set(NOTIFIED_KEY, latest.build);
  }
  return state;
}

/** The real Chrome wiring for checkForUpdate. */
export function chromeUpdateDeps(): UpdateCheckDeps {
  return {
    async fetchJson(url) {
      const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    current: { version: chrome.runtime.getManifest().version, build: CONFIG.BUILD_NUMBER, sha: CONFIG.BUILD_SHA },
    storage: {
      get: async (key) => (await chrome.storage.local.get(key))[key],
      set: (key, value) => chrome.storage.local.set({ [key]: value }),
      remove: (key) => chrome.storage.local.remove(key),
    },
    async setBadge(text) {
      await chrome.action.setBadgeText({ text });
      if (text) await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
    },
    async notify(state) {
      await chrome.notifications.create(UPDATE_NOTIFICATION_ID, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'Agent Jake: hay una versión nueva',
        message: `Versión ${state.latest!.version} publicada; este navegador tiene la ${state.current.version}.`,
        contextMessage: 'Pulsa para descargarla',
        priority: 1,
      });
    },
    now: () => new Date(),
  };
}
