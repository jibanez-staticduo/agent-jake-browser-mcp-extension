/**
 * Opening the copilot panel: one panel per tab, like Claude's extension (INFRA-875).
 *
 * `sidePanel.open({ tabId })` opens the panel **only** on the tab that asked for it — with
 * `{ windowId }` it opens on every tab of the window, which is what made our panel follow whichever
 * tab you clicked on. The tab is then bound to its own instance of the panel, so Chrome hides it when
 * you leave the tab and shows it again when you come back. `open()` needs the click's or shortcut's
 * user gesture, which is why this runs straight from the listener.
 */
import { log } from '@/utils/logger';

export const PANEL_PATH = 'src/sidepanel/index.html';

type SidePanel = Pick<typeof chrome.sidePanel, 'setOptions' | 'open'>;

/** Bind the panel to `tab` and open it there. Called straight from the toolbar click or Alt+J. */
export function openPanelForTab(sidePanel: SidePanel, tab: { id?: number }): void {
  if (tab.id === undefined) return;
  sidePanel.open({ tabId: tab.id })
    .then(() => sidePanel.setOptions({ tabId: tab.id, path: PANEL_PATH, enabled: true }))
    .catch((error) => log.warn('[Copilot] Could not open the panel on its tab:', error));
}
