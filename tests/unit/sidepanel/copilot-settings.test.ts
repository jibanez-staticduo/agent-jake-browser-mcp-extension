import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COPILOT_SETTINGS } from '@/types/copilot';
import { normalizeCopilotSettings, saveCopilotSettings, saveCopilotPreference } from '@/utils/copilot-settings';

afterEach(() => vi.unstubAllGlobals());

const a = 'https://a.test/mcp';
const b = 'https://b.test/mcp';
const saved = { ...DEFAULT_COPILOT_SETTINGS, mcpUrl: a, mcpTokenUrl: a, mcpToken: 'secret-a' };

describe('endpoint-bound MCP credentials', () => {
  it('preserves credentials for the exact same endpoint', () => {
    expect(normalizeCopilotSettings(saved)).toEqual(saved);
  });

  it.each([b, `${a}/`, `${a}?x=1`, 'https://A.test/mcp', ''])('drops credentials when the URL changes to %s', (mcpUrl) => {
    const result = normalizeCopilotSettings({ ...saved, mcpUrl });
    expect(result.mcpToken).toBe('');
    expect(result.mcpTokenUrl).toBe('');
  });

  it('allows a newly entered token bound to endpoint B', () => {
    const result = normalizeCopilotSettings({ ...saved, mcpUrl: b, mcpTokenUrl: b, mcpToken: 'secret-b' });
    expect(result).toMatchObject({ mcpUrl: b, mcpToken: 'secret-b', mcpTokenUrl: b });
  });

  it('never adopts legacy credentials without an explicit URL binding', () => {
    expect(normalizeCopilotSettings({ mcpUrl: a, mcpToken: 'legacy' }).mcpToken).toBe('');
  });

  it('will not send an automatically issued LiteLLM key to another endpoint', () => {
    expect(normalizeCopilotSettings({ ...saved, baseUrl: b, apiKeyUrl: a, apiKey: 'litellm-key' }).apiKey).toBe('');
  });

  it('sends settings edits together with any affected credential bindings', async () => {
    const sendMessage = vi.fn(async () => ({ success: true, settings: saved }));
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    await saveCopilotSettings({ ...saved, mcpToken: 'replacement' }, saved);
    expect(sendMessage).toHaveBeenCalledWith({
      action: 'saveCopilotSettings', payload: { mcpUrl: a, mcpToken: 'replacement', mcpTokenUrl: a },
    });
    await saveCopilotPreference({ model: 'new-model' });
    expect(sendMessage).toHaveBeenLastCalledWith({ action: 'saveCopilotSettings', payload: { model: 'new-model' } });
  });
});
