/**
 * Opening the copilot panel: one panel per tab, like Claude's extension (INFRA-875).
 *
 * Two pieces, and the live check showed you need both:
 * - `disablePanelByDefault()` — `manifest.json` declares `side_panel.default_path`, so without this
 *   Chrome has a global panel and shows it on **every** tab of the window, following you around.
 *   Tabs with no specific settings take these default options, so the default is "no panel".
 * - `openPanelForTab()` — a tab that asks gets its own instance bound with `setOptions({ tabId })`,
 *   and `open({ tabId })` shows it on that tab only. Chrome then hides it when you leave the tab and
 *   brings it back when you return. `open()` insists on a live user gesture, so both calls leave in
 *   the same tick, the bind first so the tab already has its panel when `open()` runs.
 */
import { log } from '@/utils/logger';

export const PANEL_PATH = 'src/sidepanel/index.html';

type SidePanel = Pick<typeof chrome.sidePanel, 'setOptions' | 'open'>;

const warn = (error: unknown) => log.warn('[Copilot] Could not open the panel on its tab:', error);

/** Close the panel on every tab that never asked for one. Called once at startup. */
export function disablePanelByDefault(sidePanel: SidePanel): void {
  sidePanel.setOptions({ path: PANEL_PATH, enabled: false }).catch(warn);
}

/** Bind the panel to `tab` and open it there. Called straight from the toolbar click or Alt+J. */
export function openPanelForTab(sidePanel: SidePanel, tab: { id?: number }): void {
  if (tab.id === undefined) return;
  sidePanel.setOptions({ tabId: tab.id, path: PANEL_PATH, enabled: true }).catch(warn);
  sidePanel.open({ tabId: tab.id }).catch(warn);
}
