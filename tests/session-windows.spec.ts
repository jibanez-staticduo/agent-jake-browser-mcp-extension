import { test, expect, chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { startBrowserServer } from './helpers/browser-server';

test('session windows survive extension reload and preserve user tabs without changing focus', async () => {
  test.setTimeout(60000);
  const fixture = await startBrowserServer({
    prefix: 'tab-close', timeout: 20000,
    html: () => '<!doctype html><title>Tab close fixture</title><p>Disposable test tab</p>',
  });
  const { origin, request } = fixture;
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [
      `--disable-extensions-except=${fileURLToPath(new URL('../dist', import.meta.url))}`,
      `--load-extension=${fileURLToPath(new URL('../dist', import.meta.url))}`,
      '--no-sandbox', '--disable-dev-shm-usage',
      // Chromium otherwise disables unpacked extensions on runtime.reload (Playwright #34711).
      '--disable-features=ExtensionDisableUnsupportedDeveloper',
    ],
  });
  try {
    let worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const popupUrl = `chrome-extension://${new URL(worker.url()).host}/src/sidepanel/index.html`;
    let popup = await context.newPage();
    await popup.goto(popupUrl);
    await popup.evaluate(async serverUrl => chrome.runtime.sendMessage({ action: 'saveServerConfig', payload: { serverUrl, token: '' } }), origin.replace('http:', 'ws:'));
    await expect.poll(() => fixture.socket?.readyState).toBe(1);
    const userPage = await context.newPage();
    await userPage.goto(`${origin}/human`);
    const baseline = await worker.evaluate(async () => (await chrome.windows.getLastFocused()).id);
    const listing = await request('browser_list_tabs', {});
    expect(listing.result).toMatchObject({ closeById: true, closeWindow: true, windowPerSession: true });
    const first = await request('browser_new_tab', { url: `${origin}/agent-a`, switchTo: true });
    expect(first.success).toBe(true);
    expect(first.result.windowCreated).toBe(true);
    expect(first.result.loaded).toBe(true);
    expect(first.result.windowId).not.toBe(baseline);
    const agentWindow = first.result.windowId;
    const firstId = first.result.tab.id;
    expect(await worker.evaluate(async () => (await chrome.windows.getLastFocused()).id)).toBe(baseline);
    const second = await request('browser_new_tab', { url: `${origin}/agent-b`, windowId: agentWindow, switchTo: true });
    expect(second).toMatchObject({ success: true, result: { windowId: agentWindow, windowCreated: false } });
    const secondId = second.result.tab.id;
    expect(await worker.evaluate(async id => (await chrome.tabs.get(id)).active, secondId)).toBe(false);
    const screenshot = await request('browser_screenshot', {});
    expect(screenshot.success).toBe(true);
    expect(screenshot.result.image).toMatch(/^data:image\/png;base64,/);
    expect(await worker.evaluate(async id => (await chrome.tabs.get(id)).active, secondId)).toBe(false);
    expect(await worker.evaluate(async () => (await chrome.windows.getLastFocused()).id)).toBe(baseline);
    const oldTargets = await worker.evaluate(async () => chrome.debugger.getTargets());
    const oldUuid = oldTargets.find(target => target.tabId === firstId)!.id;
    const previousSocket = fixture.socket;
    await worker.evaluate(() => setTimeout(() => chrome.runtime.reload(), 0));
    popup = await context.newPage();
    await expect(async () => { await popup.goto(popupUrl); }).toPass({ timeout: 20000 });
    // Observe extension recovery through its page; Playwright can reuse its Worker handle.
    await expect.poll(() => fixture.socket !== previousSocket && fixture.socket?.readyState === 1, { timeout: 20000 }).toBe(true);
    expect((await popup.evaluate(async () => chrome.debugger.getTargets())).find(target => target.tabId === firstId)!.id).toBe(oldUuid);
    const third = await request('browser_new_tab', { url: `${origin}/agent-after-reload`, windowId: agentWindow });
    expect(third).toMatchObject({ success: true, result: { windowId: agentWindow, windowCreated: false } });
    const thirdId = third.result.tab.id;
    const userId = await popup.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id!, `${origin}/human`);
    await popup.evaluate(async ({ userId, agentWindow }) => chrome.tabs.move(userId, { windowId: agentWindow, index: -1 }), { userId, agentWindow });
    expect((await request('browser_close_window', { windowId: baseline, tabIds: [userId] })).success).toBe(false);
    const empty = await request('browser_close_window', { windowId: agentWindow, tabIds: [] });
    expect(empty).toMatchObject({ success: true, result: { closed: false, closedTabIds: [] } });
    const closed = await request('browser_close_window', { windowId: agentWindow, tabIds: [firstId, secondId, thirdId] });
    expect(closed).toMatchObject({ success: true, result: { windowId: agentWindow, closed: false, closedTabIds: [firstId, secondId, thirdId] } });
    expect(userPage.isClosed()).toBe(false);
    expect(await popup.evaluate(async id => (await chrome.tabs.get(id)).url, userId)).toBe(`${origin}/human`);
    const stale = await request('browser_new_tab', { url: `${origin}/new-session`, windowId: agentWindow });
    expect(stale.result.windowCreated).toBe(true);
    expect(stale.result.windowId).not.toBe(agentWindow);
  } finally {
    await context.close();
    await fixture.close();
  }
});
