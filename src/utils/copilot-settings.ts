import { COPILOT_SETTINGS_KEY, DEFAULT_COPILOT_SETTINGS, type CopilotSettings } from '@/types/copilot';

/** Fail closed for stale or unbound credentials, including settings written by older callers. */
export function normalizeCopilotSettings(input?: Partial<CopilotSettings>): CopilotSettings {
  const settings = { ...DEFAULT_COPILOT_SETTINGS, ...input };
  if (!settings.mcpUrl || settings.mcpTokenUrl !== settings.mcpUrl || typeof settings.mcpToken !== 'string') {
    settings.mcpToken = '';
    settings.mcpTokenUrl = '';
  }
  return settings;
}

export async function saveCopilotSettings(input: CopilotSettings): Promise<CopilotSettings> {
  const settings = normalizeCopilotSettings(input);
  await chrome.storage.local.set({ [COPILOT_SETTINGS_KEY]: settings });
  return settings;
}
