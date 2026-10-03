/**
 * Seeds the copilot endpoint and key into chrome.storage so a fresh install can send a prompt
 * without typing anything. The values come from the build (agent-browser-sync passes
 * VITE_COPILOT_BASE_URL / VITE_COPILOT_API_KEY from local host files; never from the repo).
 *
 * Rule: a field is overwritten when the stored value is empty or still equals what we seeded
 * last time (so a rotated key reaches the browser); a value the user changed in Opciones is
 * left alone. «What we seeded last time» is kept as SHA-256 hashes (copilotProvisioned), so the
 * key is not stored twice in clear. The model is not seeded here: DEFAULT_COPILOT_SETTINGS.model is the only default.
 */
import { CONFIG } from '@/types/config';
import {
  COPILOT_PROVISIONED_KEY,
  COPILOT_SETTINGS_KEY,
  DEFAULT_COPILOT_SETTINGS,
  type CopilotSettings,
} from '@/types/copilot';

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

const FIELDS = ['baseUrl', 'apiKey'] as const;

export function buildProvision(): Provisioned {
  return { baseUrl: CONFIG.COPILOT_BASE_URL.trim(), apiKey: CONFIG.COPILOT_API_KEY.trim() };
}

/** Returns true when it wrote something. */
export async function provisionCopilot(build: Provisioned, storage: ProvisionStorage): Promise<boolean> {
  if (!FIELDS.some((f) => build[f])) return false;
  const stored = ((await storage.get(COPILOT_SETTINGS_KEY)) ?? {}) as Partial<CopilotSettings>;
  const last = ((await storage.get(COPILOT_PROVISIONED_KEY)) ?? {}) as Partial<Provisioned>; // hashes
  const settings: Partial<CopilotSettings> = { ...stored };
  const provisioned: Partial<Provisioned> = { ...last };
  let changed = false;
  for (const f of FIELDS) {
    const wanted = build[f];
    if (!wanted) continue;
    const current = typeof stored[f] === 'string' ? stored[f] as string : '';
    const wantedHash = await sha256(wanted);
    if (current === '' || (await sha256(current)) === last[f]) {
      if (current !== wanted) { settings[f] = wanted; changed = true; }
      if (last[f] !== wantedHash) { provisioned[f] = wantedHash; changed = true; }
    }
  }
  if (!changed) return false;
  await storage.set(COPILOT_SETTINGS_KEY, { ...DEFAULT_COPILOT_SETTINGS, ...settings });
  await storage.set(COPILOT_PROVISIONED_KEY, provisioned);
  return true;
}

export function chromeProvisionStorage(): ProvisionStorage {
  return {
    get: async (key) => (await chrome.storage.local.get(key))[key],
    set: (key, value) => chrome.storage.local.set({ [key]: value }),
  };
}
