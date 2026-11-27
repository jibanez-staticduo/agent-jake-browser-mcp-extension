import { describe, expect, it } from 'vitest';
import { provisionCopilot, type ProvisionStorage } from '@/background/provision';
import { sha256 } from '@/utils/copilot-settings';
import { COPILOT_PROVISIONED_KEY, COPILOT_SETTINGS_KEY, DEFAULT_COPILOT_SETTINGS } from '@/types/copilot';

const hashes = async (v: { baseUrl: string; apiKey: string }) => ({ baseUrl: await sha256(v.baseUrl), apiKey: await sha256(v.apiKey) });
const BUILD = { baseUrl: 'https://litellm.example/v1', apiKey: 'test-key-1' };

function mem(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  const storage: ProvisionStorage = {
    get: async (keys) => Object.fromEntries(keys.map((key) => [key, store.get(key)])),
    set: async (values) => { for (const [key, value] of Object.entries(values)) store.set(key, value); },
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
    expect(store.get(COPILOT_SETTINGS_KEY)).toMatchObject({ ...BUILD, apiKeyUrl: BUILD.baseUrl, model: 'qwen38-flash-next' });
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
    expect(store.get(COPILOT_SETTINGS_KEY)).toMatchObject({ baseUrl: BUILD.baseUrl, apiKey: 'test-key-2', apiKeyUrl: BUILD.baseUrl, maxSteps: 10 });
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

  it('keeps the compiled key out of a manual endpoint after it was saved without a key', async () => {
    const { store, storage } = mem();
    await provisionCopilot(BUILD, storage);
    const manual = { baseUrl: 'https://mine.example/v1', apiKey: '', apiKeyUrl: '' };
    await storage.set({ [COPILOT_SETTINGS_KEY]: manual });
    expect(await provisionCopilot(BUILD, storage)).toBe(false);
    expect(store.get(COPILOT_SETTINGS_KEY)).toEqual(manual);
  });

  it('clears a legacy seed that was left unbound at a different endpoint', async () => {
    const { store, storage } = mem({
      [COPILOT_SETTINGS_KEY]: { baseUrl: 'https://mine.example/v1', apiKey: 'previous-build-key' },
      [COPILOT_PROVISIONED_KEY]: await hashes({ ...BUILD, apiKey: 'previous-build-key' }),
    });
    expect(await provisionCopilot(BUILD, storage)).toBe(true);
    expect(store.get(COPILOT_SETTINGS_KEY)).toMatchObject({ baseUrl: 'https://mine.example/v1', apiKey: '' });
  });

  it('rotates the endpoint and the key together for a managed install', async () => {
    const { store, storage } = mem();
    await provisionCopilot(BUILD, storage);
    const moved = { baseUrl: 'https://replacement.example/v1', apiKey: 'new-key' };
    await provisionCopilot(moved, storage);
    expect(store.get(COPILOT_SETTINGS_KEY)).toMatchObject({ ...moved, apiKeyUrl: moved.baseUrl });
  });

  it.each([undefined, BUILD.baseUrl])('migrates a legacy seed on a neutral build with endpoint evidence %s', async (provenance) => {
    const { store, storage } = mem({
      [COPILOT_SETTINGS_KEY]: { ...BUILD },
      [COPILOT_PROVISIONED_KEY]: { apiKey: await sha256(BUILD.apiKey), baseUrl: provenance && await sha256(provenance) },
    });
    const neutral = { baseUrl: '', apiKey: '' };
    expect(await provisionCopilot(neutral, storage)).toBe(true);
    expect(store.get(COPILOT_SETTINGS_KEY)).toMatchObject(provenance
      ? { ...BUILD, apiKeyUrl: BUILD.baseUrl }
      : { baseUrl: BUILD.baseUrl, apiKey: '' });
    expect(await provisionCopilot(neutral, storage)).toBe(false);
  });

  it('keeps a key explicitly bound to a manual endpoint even if it matches an old seed', async () => {
    const manual = { baseUrl: 'https://mine.example/v1', apiKey: BUILD.apiKey, apiKeyUrl: 'https://mine.example/v1' };
    const { store, storage } = mem({
      [COPILOT_SETTINGS_KEY]: manual,
      [COPILOT_PROVISIONED_KEY]: await hashes(BUILD),
    });
    expect(await provisionCopilot({ baseUrl: '', apiKey: '' }, storage)).toBe(false);
    expect(await provisionCopilot(BUILD, storage)).toBe(false);
    expect(store.get(COPILOT_SETTINGS_KEY)).toEqual(manual);
  });

  it('never seeds a build key without its own configured endpoint', async () => {
    const { store, storage } = mem({ [COPILOT_SETTINGS_KEY]: { baseUrl: 'https://mine.example/v1', apiKey: '' } });
    expect(await provisionCopilot({ ...BUILD, baseUrl: '' }, storage)).toBe(false);
    expect(store.get(COPILOT_SETTINGS_KEY)).toMatchObject({ apiKey: '' });
  });
});
