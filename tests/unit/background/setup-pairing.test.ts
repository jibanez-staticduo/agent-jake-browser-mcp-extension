import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEffectiveConfig, STORAGE_KEYS } from '@/config/runtime';
import { SETUP_INSTANCES } from '@/config/setup-instances';
import { COPILOT_SETTINGS_KEY } from '@/types/copilot';

const pendingKey = 'ajb.pendingSetup';
const approvalCode = 'a'.repeat(43);
const pollSecret = 'b'.repeat(43);
const connectionId = '12345678-1234-4234-8234-123456789012';
const { origin, wsUrl, baseUrl, mcpUrl } = SETUP_INSTANCES.defend;
const config = { wsUrl, baseUrl, mcpUrl, connectionId, label: 'Laptop - Work', token: 'ws-key', apiKey: 'llm-key', mcpToken: 'mcp-key' };
const store: Record<string, unknown> = {};

const fetch = vi.fn();
const create = vi.fn(async () => ({}));
const set = vi.fn(async (items: object) => { Object.assign(store, items); });
const get = vi.fn(async (keys: string | string[]) => Object.fromEntries(
  (Array.isArray(keys) ? keys : [keys]).map((key) => [key, store[key]]),
));
const remove = vi.fn(async (key: string) => { delete store[key]; });
const clearLegacy = vi.fn(async () => {});

function response(data: object, status = 200) {
  return { status, json: async () => data };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  fetch.mockReset();
  vi.clearAllMocks();
  Object.keys(store).forEach((key) => delete store[key]);
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('chrome', { tabs: { create }, storage: { local: { get, set, remove } } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('automatic setup', () => {
  it('opens approval without the poll secret and applies one atomic write and reconnect', async () => {
    const setup = await import('@/background/setup-pairing');
    store[STORAGE_KEYS.connectionId] = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    store[COPILOT_SETTINGS_KEY] = { model: 'existing-model', apiKeyUrl: SETUP_INSTANCES.nas.baseUrl, apiKey: 'old-key' };
    fetch.mockResolvedValueOnce(response({ approvalCode, pollSecret }, 201));
    fetch.mockResolvedValueOnce(response({ state: 'approved', config }));
    const reload = vi.fn();
    setup.setOnSetupApproved(reload);

    await setup.startSetup('defend', clearLegacy);
    expect(create).toHaveBeenCalledWith({ url: `${origin}/setup?code=${approvalCode}` });
    expect(fetch).toHaveBeenCalledWith(`${origin}/setup/start`, expect.objectContaining({ body: '{}', redirect: 'error' }));
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetch).toHaveBeenLastCalledWith(`${origin}/setup/status`, expect.objectContaining({ body: JSON.stringify({ pollSecret }) }));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({
      [pendingKey]: null,
      [STORAGE_KEYS.connectionId]: connectionId,
      [STORAGE_KEYS.serverUrl]: wsUrl,
      [STORAGE_KEYS.token]: 'ws-key',
      [STORAGE_KEYS.tokenUrl]: wsUrl,
      [STORAGE_KEYS.label]: 'Laptop - Work',
      [COPILOT_SETTINGS_KEY]: expect.objectContaining({
        model: 'existing-model', baseUrl, apiKey: 'llm-key', apiKeyUrl: baseUrl, mcpUrl, mcpToken: 'mcp-key',
        mcpTokenUrl: mcpUrl, maxSteps: 200, vision: true, stepsView: 'extended',
      }),
    }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(setup.getSetupPairingInfo()).toEqual({ state: 'approved', instance: 'defend' });
    expect((await getEffectiveConfig()).token).toBe('ws-key');
    store[STORAGE_KEYS.serverUrl] = SETUP_INSTANCES.nas.wsUrl;
    expect((await getEffectiveConfig()).token).toBe('');
  });

  it('rejects a cross-instance destination from the approved response without writing credentials', async () => {
    const setup = await import('@/background/setup-pairing');
    const reload = vi.fn();
    setup.setOnSetupApproved(reload);
    fetch.mockResolvedValueOnce(response({ approvalCode, pollSecret }, 201));
    fetch.mockResolvedValueOnce(response({ state: 'approved', config: { ...config, mcpUrl: SETUP_INSTANCES.nas.mcpUrl } }));

    await setup.startSetup('defend', clearLegacy);
    await vi.advanceTimersByTimeAsync(20);
    expect(setup.getSetupPairingInfo()).toMatchObject({ state: 'error' });
    expect(store[STORAGE_KEYS.token]).toBeUndefined();
    expect(store[pendingKey]).toBeUndefined();
    expect(reload).not.toHaveBeenCalled();
  });

  it('ignores a late approval for a superseded instance and resumes the active one from storage', async () => {
    const setup = await import('@/background/setup-pairing');
    let releaseStatus!: (res: unknown) => void;
    const delayedStatus = new Promise((resolve) => { releaseStatus = resolve; });
    fetch.mockResolvedValueOnce(response({ approvalCode, pollSecret }, 201));
    fetch.mockReturnValueOnce(delayedStatus);
    fetch.mockResolvedValueOnce(response({ approvalCode, pollSecret }, 201));
    await setup.startSetup('defend', clearLegacy);
    await vi.advanceTimersByTimeAsync(1);
    await setup.startSetup('nas', clearLegacy);
    releaseStatus(response({ state: 'approved', config }));
    await vi.advanceTimersByTimeAsync(0);
    expect(store[STORAGE_KEYS.token]).toBeUndefined();
    expect(store[pendingKey]).toMatchObject({ instance: 'nas' });

    vi.clearAllTimers();
    vi.resetModules();
    const resumed = await import('@/background/setup-pairing');
    fetch.mockResolvedValueOnce(response({ state: 'expired' }));
    expect(await resumed.resumeSetup()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenLastCalledWith(`${SETUP_INSTANCES.nas.origin}/setup/status`, expect.anything());
    expect(resumed.getSetupPairingInfo()).toEqual({ state: 'expired', instance: 'nas' });
    expect(store[pendingKey]).toBeUndefined();
  });
});
