import { afterEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '@/config/runtime';
import { COPILOT_SETTINGS_KEY, DEFAULT_COPILOT_SETTINGS } from '@/types/copilot';
import {
  CopilotSettingsConflict,
  normalizeCopilotSettings,
  readCopilotSettingsSnapshot,
  rebaseCopilotDraft,
  saveCopilotSettings,
  saveCopilotPreference,
} from '@/utils/copilot-settings';

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
    await saveCopilotSettings({ ...saved, mcpToken: 'replacement' }, { settings: saved, serverRevision: null });
    expect(sendMessage).toHaveBeenCalledWith({
      action: 'saveCopilotSettings',
      payload: { mcpUrl: a, mcpToken: 'replacement', mcpTokenUrl: a, expectedServerRevision: null },
    });
    await saveCopilotPreference({ model: 'new-model' });
    expect(sendMessage).toHaveBeenLastCalledWith({ action: 'saveCopilotSettings', payload: { model: 'new-model' } });
  });
});

describe('Copilot settings snapshots', () => {
  it.each(['destination-a', undefined])('reads settings with the stored server revision %s', async (revision) => {
    const get = vi.fn(async () => ({
      [COPILOT_SETTINGS_KEY]: saved,
      [STORAGE_KEYS.serverRevision]: revision,
    }));
    vi.stubGlobal('chrome', { storage: { local: { get } } });

    await expect(readCopilotSettingsSnapshot()).resolves.toEqual({ settings: saved, serverRevision: revision ?? null });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith([COPILOT_SETTINGS_KEY, STORAGE_KEYS.serverRevision]);
  });

  it('sends the original revision for a credential edit after repeated destination refreshes', async () => {
    const original = { settings: saved, serverRevision: 'destination-a' };
    const latest = {
      settings: { ...saved, mcpUrl: b, mcpTokenUrl: b, mcpToken: 'token-b', model: 'model-b' },
      serverRevision: 'destination-b',
    };
    const input = { ...saved, mcpToken: 'replacement' };
    const first = rebaseCopilotDraft(input, original, latest);
    const second = rebaseCopilotDraft(first.draft, first.baseline, {
      ...latest, settings: { ...latest.settings, maxSteps: 45 },
    });
    expect(second.draft).toMatchObject({ mcpUrl: a, mcpToken: 'replacement', model: 'model-b', maxSteps: 45 });

    const sendMessage = vi.fn(async () => ({ success: false, conflict: true, error: 'Destination changed' }));
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    await expect(saveCopilotSettings(second.draft, second.baseline)).rejects.toThrow(CopilotSettingsConflict);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      action: 'saveCopilotSettings',
      payload: { mcpUrl: a, mcpToken: 'replacement', mcpTokenUrl: a, expectedServerRevision: 'destination-a' },
    });
  });

  it('adopts the current revision for a draft with only preference edits', async () => {
    const latest = {
      settings: { ...saved, mcpUrl: b, mcpTokenUrl: b, mcpToken: 'token-b' },
      serverRevision: 'destination-b',
    };
    const { draft, baseline } = rebaseCopilotDraft(
      { ...saved, model: 'edited-model' },
      { settings: saved, serverRevision: 'destination-a' },
      latest,
    );
    expect(baseline).toEqual(latest);
    expect(draft).toEqual({ ...latest.settings, model: 'edited-model' });

    const sendMessage = vi.fn(async () => ({ success: true, settings: draft }));
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    await saveCopilotSettings(draft, baseline);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      action: 'saveCopilotSettings', payload: { model: 'edited-model' },
    });
  });
});
