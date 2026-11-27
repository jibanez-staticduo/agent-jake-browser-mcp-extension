import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
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
