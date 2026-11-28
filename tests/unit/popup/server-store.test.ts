import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { SETUP_INSTANCES } from '@/config/setup-instances';
import { useServerStore } from '@/popup/stores/server';

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock('@/popup/stores/index', () => ({ sendMessage }));

const config = {
  effectiveUrl: 'wss://browser.example/ws', storedServerUrl: '', storedToken: '',
  serverRevision: null,
  label: 'Saved browser', connectionId: 'cid', connected: true,
  fromStorage: false, hasToken: false, pairing: { state: 'idle' },
};

beforeEach(() => {
  setActivePinia(createPinia());
  sendMessage.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('server name drafts', () => {
  it('loads the saved name and preserves edited drafts during polling', async () => {
    sendMessage.mockResolvedValue(config);
    const server = useServerStore();
    await server.refresh();
    expect(server.labelInput).toBe('Saved browser');
    server.labelInput = 'Draft browser';
    server.markDraftTouched();
    await server.refresh();
    expect(server.labelInput).toBe('Draft browser');
  });

  it('sends the name with existing settings and preserves edits during an in-flight save', async () => {
    const server = useServerStore();
    server.labelInput = 'Submitted browser';
    server.markDraftTouched();
    let finishSave!: (value: unknown) => void;
    sendMessage.mockImplementation((action: string) => action === 'saveServerConfig'
      ? new Promise(resolve => { finishSave = resolve; })
      : Promise.resolve(config));
    const saving = server.save();
    expect(sendMessage).toHaveBeenCalledWith('saveServerConfig', { label: 'Submitted browser' });
    server.labelInput = 'New draft';
    server.markDraftTouched();
    finishSave({ success: true });
    await saving;
    expect(server.labelInput).toBe('New draft');
  });
});

describe('server credential drafts', () => {
  it('keeps an edited token with the endpoint and revision that the user saw', async () => {
    const original = { ...config, storedToken: 'paired-token-a', serverRevision: 'revision-a' };
    const paired = {
      ...config, effectiveUrl: 'wss://paired.example/ws', storedServerUrl: 'wss://paired.example/ws',
      storedToken: 'paired-token-b', serverRevision: 'revision-b',
    };
    sendMessage.mockResolvedValue(original);
    const server = useServerStore();
    await server.refresh();
    server.tokenInput = 'draft-token-a';
    server.markDraftTouched('tokenInput');

    sendMessage.mockImplementation(async (action: string) => action === 'getServerConfig'
      ? paired
      : { success: false, conflict: true, error: 'La configuración del servidor cambió.' });
    await server.refresh();
    expect(server.serverUrlInput).toBe(original.storedServerUrl);
    expect(server.tokenInput).toBe('draft-token-a');
    await server.save();

    expect(sendMessage).toHaveBeenCalledWith('saveServerConfig', {
      token: 'draft-token-a', expectedServerRevision: 'revision-a', expectedEffectiveUrl: original.effectiveUrl,
    });
    expect(server.error).toBe('La configuración del servidor cambió.');
    expect(server.serverUrlInput).toBe(paired.storedServerUrl);
    expect(server.tokenInput).toBe('paired-token-b');
  });

  it('accepts a combined URL and token edit with the original revision', async () => {
    sendMessage.mockResolvedValue({ ...config, storedToken: 'token-a', serverRevision: 'revision-a' });
    const server = useServerStore();
    await server.refresh();
    server.serverUrlInput = 'wss://new.example/ws';
    server.markDraftTouched('serverUrlInput');
    expect(server.tokenInput).toBe('');
    server.tokenInput = 'token-b';
    server.markDraftTouched('tokenInput');
    await server.save();
    expect(sendMessage).toHaveBeenCalledWith('saveServerConfig', {
      serverUrl: 'wss://new.example/ws', token: 'token-b',
      expectedServerRevision: 'revision-a', expectedEffectiveUrl: config.effectiveUrl,
    });
  });
});

describe('saved destinations', () => {
  it('loads paired destinations and activates one with the ordinary setup request', async () => {
    const server = useServerStore();
    expect(server.pairedInstances).toEqual([]);
    vi.stubGlobal('chrome', { windows: { getCurrent: vi.fn().mockResolvedValue({ id: 11 }) } });
    sendMessage.mockResolvedValueOnce({ ...config, pairedInstances: ['nas', 'ari'] });
    await server.refresh();
    expect(server.pairedInstances).toEqual(['nas', 'ari']);

    sendMessage.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({
      ...config, effectiveUrl: SETUP_INSTANCES.ari.wsUrl, pairedInstances: ['nas', 'ari'],
    });
    await server.runSetup('ari');

    expect(sendMessage).toHaveBeenCalledWith('startSetup', { instance: 'ari', windowId: 11 });
    expect(server.effectiveUrl).toBe(SETUP_INSTANCES.ari.wsUrl);
    expect(server.pairedInstances).toEqual(['nas', 'ari']);
  });

  it('requests a fresh pairing explicitly and reopens the pending approval for a saved destination', async () => {
    const server = useServerStore();
    vi.stubGlobal('chrome', { windows: { getCurrent: vi.fn().mockResolvedValue({ id: 21 }) } });
    const pending = {
      ...config, effectiveUrl: SETUP_INSTANCES.defend.wsUrl, pairedInstances: ['defend'],
      setupPairing: { state: 'pending', instance: 'defend' },
    };
    sendMessage.mockImplementation(async (action: string) => action === 'getServerConfig' ? pending : { success: true });

    await server.runSetup('defend', true);
    await server.reopenSetup();

    const requests = sendMessage.mock.calls.filter(([action]) => action === 'startSetup');
    expect(requests).toEqual([
      ['startSetup', { instance: 'defend', windowId: 21, rePair: true }],
      ['startSetup', { instance: 'defend', windowId: 21, reopen: true }],
    ]);
  });

  it('reopens the first approval without requesting a fresh pairing', async () => {
    const server = useServerStore();
    vi.stubGlobal('chrome', { windows: { getCurrent: vi.fn().mockResolvedValue({ id: 31 }) } });
    const pending = { ...config, setupPairing: { state: 'pending', instance: 'nas' } };
    sendMessage.mockImplementation(async (action: string) => action === 'getServerConfig' ? pending : { success: true });
    await server.refresh();
    await server.reopenSetup();

    expect(sendMessage).toHaveBeenCalledWith('startSetup', { instance: 'nas', windowId: 31, reopen: true });
  });
});
