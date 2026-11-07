import { afterEach, describe, expect, it, vi } from 'vitest';
import { COPILOT_SETTINGS_KEY, DEFAULT_COPILOT_SETTINGS } from '@/types/copilot';
import { normalizeCopilotSettings, saveCopilotSettings } from '@/utils/copilot-settings';

afterEach(() => vi.unstubAllGlobals());

const a = 'https://a.test/mcp';
const b = 'https://b.test/mcp';
const saved = { ...DEFAULT_COPILOT_SETTINGS, mcpUrl: a, mcpTokenUrl: a, mcpToken: 'secret-a' };

describe('endpoint-bound MCP credentials', () => {
  it('preserves credentials for the exact same endpoint', () => {
    expect(normalizeCopilotSettings(saved)).toEqual(saved);
  });

  it.each([b, `${a}/`, `${a}?x=1`, 'https://A.test/mcp', ''])('drops credentials when the URL changes to %s', async (mcpUrl) => {
    const set = vi.fn(async () => undefined);
    vi.stubGlobal('chrome', { storage: { local: { set } } });
    const result = await saveCopilotSettings({ ...saved, mcpUrl });
    expect(result.mcpToken).toBe('');
    expect(result.mcpTokenUrl).toBe('');
    expect(set).toHaveBeenCalledWith({ [COPILOT_SETTINGS_KEY]: result });
  });

  it('allows a newly entered token bound to endpoint B', async () => {
    vi.stubGlobal('chrome', { storage: { local: { set: vi.fn(async () => undefined) } } });
    const result = await saveCopilotSettings({ ...saved, mcpUrl: b, mcpTokenUrl: b, mcpToken: 'secret-b' });
    expect(result).toMatchObject({ mcpUrl: b, mcpToken: 'secret-b', mcpTokenUrl: b });
  });

  it('never adopts legacy credentials without an explicit URL binding', () => {
    expect(normalizeCopilotSettings({ mcpUrl: a, mcpToken: 'legacy' }).mcpToken).toBe('');
  });
});
