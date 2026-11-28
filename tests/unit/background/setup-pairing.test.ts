import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEffectiveConfig, STORAGE_KEYS } from '@/config/runtime';
import { SETUP_INSTANCES, type SetupInstance } from '@/config/setup-instances';
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
  it('keeps all three pairs and restores each identity after a worker restart', async () => {
    const configs = (['nas', 'ari', 'defend'] as const).map((instance, index) => {
      const { wsUrl, baseUrl, mcpUrl } = SETUP_INSTANCES[instance];
      return [instance, {
        wsUrl, baseUrl, mcpUrl, connectionId: `12345678-1234-4234-8234-12345678901${index}`,
        label: `Fixture - ${instance}`, token: `ws-${instance}`, apiKey: `llm-${instance}`, mcpToken: `mcp-${instance}`,
      }] as const;
    });
    let setup = await import('@/background/setup-pairing');
    for (const [instance, config] of configs) {
      fetch.mockResolvedValueOnce(response({ approvalCode, pollSecret }, 201));
      fetch.mockResolvedValueOnce(response({ state: 'approved', config }));
      await setup.startSetup(instance, clearLegacy);
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(create).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenCalledTimes(6);

    vi.resetModules();
    setup = await import('@/background/setup-pairing');
    const reload = vi.fn();
    setup.setOnSetupApproved(reload);
    expect(await setup.getPairedInstances()).toEqual(expect.arrayContaining(['nas', 'ari', 'defend']));
    for (const [instance, config] of configs) {
      const previousRevision = store[STORAGE_KEYS.serverRevision];
      await setup.startSetup(instance, clearLegacy);
      expect(await getEffectiveConfig()).toMatchObject({ connectionId: config.connectionId, token: config.token });
      expect(store[STORAGE_KEYS.tokenUrl]).toBe(config.wsUrl);
      expect(store[STORAGE_KEYS.serverRevision]).not.toBe(previousRevision);
      expect(store[COPILOT_SETTINGS_KEY]).toMatchObject({
        baseUrl: config.baseUrl, apiKey: config.apiKey, apiKeyUrl: config.baseUrl,
        mcpUrl: config.mcpUrl, mcpToken: config.mcpToken, mcpTokenUrl: config.mcpUrl,
      });
    }
    expect(reload).toHaveBeenCalledTimes(3);
    expect(create).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('restores an endpoint-bound setup from the previous release and lets users re-pair it', async () => {
    const instance: SetupInstance = 'defend';
    Object.assign(store, {
      [STORAGE_KEYS.serverUrl]: wsUrl,
      [STORAGE_KEYS.tokenUrl]: wsUrl,
      [STORAGE_KEYS.token]: config.token,
      [STORAGE_KEYS.connectionId]: connectionId,
      [STORAGE_KEYS.label]: config.label,
      [COPILOT_SETTINGS_KEY]: { baseUrl, mcpUrl, apiKey: config.apiKey, mcpToken: config.mcpToken, mcpTokenUrl: mcpUrl },
    });
    const setup = await import('@/background/setup-pairing');
    expect(await setup.getPairedInstances()).toEqual([]);
    Object.assign(store[COPILOT_SETTINGS_KEY] as object, { apiKeyUrl: baseUrl });
    expect(await setup.getPairedInstances()).toEqual([instance]);
    await setup.startSetup(instance, clearLegacy);
    expect(fetch).not.toHaveBeenCalled();

    fetch.mockResolvedValueOnce(response({ approvalCode, pollSecret }, 201));
    fetch.mockResolvedValueOnce(response({ state: 'approved', config: { ...config, token: 'new-ws-key' } }));
    await setup.startSetup(instance, clearLegacy, 42, true);
    expect(create).toHaveBeenCalledWith({ url: `${origin}/setup?code=${approvalCode}`, windowId: 42 });
    await vi.advanceTimersByTimeAsync(20);
    expect((await getEffectiveConfig()).token).toBe('new-ws-key');
    expect(await setup.getPairedInstances()).toEqual([instance]);
    await setup.startSetup(instance, clearLegacy, 42, false, true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('retains endpoint-bound edits and explicit clears when switching back', async () => {
    const setup = await import('@/background/setup-pairing');
    const nas = SETUP_INSTANCES.nas;
    for (const [instance, profile] of [
      ['defend', config],
      ['nas', { ...config, wsUrl: nas.wsUrl, baseUrl: nas.baseUrl, mcpUrl: nas.mcpUrl }],
    ] as const) {
      fetch.mockResolvedValueOnce(response({ approvalCode, pollSecret }, 201));
      fetch.mockResolvedValueOnce(response({ state: 'approved', config: profile }));
      await setup.startSetup(instance, clearLegacy);
      await vi.advanceTimersByTimeAsync(20);
    }

    Object.assign(store, {
      [STORAGE_KEYS.token]: '',
      [STORAGE_KEYS.label]: 'Changed manually',
    });
    Object.assign(store[COPILOT_SETTINGS_KEY] as object, {
      apiKey: 'rotated-key', mcpToken: '', mcpTokenUrl: '', vision: false, maxSteps: 35, stepsView: 'compact',
    });
    await setup.startSetup('defend', clearLegacy);
    expect((await getEffectiveConfig()).token).toBe(config.token);
    await setup.startSetup('nas', clearLegacy);
    expect(await getEffectiveConfig()).toMatchObject({ token: '', label: 'Changed manually' });
    expect(store[COPILOT_SETTINGS_KEY]).toMatchObject({
      apiKey: 'rotated-key', mcpToken: '', vision: false, maxSteps: 35, stepsView: 'compact',
    });
  });

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

  it('retries the same grant after a failed local write before reconnecting', async () => {
    const setup = await import('@/background/setup-pairing');
    const reload = vi.fn();
    setup.setOnSetupApproved(reload);
    fetch.mockResolvedValueOnce(response({ approvalCode, pollSecret }, 201));
    fetch.mockResolvedValue(response({ state: 'approved', config }));
    store[STORAGE_KEYS.token] = 'previous-key';
    await setup.startSetup('defend', clearLegacy);
    set.mockRejectedValueOnce(new Error('temporary storage error'));
    await vi.advanceTimersByTimeAsync(20);
    expect(store[pendingKey]).toMatchObject({ pollSecret });
    expect(store[STORAGE_KEYS.token]).toBe('previous-key');
    expect(setup.getSetupPairingInfo()).toMatchObject({ state: 'pending' });
    expect(reload).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    const requested = fetch.mock.calls.filter(([url]) => String(url).endsWith('/setup/status'));
    expect(requested.map(([, init]) => init.body)).toEqual(Array(2).fill(JSON.stringify({ pollSecret })));
    expect(store[pendingKey]).toBeNull();
    expect(store[STORAGE_KEYS.connectionId]).toBe(connectionId);
    expect(store[STORAGE_KEYS.token]).toBe('ws-key');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('opens the original and reopened approvals in the respective requesting windows', async () => {
    const setup = await import('@/background/setup-pairing');
    let releaseStart!: (res: unknown) => void;
    fetch.mockReturnValueOnce(new Promise(resolve => { releaseStart = resolve; }));
    const started = setup.startSetup('defend', clearLegacy, 11);
    await vi.advanceTimersByTimeAsync(0);
    expect(create).not.toHaveBeenCalled();
    releaseStart(response({ approvalCode, pollSecret }, 201));
    await started;
    await setup.startSetup('defend', clearLegacy, 27);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(create.mock.calls).toEqual([
      [{ url: `${origin}/setup?code=${approvalCode}`, windowId: 11 }],
      [{ url: `${origin}/setup?code=${approvalCode}`, windowId: 27 }],
    ]);
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
