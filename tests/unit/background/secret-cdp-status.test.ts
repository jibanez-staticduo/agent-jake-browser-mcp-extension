import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabManager } from '@/background/tab-manager';
import { withSecretLogging, isSecretLogging } from '@/utils/logger';

describe('secret CDP status boundary', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('redacts a rejected status probe while a secret operation is pending', async () => {
    const fakeSecret = 'FAKE-review-secret-91';
    vi.stubGlobal('chrome', { debugger: { sendCommand: vi.fn(async (_target, method) => {
      if (method === 'Runtime.enable') return {};
      throw new Error(fakeSecret);
    }) } });
    const manager = new TabManager();
    (manager as any).session(1).debuggerAttached = true;
    let release!: () => void;
    const pending = withSecretLogging(() => new Promise<void>(resolve => { release = resolve; }));
    try {
      expect(isSecretLogging()).toBe(true);
      const status = await manager.getCdpStatus(1);
      expect(status).toMatchObject({ canExecuteCdp: false, lastCdpError: 'Secret operation CDP failure' });
      expect(JSON.stringify(status)).not.toContain(fakeSecret);
    } finally {
      release();
      await pending;
    }
    expect(isSecretLogging()).toBe(false);
    expect(await manager.getCdpStatus(1)).toMatchObject({ canExecuteCdp: false, lastCdpError: fakeSecret });
  });
});
