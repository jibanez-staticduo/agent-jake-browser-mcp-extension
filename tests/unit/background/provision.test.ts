import { describe, expect, it } from 'vitest';
import { provisionCopilot, sha256, type ProvisionStorage } from '@/background/provision';
import { COPILOT_PROVISIONED_KEY, COPILOT_SETTINGS_KEY, DEFAULT_COPILOT_SETTINGS } from '@/types/copilot';

const hashes = async (v: { baseUrl: string; apiKey: string }) => ({ baseUrl: await sha256(v.baseUrl), apiKey: await sha256(v.apiKey) });
const BUILD = { baseUrl: 'https://litellm.example/v1', apiKey: 'test-key-1' };

function mem(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  const storage: ProvisionStorage = {
    get: async (k) => store.get(k),
    set: async (k, v) => { store.set(k, v); },
  };
  return { store, storage };
}

describe('provisionCopilot', () => {
  it('uses qwen38-flash-next as the default model', () => {
    expect(DEFAULT_COPILOT_SETTINGS.model).toBe('qwen38-flash-next');
  });

  it('seeds an empty install', async () => {
    const { store, storage } = mem();
    expect(await provisionCopilot(BUILD, storage)).toBe(true);
    expect(store.get(COPILOT_SETTINGS_KEY)).toMatchObject({ ...BUILD, model: 'qwen38-flash-next' });
    expect(store.get(COPILOT_PROVISIONED_KEY)).toEqual(await hashes(BUILD));
    expect(JSON.stringify(store.get(COPILOT_PROVISIONED_KEY))).not.toContain(BUILD.apiKey);
  });

  it('does not overwrite what the user changed', async () => {
    const { store, storage } = mem({
      [COPILOT_SETTINGS_KEY]: { baseUrl: 'https://mine.example/v1', apiKey: 'mine' },
      [COPILOT_PROVISIONED_KEY]: await hashes({ baseUrl: 'https://old.example/v1', apiKey: 'old' }),
    });
    expect(await provisionCopilot(BUILD, storage)).toBe(false);
    expect(store.get(COPILOT_SETTINGS_KEY)).toEqual({ baseUrl: 'https://mine.example/v1', apiKey: 'mine' });
  });

  it('replaces a rotated key when the stored value is the last seeded one', async () => {
    const { store, storage } = mem({
      [COPILOT_SETTINGS_KEY]: { ...DEFAULT_COPILOT_SETTINGS, ...BUILD, maxSteps: 10 },
      [COPILOT_PROVISIONED_KEY]: await hashes(BUILD),
    });
    expect(await provisionCopilot({ ...BUILD, apiKey: 'test-key-2' }, storage)).toBe(true);
    expect(store.get(COPILOT_SETTINGS_KEY)).toMatchObject({ baseUrl: BUILD.baseUrl, apiKey: 'test-key-2', maxSteps: 10 });
    expect(store.get(COPILOT_PROVISIONED_KEY)).toEqual(await hashes({ ...BUILD, apiKey: 'test-key-2' }));
  });

  it('is a no-op without build values', async () => {
    const { store, storage } = mem();
    expect(await provisionCopilot({ baseUrl: '', apiKey: '' }, storage)).toBe(false);
    expect(store.size).toBe(0);
  });

  it('does not rewrite when nothing changes', async () => {
    const { storage } = mem();
    await provisionCopilot(BUILD, storage);
    expect(await provisionCopilot(BUILD, storage)).toBe(false);
  });

  it('keeps a model already saved', async () => {
    const { store, storage } = mem({ [COPILOT_SETTINGS_KEY]: { model: 'tooling' } });
    await provisionCopilot(BUILD, storage);
    expect(store.get(COPILOT_SETTINGS_KEY)).toMatchObject({ model: 'tooling', ...BUILD });
  });

  it('seeds only the empty field and leaves the user-set one', async () => {
    const { store, storage } = mem({ [COPILOT_SETTINGS_KEY]: { baseUrl: 'https://mine.example/v1', apiKey: '' } });
    await provisionCopilot(BUILD, storage);
    expect(store.get(COPILOT_SETTINGS_KEY)).toMatchObject({ baseUrl: 'https://mine.example/v1', apiKey: 'test-key-1' });
  });
});
