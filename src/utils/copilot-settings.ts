import { COPILOT_PROVISIONED_KEY, COPILOT_SETTINGS_KEY, DEFAULT_COPILOT_SETTINGS, type CopilotSettings } from '@/types/copilot';
import { CONFIG } from '@/types/config';

export type CopilotPreference = Partial<Pick<CopilotSettings, 'model' | 'mode'>>;
export const COPILOT_CREDENTIAL_FIELDS = [
  ['baseUrl', 'apiKey', 'apiKeyUrl'],
  ['mcpUrl', 'mcpToken', 'mcpTokenUrl'],
] as const;

/** Remove credentials whose endpoint binding is stale. */
export function normalizeCopilotSettings(input?: Partial<CopilotSettings>): CopilotSettings {
  const settings = { ...DEFAULT_COPILOT_SETTINGS, ...input };
  const buildKey = CONFIG.COPILOT_API_KEY.trim();
  const buildUrl = CONFIG.COPILOT_BASE_URL.trim();
  if (!settings.apiKeyUrl && buildKey && settings.apiKey === buildKey) {
    if (!buildUrl || buildUrl !== settings.baseUrl) {
      settings.apiKey = '';
      delete settings.apiKeyUrl;
    } else {
      settings.apiKeyUrl = buildUrl;
    }
  }
  if (settings.apiKeyUrl && settings.apiKeyUrl !== settings.baseUrl) {
    settings.apiKey = '';
    delete settings.apiKeyUrl;
  }
  if (!settings.mcpUrl || settings.mcpTokenUrl !== settings.mcpUrl || typeof settings.mcpToken !== 'string') {
    settings.mcpToken = '';
    settings.mcpTokenUrl = '';
  }
  return settings;
}

export type Provisioned = Pick<CopilotSettings, 'baseUrl' | 'apiKey'>;

/** Hex SHA-256 of a seeded value; copilotProvisioned holds these, never the values. */
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function matchesProvisionedHash(value?: string, hash?: string): Promise<boolean> {
  return Boolean(value && hash && await sha256(value) === hash);
}

export async function resolveStoredCopilotSettings(
  stored: Partial<CopilotSettings>,
  provisioned: Partial<Provisioned>,
): Promise<CopilotSettings> {
  if (!stored.apiKeyUrl && await matchesProvisionedHash(stored.apiKey, provisioned.apiKey)) {
    if (await matchesProvisionedHash(stored.baseUrl, provisioned.baseUrl)) {
      return normalizeCopilotSettings({ ...stored, apiKeyUrl: stored.baseUrl });
    }
    const safe = { ...stored, apiKey: '' };
    delete safe.apiKeyUrl;
    return normalizeCopilotSettings(safe);
  }
  return normalizeCopilotSettings(stored);
}

export function copilotStorageSnapshot(raw: Record<string, unknown>) {
  return {
    stored: (raw[COPILOT_SETTINGS_KEY] ?? {}) as Partial<CopilotSettings>,
    provisioned: (raw[COPILOT_PROVISIONED_KEY] ?? {}) as Partial<Provisioned>,
  };
}

export async function readCopilotSettings(): Promise<CopilotSettings> {
  const { stored, provisioned } = copilotStorageSnapshot(await chrome.storage.local.get([
    COPILOT_SETTINGS_KEY, COPILOT_PROVISIONED_KEY,
  ]));
  return resolveStoredCopilotSettings(stored, provisioned);
}

async function save(changes: Partial<CopilotSettings>): Promise<CopilotSettings> {
  const result = await chrome.runtime.sendMessage({ action: 'saveCopilotSettings', payload: changes }) as
    { success: true; settings: CopilotSettings } | { success: false; error: string } | undefined;
  if (!result?.success) throw new Error(result?.error ?? 'No se pudieron guardar las opciones del copiloto.');
  return result.settings;
}

export function saveCopilotSettings(input: CopilotSettings, baseline?: CopilotSettings): Promise<CopilotSettings> {
  if (!baseline) return save(input);
  const changed = new Set((Object.keys(input) as (keyof CopilotSettings)[]).filter((key) => input[key] !== baseline[key]));
  for (const group of COPILOT_CREDENTIAL_FIELDS) {
    if (group.some((key) => changed.has(key))) group.forEach((key) => changed.add(key));
  }
  return save(Object.fromEntries([...changed].map((key) => [key, input[key] ?? ''])));
}

export function saveCopilotPreference(patch: CopilotPreference): Promise<CopilotSettings> {
  return save(patch);
}
