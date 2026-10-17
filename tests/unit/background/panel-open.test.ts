import { describe, expect, it, vi } from 'vitest';
import { disablePanelByDefault, openPanelForTab, PANEL_PATH } from '@/background/panel-open';

vi.mock('@/utils/logger', () => ({ log: { warn: vi.fn() } }));

function sidePanel() {
  return { setOptions: vi.fn(async () => {}), open: vi.fn(async () => {}) };
}

describe('Un panel por pestaña', () => {
  it('liga la pestaña y la abre en el mismo turno, con la liga antes de la apertura', () => {
    const panel = sidePanel();
    openPanelForTab(panel, { id: 7 });
    expect(panel.setOptions).toHaveBeenCalledWith({ tabId: 7, path: PANEL_PATH, enabled: true });
    expect(panel.open).toHaveBeenCalledWith({ tabId: 7 });
    expect(panel.setOptions.mock.invocationCallOrder[0]).toBeLessThan(panel.open.mock.invocationCallOrder[0]);
  });

  it('no abre nada si no hay pestaña que ligar', () => {
    const panel = sidePanel();
    openPanelForTab(panel, {});
    expect(panel.open).not.toHaveBeenCalled();
    expect(panel.setOptions).not.toHaveBeenCalled();
  });

  it('ninguna pestaña tiene panel por defecto, que es lo que hace que se oculte al cambiar', () => {
    const panel = sidePanel();
    disablePanelByDefault(panel);
    expect(panel.setOptions).toHaveBeenCalledWith({ path: PANEL_PATH, enabled: false });
    expect(panel.open).not.toHaveBeenCalled();
  });
});
