import { chromium } from '@playwright/test';
import type { Page, BrowserContext, Worker } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { startBrowserServer } from './browser-server';

// Shared harness for the INFRA-413 e2e (INFRA-450): a fixture WS server that plays the
// agent-browser-server side (same {id,type,payload} wire as tests/helpers/browser-server.ts),
// this checkout's extension loaded in its own Chromium, and the event recorder the architect's
// P5 note demands: onActivated/onFocusChanged logged from the service worker with windowId and
// timestamp, registered AFTER the human fixture (Dani's page) so only agent-caused events count.
// Pages are local (the `html` callback); no network.

export type AgentHarness = {
  origin: string;
  context: BrowserContext;
  worker: Worker;
  daniTabId: number;
  baselineWindowId: number;
  command: (type: string, payload?: Record<string, unknown>) => Promise<any>;
  /** Every onActivated/onFocusChanged since registration, with windowId and ts. */
  agentEvents: () => Promise<Array<{ type: string; tabId?: number; windowId?: number; ts: number }>>;
  /** Active tab inside Dani's window and the window Chrome reports focused. */
  daniState: () => Promise<{ activeTabId: number; focusedWindowId: number }>;
  close: () => Promise<void>;
};

export async function launchAgentHarness(html: (url: string | undefined) => string): Promise<AgentHarness> {
  const server = await startBrowserServer({ prefix: 'agent-harness', timeout: 30000, html });
  const context = await chromium.launchPersistentContext('', {
    channel: (process.env.AJB_CHANNEL ?? 'chromium') as 'chromium' | 'chrome',
    // Headful by default, as scripts/e2e-*.mjs (AJB_HEADLESS=1 for the old behavior): headless
    // Chromium does not paint occluded windows, so a background capture would show a blank frame.
    headless: process.env.AJB_HEADLESS === '1',
    args: [
      `--disable-extensions-except=${fileURLToPath(new URL('../../dist', import.meta.url))}`,
      `--load-extension=${fileURLToPath(new URL('../../dist', import.meta.url))}`,
      '--no-sandbox', '--disable-dev-shm-usage',
      // Chromium otherwise disables unpacked extensions on runtime.reload (Playwright #34711).
      '--disable-features=ExtensionDisableUnsupportedDeveloper,CalculateNativeWinOcclusion',
      // Same three flags as the deployed x86 Chrome (INFRA-449, criterion 8): without them an
      // occluded window's renderer throttles and its background captures go stale/white.
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
    ],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await panel.evaluate(async (serverUrl: string) => chrome.runtime.sendMessage(
    { action: 'saveServerConfig', payload: { serverUrl, token: '' } }),
  server.origin.replace('http:', 'ws:'));
  await (async () => {
    for (let i = 0; i < 100 && server.socket?.readyState !== 1; i++) await new Promise(r => setTimeout(r, 100));
    if (server.socket?.readyState !== 1) throw new Error('the extension never connected to the fixture server');
  })();

  // Dani's window (fixture): an ordinary page in the browser's focused window. Nothing of the
  // agent may move its active tab or steal its window's focus.
  const daniPage: Page = await context.newPage();
  await daniPage.goto(`${server.origin}/dani`);

  // Register the recorder only now: everything before this is the human fixture, not the agent.
  await worker.evaluate(() => {
    (globalThis as any).__ajbEvents = [];
    chrome.tabs.onActivated.addListener(e =>
      (globalThis as any).__ajbEvents.push({ type: 'onActivated', tabId: e.tabId, windowId: e.windowId, ts: Date.now() }));
    chrome.windows.onFocusChanged.addListener(w =>
      (globalThis as any).__ajbEvents.push({ type: 'onFocusChanged', windowId: w, ts: Date.now() }));
  });
  const baseline = await worker.evaluate(async () => ({
    focusedWindowId: (await chrome.windows.getLastFocused()).id,
    activeTabId: (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id ?? -1,
  }));

  return {
    origin: server.origin,
    context,
    worker,
    daniTabId: baseline.activeTabId,
    baselineWindowId: baseline.focusedWindowId,
    command: (type, payload = {}) => server.request(type, payload),
    agentEvents: () => worker.evaluate(() => (globalThis as any).__ajbEvents),
    daniState: () => worker.evaluate(async baselineWindowId => ({
      focusedWindowId: (await chrome.windows.getLastFocused()).id,
      activeTabId: (await chrome.tabs.query({ windowId: baselineWindowId, active: true }))[0]?.id ?? -1,
    }), baseline.focusedWindowId),
    close: async () => {
      await context.close().catch(() => undefined);
      await server.close();
    },
  };
}
