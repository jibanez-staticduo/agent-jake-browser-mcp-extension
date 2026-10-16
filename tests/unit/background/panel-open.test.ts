import { describe, expect, it, vi } from 'vitest';
import { openPanelForTab, PANEL_PATH } from '@/background/panel-open';

vi.mock('@/utils/logger', () => ({ log: { warn: vi.fn() } }));

function sidePanel() {
  return { setOptions: vi.fn(async () => {}), open: vi.fn(async () => {}) };
}

describe('Un panel por pestaña', () => {
  it('abre el panel solo en la pestaña que lo pidió y la liga a su instancia', async () => {
    const panel = sidePanel();
    openPanelForTab(panel, { id: 7 });
    expect(panel.open).toHaveBeenCalledWith({ tabId: 7 });
    await vi.waitFor(() => expect(panel.setOptions).toHaveBeenCalledWith({ tabId: 7, path: PANEL_PATH, enabled: true }));
  });

  it('no abre nada si no hay pestaña que ligar', () => {
    const panel = sidePanel();
    openPanelForTab(panel, {});
    expect(panel.open).not.toHaveBeenCalled();
    expect(panel.setOptions).not.toHaveBeenCalled();
  });

  it('no liga nada si el panel no llegó a abrirse', async () => {
    const panel = sidePanel();
    panel.open.mockRejectedValueOnce(new Error('El panel ya está abierto'));
    openPanelForTab(panel, { id: 7 });
    await vi.waitFor(() => expect(panel.open).toHaveBeenCalled());
    expect(panel.setOptions).not.toHaveBeenCalled();
  });
});
