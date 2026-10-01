import { describe, expect, it, vi } from 'vitest';

describe('extension composition', () => {
  it('imports the generic API and both houses without starting Chrome or sockets', async () => {
    const socket = vi.fn(() => { throw new Error('unexpected socket'); });
    vi.stubGlobal('WebSocket', socket);
    vi.stubGlobal('chrome', undefined);
    try {
      const core = await import('../../packages/core/src/index');
      const { staticduo } = await import('../../packages/house-staticduo/src/index');
      const { pocharlies } = await import('../../packages/house-pocharlies/src/index');
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
