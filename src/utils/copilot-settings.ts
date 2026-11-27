import { DEFAULT_COPILOT_SETTINGS, type CopilotSettings } from '@/types/copilot';

export type CopilotPreference = Partial<Pick<CopilotSettings, 'model' | 'mode'>>;
export const COPILOT_CREDENTIAL_FIELDS = [
  ['baseUrl', 'apiKey', 'apiKeyUrl'],
  ['mcpUrl', 'mcpToken', 'mcpTokenUrl'],
] as const;

/** Fail closed for stale or unbound credentials, including settings written by older callers. */
export function normalizeCopilotSettings(input?: Partial<CopilotSettings>): CopilotSettings {
  const settings = { ...DEFAULT_COPILOT_SETTINGS, ...input };
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
