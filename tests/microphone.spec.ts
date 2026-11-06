import { test, expect, chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

test('Chrome accepts the manifest and the panel can request microphone audio', async () => {
  const extension = process.env.AJB_EXTENSION_DIR || fileURLToPath(new URL('../dist', import.meta.url));
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--no-sandbox', '--disable-dev-shm-usage',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    ],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const permissions = await worker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
    expect(permissions).not.toContain('microphone');
    const manager = await context.newPage();
    await manager.goto('chrome://extensions');
    const problems = await manager.evaluate(async id => {
      const entries = await (chrome as any).developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true });
      const extension = entries.find((item: any) => item.id === id);
      if (!extension) throw new Error('Extension did not load');
      return [...(extension.manifestErrors ?? []), ...(extension.installWarnings ?? [])]
        .map((issue: any) => typeof issue === 'string' ? issue : issue.message);
    }, extensionId);
    expect(problems).toEqual([]);

    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    // Chromium grants a synthetic device in this disposable profile; no real audio is recorded.
    const capture = await panel.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      try {
        return stream.getAudioTracks().map(track => ({ kind: track.kind, state: track.readyState }));
      } finally {
        stream.getTracks().forEach(track => track.stop());
      }
    });
    expect(capture).toEqual([{ kind: 'audio', state: 'live' }]);
  } finally {
    await context.close();
  }
});
