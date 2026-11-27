/**
 * Seeds the copilot endpoint and key into chrome.storage so a fresh install can send a prompt
 * without typing anything. The values come from the build (only local/host builds, e.g. the
 * agent-browser-sync host build until it is retired, pass VITE_COPILOT_BASE_URL / VITE_COPILOT_API_KEY from
 * local host files; never from the repo). The published build (scripts/publicar.sh) is neutral and seeds nothing.
 *
 * A key is seeded or rotated only at its build endpoint. SHA-256 hashes in
 * copilotProvisioned identify earlier seeds without storing the key twice.
 */
import { CONFIG } from '@/types/config';
import {
  COPILOT_PROVISIONED_KEY,
  COPILOT_SETTINGS_KEY,
  DEFAULT_COPILOT_SETTINGS,
  type CopilotSettings,
} from '@/types/copilot';
import { normalizeCopilotSettings } from '@/utils/copilot-settings';

export type Provisioned = Pick<CopilotSettings, 'baseUrl' | 'apiKey'>;

/** Hex SHA-256 of a seeded value; copilotProvisioned holds these, never the values. */
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface ProvisionStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export function buildProvision(): Provisioned {
  return { baseUrl: CONFIG.COPILOT_BASE_URL.trim(), apiKey: CONFIG.COPILOT_API_KEY.trim() };
}

/** Returns true when it wrote something. */
export async function provisionCopilot(build: Provisioned, storage: ProvisionStorage): Promise<boolean> {
  if (!build.baseUrl) return false;
  const stored = ((await storage.get(COPILOT_SETTINGS_KEY)) ?? {}) as Partial<CopilotSettings>;
  const last = ((await storage.get(COPILOT_PROVISIONED_KEY)) ?? {}) as Partial<Provisioned>; // hashes
  const settings = { ...DEFAULT_COPILOT_SETTINGS, ...stored };
  const provisioned: Partial<Provisioned> = { ...last };
  const oldBaseUrl = settings.baseUrl;
  const previousSeed = Boolean(settings.apiKey && (await sha256(settings.apiKey)) === last.apiKey);
  const buildKey = Boolean(build.apiKey && settings.apiKey === build.apiKey);
  const managedKey = previousSeed || buildKey;
  if ((!settings.apiKey || managedKey) && (!oldBaseUrl || (await sha256(oldBaseUrl)) === last.baseUrl)) {
    settings.baseUrl = build.baseUrl;
    provisioned.baseUrl = await sha256(build.baseUrl);
  }
  if (settings.baseUrl === build.baseUrl && build.apiKey && (!settings.apiKey || managedKey)) {
    settings.apiKey = build.apiKey;
    settings.apiKeyUrl = build.baseUrl;
    provisioned.apiKey = await sha256(build.apiKey);
  } else if (managedKey) {
    // Older builds could seed an unbound key into a manual endpoint.
    settings.apiKey = '';
    delete settings.apiKeyUrl;
  }
  const normalized = normalizeCopilotSettings(settings);
  const changedSettings = normalized.baseUrl !== (stored.baseUrl ?? '') || normalized.apiKey !== (stored.apiKey ?? '')
    || normalized.apiKeyUrl !== stored.apiKeyUrl;
  const changedHashes = provisioned.baseUrl !== last.baseUrl || provisioned.apiKey !== last.apiKey;
  if (changedSettings) await storage.set(COPILOT_SETTINGS_KEY, normalized);
  if (changedHashes) await storage.set(COPILOT_PROVISIONED_KEY, provisioned);
  return changedSettings || changedHashes;
}

export function chromeProvisionStorage(): ProvisionStorage {
  return {
    get: async (key) => (await chrome.storage.local.get(key))[key],
    set: (key, value) => chrome.storage.local.set({ [key]: value }),
  };
}
