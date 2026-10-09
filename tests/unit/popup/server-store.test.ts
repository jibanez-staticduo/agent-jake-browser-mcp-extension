import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useServerStore } from '@/popup/stores/server';

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock('@/popup/stores/index', () => ({ sendMessage }));

const config = {
  effectiveUrl: 'wss://browser.example/ws', storedServerUrl: '', storedToken: '',
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
    expect(sendMessage).toHaveBeenCalledWith('saveServerConfig', {
      serverUrl: '', token: '', label: 'Submitted browser',
    });
    server.labelInput = 'New draft';
    server.markDraftTouched();
    finishSave({ success: true });
    await saving;
    expect(server.labelInput).toBe('New draft');
  });
});
