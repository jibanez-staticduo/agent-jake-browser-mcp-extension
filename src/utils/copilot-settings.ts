import { COPILOT_SETTINGS_KEY, DEFAULT_COPILOT_SETTINGS, type CopilotSettings } from '@/types/copilot';
import { CONFIG } from '@/types/config';

export type CopilotPreference = Partial<Pick<CopilotSettings, 'model' | 'mode'>>;
export type Provisioned = Pick<CopilotSettings, 'baseUrl' | 'apiKey'>;
export const COPILOT_CREDENTIAL_FIELDS = [
  ['baseUrl', 'apiKey', 'apiKeyUrl'],
  ['mcpUrl', 'mcpToken', 'mcpTokenUrl'],
] as const;

export function buildProvision(): Provisioned {
  return { baseUrl: CONFIG.COPILOT_BASE_URL.trim(), apiKey: CONFIG.COPILOT_API_KEY.trim() };
}

/** Keep credentials with a matching endpoint binding or a pair supplied by this build. */
export function normalizeCopilotSettings(input?: Partial<CopilotSettings>, build = buildProvision()): CopilotSettings {
  const settings = { ...DEFAULT_COPILOT_SETTINGS, ...input };
  // Legacy provisioning updated endpoint and key independently. Only a complete build pair can restore a missing binding.
  if (!settings.apiKeyUrl && build.baseUrl && build.apiKey && settings.baseUrl === build.baseUrl && settings.apiKey === build.apiKey) {
    settings.apiKeyUrl = build.baseUrl;
  }
  if ((settings.apiKey || settings.apiKeyUrl) && (!settings.apiKeyUrl || settings.apiKeyUrl !== settings.baseUrl)) {
    settings.apiKey = '';
    delete settings.apiKeyUrl;
  }
  if (!settings.mcpUrl || settings.mcpTokenUrl !== settings.mcpUrl || typeof settings.mcpToken !== 'string') {
    settings.mcpToken = '';
    settings.mcpTokenUrl = '';
  }
  return settings;
}

/** Hex SHA-256 of a seeded value; copilotProvisioned holds these, never the values. */
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function matchesProvisionedHash(value?: string, hash?: string): Promise<boolean> {
  return Boolean(value && hash && await sha256(value) === hash);
}

export async function readCopilotSettings(): Promise<CopilotSettings> {
  const raw = await chrome.storage.local.get(COPILOT_SETTINGS_KEY);
  return normalizeCopilotSettings(raw[COPILOT_SETTINGS_KEY] as Partial<CopilotSettings> | undefined);
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
