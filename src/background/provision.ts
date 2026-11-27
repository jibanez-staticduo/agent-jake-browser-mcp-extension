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
import { COPILOT_PROVISIONED_KEY, COPILOT_SETTINGS_KEY } from '@/types/copilot';
import {
  copilotStorageSnapshot, matchesProvisionedHash, resolveStoredCopilotSettings, sha256, type Provisioned,
} from '@/utils/copilot-settings';

export interface ProvisionStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

export function buildProvision(): Provisioned {
  return { baseUrl: CONFIG.COPILOT_BASE_URL.trim(), apiKey: CONFIG.COPILOT_API_KEY.trim() };
}

/** Returns true when it wrote something. */
export async function provisionCopilot(build: Provisioned, storage: ProvisionStorage): Promise<boolean> {
  const { stored, provisioned: last } = copilotStorageSnapshot(await storage.get([
    COPILOT_SETTINGS_KEY, COPILOT_PROVISIONED_KEY,
  ]));
  const settings = await resolveStoredCopilotSettings(stored, last);
  const provisioned: Partial<Provisioned> = { ...last };
  if (build.baseUrl) {
    const seededEndpoint = await matchesProvisionedHash(settings.baseUrl, last.baseUrl);
    const previousSeed = seededEndpoint && await matchesProvisionedHash(settings.apiKey, last.apiKey);
    const buildKey = settings.baseUrl === build.baseUrl && Boolean(build.apiKey && settings.apiKey === build.apiKey);
    const managedKey = previousSeed || buildKey;
    if ((!settings.apiKey || (managedKey && build.apiKey)) && (!settings.baseUrl || seededEndpoint)) {
      settings.baseUrl = build.baseUrl;
      provisioned.baseUrl = await sha256(build.baseUrl);
    }
    if (settings.baseUrl === build.baseUrl && build.apiKey && (!settings.apiKey || managedKey)) {
      settings.apiKey = build.apiKey;
      settings.apiKeyUrl = build.baseUrl;
      provisioned.apiKey = await sha256(build.apiKey);
    }
  }
  const values: Record<string, unknown> = {};
  if (settings.baseUrl !== (stored.baseUrl ?? '') || settings.apiKey !== (stored.apiKey ?? '')
    || settings.apiKeyUrl !== stored.apiKeyUrl) values[COPILOT_SETTINGS_KEY] = settings;
  if (provisioned.baseUrl !== last.baseUrl || provisioned.apiKey !== last.apiKey) values[COPILOT_PROVISIONED_KEY] = provisioned;
  if (!Object.keys(values).length) return false;
  await storage.set(values);
  return true;
}

export function chromeProvisionStorage(): ProvisionStorage {
  return {
    get: (keys) => chrome.storage.local.get(keys),
    set: (values) => chrome.storage.local.set(values),
  };
}
