import { COPILOT_SETTINGS_KEY, DEFAULT_COPILOT_SETTINGS, type CopilotSettings } from '@/types/copilot';
import { CONFIG } from '@/types/config';
import { STORAGE_KEYS } from '@/config/runtime';

export type CopilotPreference = Partial<Pick<CopilotSettings, 'model' | 'mode'>>;
export type Provisioned = Pick<CopilotSettings, 'baseUrl' | 'apiKey'>;
export const COPILOT_CREDENTIAL_FIELDS = [
  ['baseUrl', 'apiKey', 'apiKeyUrl'],
  ['mcpUrl', 'mcpToken', 'mcpTokenUrl'],
] as const;
type CopilotCredentialField = typeof COPILOT_CREDENTIAL_FIELDS[number][number];
type CopilotCredentialBaseline = Partial<Record<CopilotCredentialField, string>>;
export type CopilotSettingsPatch = Partial<CopilotSettings> & {
  expectedServerRevision?: string | null;
  expectedCredentials?: CopilotCredentialBaseline;
};

export interface CopilotSettingsSnapshot {
  settings: CopilotSettings;
  serverRevision: string | null;
}

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

export async function readCopilotSettingsSnapshot(): Promise<CopilotSettingsSnapshot> {
  const raw = await chrome.storage.local.get([COPILOT_SETTINGS_KEY, STORAGE_KEYS.serverRevision]);
  const revision = raw[STORAGE_KEYS.serverRevision];
  return {
    settings: normalizeCopilotSettings(raw[COPILOT_SETTINGS_KEY] as Partial<CopilotSettings> | undefined),
    serverRevision: typeof revision === 'string' ? revision : null,
  };
}

/** Refresh untouched fields while keeping edited credential groups bound to their original revision. */
export function rebaseCopilotDraft(draft: CopilotSettings, baseline: CopilotSettingsSnapshot, latest: CopilotSettingsSnapshot) {
  const nextDraft = { ...latest.settings };
  const nextBaseline = { ...latest.settings };
  let serverRevision = latest.serverRevision;
  const fields = Object.keys(draft) as (keyof CopilotSettings)[];
  const edits = fields.filter((key) => draft[key] !== baseline.settings[key]);
  Object.assign(nextDraft, Object.fromEntries(edits.map((key) => [key, draft[key]])));
  const revisionChanged = baseline.serverRevision !== latest.serverRevision;
  const groupsWithEdits = COPILOT_CREDENTIAL_FIELDS.filter((group) => group.some((key) => edits.includes(key)));
  // Both groups share one revision on save. Keep them together once the draft's destination changes.
  const credentialGroups = revisionChanged && groupsWithEdits.length ? COPILOT_CREDENTIAL_FIELDS : groupsWithEdits;
  for (const group of credentialGroups) {
    if (!revisionChanged && group.every((key) => draft[key] === latest.settings[key])) continue;
    serverRevision = baseline.serverRevision;
    Object.assign(nextDraft, Object.fromEntries(group.map((key) => [key, draft[key]])));
    Object.assign(nextBaseline, Object.fromEntries(group.map((key) => [key, baseline.settings[key]])));
  }
  return { draft: nextDraft, baseline: { settings: nextBaseline, serverRevision } };
}

export class CopilotSettingsConflict extends Error {}

async function save(changes: CopilotSettingsPatch): Promise<CopilotSettings> {
  const result = await chrome.runtime.sendMessage({ action: 'saveCopilotSettings', payload: changes }) as
    { success: true; settings: CopilotSettings } | { success: false; conflict?: boolean; error: string } | undefined;
  if (result?.success === false && result.conflict) throw new CopilotSettingsConflict(result.error);
  if (!result?.success) throw new Error(result?.error ?? 'No se pudieron guardar las opciones del copiloto.');
  return result.settings;
}

export function saveCopilotSettings(input: CopilotSettings, baseline: CopilotSettingsSnapshot): Promise<CopilotSettings> {
  const fields = Object.keys({ ...baseline.settings, ...input }) as (keyof CopilotSettings)[];
  const changed = new Set(fields.filter((key) => input[key] !== baseline.settings[key]));
  const expectedCredentials: CopilotCredentialBaseline = {};
  for (const group of COPILOT_CREDENTIAL_FIELDS) {
    if (!group.some((key) => changed.has(key))) continue;
    for (const key of group) {
      changed.add(key);
      expectedCredentials[key] = baseline.settings[key] ?? '';
    }
  }
  return save({
    ...Object.fromEntries([...changed].map((key) => [key, input[key] ?? ''])),
    ...(Object.keys(expectedCredentials).length ? { expectedServerRevision: baseline.serverRevision, expectedCredentials } : {}),
  });
}

export function saveCopilotPreference(patch: CopilotPreference): Promise<CopilotSettings> {
  return save(patch);
}
