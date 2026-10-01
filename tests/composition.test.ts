import { describe, expect, it, vi } from 'vitest';

describe('extension composition', () => {
  it('both houses resolve runtime URLs through the shared core', async () => {
    vi.stubGlobal('chrome', {
      storage: { local: {
        get: vi.fn(async () => ({
          'ajb.serverUrl': 'wss://example.org/runtime',
          'ajb.connectionId': 'existing-installation',
          'ajb.token': '',
        })),
      } },
    });
    try {
      const { staticduo } = await import('../packages/house-staticduo/src/index');
      const { pocharlies } = await import('../packages/house-pocharlies/src/index');
      for (const house of [staticduo, pocharlies]) {
        const config = await house.createExtension().getServerConfig();
        expect(config.hostname).toBe('example.org');
        expect(config.path).toBe('/runtime');
        expect(config.connectionId).toBe('existing-installation');
        expect(config.source).toBe('manual');
        expect(config.token).toBe('');
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('imports the generic API and both houses without starting Chrome or sockets', async () => {
    const socket = vi.fn(() => { throw new Error('unexpected socket'); });
    vi.stubGlobal('WebSocket', socket);
    vi.stubGlobal('chrome', undefined);
    try {
      const core = await import('../packages/core/src/index');
      const { staticduo } = await import('../packages/house-staticduo/src/index');
      const { pocharlies } = await import('../packages/house-pocharlies/src/index');
      expect(staticduo.house).toBe('staticduo');
      expect(pocharlies.house).toBe('pocharlies');
      expect(staticduo.createExtension).toBe(core.createExtension);
      expect(pocharlies.createExtension).toBe(core.createExtension);
      expect(staticduo.createExtension().parseServerUrl('wss://example.org/custom')?.path).toBe('/custom');
      expect(socket).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
