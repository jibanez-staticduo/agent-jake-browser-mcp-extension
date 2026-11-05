import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import zlib from 'node:zlib';
import { launchAgentHarness, type AgentHarness } from './helpers/agent-harness';

// INFRA-450 (P5 of INFRA-413) — criteria 1, 2 and 3 of the epic, with the invariant of
// nota-architect-plan.md P5: "provocado por el agente" is measured as the real invariant (Dani's
// window fixture keeps its active tab and its focus; no onActivated/onFocusChanged outside the
// windows and tabs the agent created), not a raw counter. Fixtures are local and committed: the
// three session pages paint a distinct pure color and a round marker, so a capture that is not
// the tab's own is caught by its first pixel. Duration: 10 min by default (criterion 1);
// AJB_E2E_MINUTES shortens it for development runs. Not run in CI (Playwright is not in CI).

const MINUTES = Number(process.env.AJB_E2E_MINUTES ?? 10);
const SESSIONS = [
  { key: 'a', color: [255, 0, 0] as const },
  { key: 'b', color: [0, 170, 0] as const },
  { key: 'c', color: [0, 0, 255] as const },
];

const page = (key: string, round: number) => {
  const s = SESSIONS.find(x => x.key === key)!;
  const rgb = `rgb(${s.color[0]},${s.color[1]},${s.color[2]})`;
  return `<!doctype html><html style="background:${rgb}"><head><meta charset="utf-8"><title>SESION-${key.toUpperCase()} r=${round}</title></head>
<body style="background:${rgb};margin:0">
<h1>SESION-${key.toUpperCase()} r=${round}</h1>
<input id="plain" type="text" aria-label="plain">
</body></html>`;
};

const html = (url: string | undefined) => {
  const { pathname, searchParams } = new URL(url ?? '/', 'http://127.0.0.1');
  const match = /^\/sesion-([abc])$/.exec(pathname);
  if (match) return page(match[1], Number(searchParams.get('r') ?? 0));
  return '<!doctype html><title>Dani fixture</title><body style="background:#eeeeee"><h1>Ventana de Dani (fixture)</h1>';
};

type Session = { key: string; tabId: number; windowId: number; lastShot: string; page: Page };

async function findPage(context: AgentHarness['context'], url: string): Promise<Page> {
  for (let i = 0; i < 100; i++) {
    const found = context.pages().find(p => p.url() === url);
    if (found) return found;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`the fixture page ${url} never appeared in the context`);
}

type Fixtures = {
  harness: AgentHarness;
  sessions: Session[];
};

const test = base.extend<Fixtures>({
  harness: [async ({}, use) => {
    const harness = await launchAgentHarness(html);
    await use(harness);
    await harness.close();
  }, { scope: 'worker' }],
  sessions: [async ({}, use) => use([]), { scope: 'worker' }],
});

// First pixel of a PNG, unfiltering only scanline 0. With the row above = zeros, Up and Paeth
// add nothing (Paeth's predictor reduces to c = 0, not to Sub — measured against Chrome's
// captureVisibleTab PNGs, which encode solid scanlines with filter 4), Sub adds the left byte
// and Average adds left >> 1. The fixture pages paint a pure color: this decides whose tab a
// background capture really is, which "distinct bytes" alone cannot (two blanks are identical).
function firstPixel(png: Buffer): [number, number, number] {
  let pos = 8, width = 0, colorType = 0;
  const idat: Buffer[] = [];
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    if (type === 'IHDR') { width = png.readUInt32BE(pos + 8); colorType = png[pos + 17]; }
    if (type === 'IDAT') idat.push(png.subarray(pos + 8, pos + 8 + len));
    if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const filter = raw[0];
  const row = Buffer.from(raw.subarray(1, 1 + stride));
  for (let i = 0; i < stride; i++) {
    const left = i >= bpp ? row[i - bpp] : 0;
    if (filter === 1) row[i] = (row[i] + left) & 255;
    else if (filter === 3) row[i] = (row[i] + (left >> 1)) & 255;
    // filters 0, 2 and 4 leave the byte on scanline 0 (row above = zeros)
  }
  return [row[0], row[1], row[2]]; // RGB of the first pixel (not the R of three pixels)
}

const shotBytes = (reply: any) => String(reply.result.image).replace(/^data:image\/png;base64,/, '');

test('C1 · tres sesiones paralelas intercalan navigate/snapshot/click/type/screenshot y cada resultado es de su sesión', async ({ harness, sessions }) => {
  test.setTimeout(MINUTES * 60_000 + 180_000);
  const listing = await harness.command('browser_list_tabs', {});
  expect(listing.result).toMatchObject({ closeById: true, closeWindow: true, windowPerSession: true });

  // One window per session, as the deployed server drives it: windowId comes from the server
  // (session-tabs), the extension opens it focused:false and reports windowCreated.
  for (const s of SESSIONS) {
    const opened = await harness.command('browser_new_tab', { url: `${harness.origin}/sesion-${s.key}?r=0` });
    expect(opened.success).toBe(true);
    expect(opened.result.windowCreated).toBe(true);
    const own = await findPage(harness.context, `${harness.origin}/sesion-${s.key}?r=0`);
    sessions.push({ key: s.key, tabId: opened.result.tab.id, windowId: opened.result.windowId, lastShot: '', page: own });
  }
  expect(new Set(sessions.map(s => s.windowId)).size).toBe(3);

  // Fixture arrangement (a human action, not an agent one): tile the three agent windows so none
  // is fully covered. Measured: a window that has NEVER been visible captures a blank frame until
  // it is (occlusion stops frame production even with --disable-backgrounding-occluded-windows).
  // "Background" in the criterion means "not focused, not in front of Dani's", not "never shown".
  for (const [i, s] of sessions.entries()) {
    await harness.worker.evaluate(async ({ windowId, left }: { windowId: number, left: number }) => {
      await chrome.windows.update(windowId, { left, top: 60, width: 420, height: 640 });
    }, { windowId: s.windowId, left: 40 + i * 440 });
  }

  // First paint of a never-shown window takes ~1 s (measured): wait for it before the rounds, or
  // the round-1 capture is the blank pre-paint frame. Once painted, captures track navigations.
  for (const s of sessions) {
    const expected = SESSIONS.find(x => x.key === s.key)!.color;
    await expect.poll(async () => {
      const shot = await harness.command('browser_screenshot', { targetTabId: s.tabId });
      if (!shot.success) return false;
      const px = firstPixel(Buffer.from(String(shot.result.image).replace(/^data:image\/png;base64,/, ''), 'base64'));
      return px[0] === expected[0] && px[1] === expected[1] && px[2] === expected[2];
    }, { timeout: 20_000, message: `la pestaña de la sesión ${s.key} no pintó su página` }).toBe(true);
  }

  const deadline = Date.now() + MINUTES * 60_000;
  let round = 0;
  while (Date.now() < deadline) {
    round++;
    const urlOf = (key: string) => `${harness.origin}/sesion-${key}?r=${round}`;
    // Interleaved: the three sessions fire their commands at once over the one connection, as
    // three MCP sessions do against the real server (which queues per browser).
    const results = await Promise.all(sessions.map(async s => {
      const url = urlOf(s.key);
      const nav = await harness.command('browser_navigate', { url, targetTabId: s.tabId });
      const state = await harness.command('browser_state', { targetTabId: s.tabId });
      const click = await harness.command('browser_click', { selector: '#plain', targetTabId: s.tabId });
      const typed = `R${round}-${s.key}`;
      const type = await harness.command('browser_type', { selector: '#plain', text: typed, clear: true, targetTabId: s.tabId });
      const shot = await harness.command('browser_screenshot', { targetTabId: s.tabId });
      return { s, url, nav, state, click, type, shot, typed };
    }));
    for (const r of results) {
      expect(r.nav.success, `navigate sesión ${r.s.key}`).toBe(true);
      expect(r.nav.result.navigated).toBe(r.url); // la URL del resultado es la de su sesión
      const live = await harness.worker.evaluate(async (id: number) => {
        const t = await chrome.tabs.get(id);
        return { url: t.url, title: t.title };
      }, r.s.tabId);
      expect(live.url).toBe(r.url);
      expect(live.title).toBe(`SESION-${r.s.key.toUpperCase()} r=${round}`);
      expect(r.state.success && String(r.state.result.state)).toContain('plain'); // snapshot of its own DOM
      expect(r.click.success && r.type.success).toBe(true);
      expect(await r.s.page.locator('#plain').inputValue()).toBe(r.typed); // lo escrito, en su campo
      const bytes = shotBytes(r.shot);
      expect(bytes.length, `captura de ${r.s.key}`).toBeGreaterThan(1000);
      const color = SESSIONS.find(x => x.key === r.s.key)!.color;
      expect(firstPixel(Buffer.from(bytes, 'base64'))).toEqual([...color]); // es SU página
      if (r.s.lastShot) expect(bytes).not.toBe(r.s.lastShot); // y cambia solo cuando cambia ella
      r.s.lastShot = bytes;
    }
    // The other sessions did not move: their tabs still hold their own last URL.
    for (const s of sessions) {
      const own = await harness.worker.evaluate(async (id: number) => (await chrome.tabs.get(id)).url, s.tabId);
      expect(own).toBe(urlOf(s.key));
    }
    const dani = await harness.daniState();
    expect(dani.activeTabId).toBe(harness.daniTabId);
    expect(dani.focusedWindowId).toBe(harness.baselineWindowId);
  }
  console.log(`[parallel-sessions] ${round} rondas x 3 sesiones en ${MINUTES} min, sin mezclas`);
});

test('C2 · invariante: agentActivations === 0 && agentFocusChanges === 0 durante la tanda paralela', async ({ harness, sessions }) => {
  expect(sessions.length, 'las sesiones de C1 siguen abiertas').toBe(3);
  const agentTabs = new Set(sessions.map(s => s.tabId));
  const agentWindows = new Set(sessions.map(s => s.windowId));
  const events = await harness.agentEvents();
  // Architect P5: windows.create activates its own tab inside its own window — that is not
  // stealing Dani's. Violations are events on anything the agent did not create.
  const agentActivations = events.filter(e => e.type === 'onActivated' && !agentTabs.has(e.tabId!));
  const agentFocusChanges = events.filter(e => e.type === 'onFocusChanged' && !agentWindows.has(e.windowId!));
  console.log(`[parallel-sessions] registro de eventos (${events.length}):\n${JSON.stringify(events, null, 1)}`);
  expect(agentActivations).toEqual([]);
  expect(agentFocusChanges).toEqual([]);
  const dani = await harness.daniState();
  expect(dani.activeTabId).toBe(harness.daniTabId); // la pestaña activa de Dani no cambió
  expect(dani.focusedWindowId).toBe(harness.baselineWindowId); // ni la ventana enfocada
});

test('C3 · screenshot-background: la captura de una pestaña de fondo con la ventana de Dani delante es la de su pestaña', async ({ harness, sessions }) => {
  test.setTimeout(120_000);
  const dani = await harness.daniState();
  expect(dani.focusedWindowId).toBe(harness.baselineWindowId); // Dani sigue delante: nadie la movió
  // The caret blinks: still the field so a static page captures byte-identical twice.
  for (const s of sessions) await s.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // Settle the page before comparing captures. The last C1 click left the extension's virtual
  // cursor (src/content/cursor.ts, INFRA-855) over the input: a DOM overlay that glides to each
  // action point and fades to opacity 0 after IDLE_HIDE_MS (2000) with a 300 ms transition. The
  // soak failure was exactly this: a capture mid-fade vs one after it — the only pixel diff was
  // the red arrow (#c96442, white stroke) over session b's input. Wait past the fade so "static"
  // really means idle, then the byte-equality below compares the page and nothing else.
  await new Promise(r => setTimeout(r, 2600));

  // Class guard: a static page must capture byte-identical twice, whatever the source of
  // non-determinism (a transient overlay still fading, a stale frame, a mid-repaint capture).
  // The before/after equality below would report such drift as "the capture is not its tab's",
  // which it is not: it is the capture not being stable. Fail here, with its own message.
  for (const s of sessions) {
    const first = await harness.command('browser_screenshot', { targetTabId: s.tabId });
    const second = await harness.command('browser_screenshot', { targetTabId: s.tabId });
    expect(shotBytes(second), `dos capturas seguidas de la sesión ${s.key}, página estática, difieren`).toBe(shotBytes(first));
  }

  const shots: Record<string, string> = {};
  for (const s of sessions) {
    const shot = await harness.command('browser_screenshot', { targetTabId: s.tabId });
    expect(shot.success).toBe(true);
    const bytes = shotBytes(shot);
    expect(bytes.length).toBeGreaterThan(1000);
    const color = SESSIONS.find(x => x.key === s.key)!.color;
    expect(firstPixel(Buffer.from(bytes, 'base64'))).toEqual([...color]); // coincide con la página esperada
    shots[s.key] = bytes;
  }
  expect(new Set(Object.values(shots)).size).toBe(3); // tres imágenes distintas, no tres copias

  // Moving only session A changes only A's capture: the capture tracks its own tab.
  const before = { ...shots };
  const moved = `${harness.origin}/sesion-a?r=777`;
  const nav = await harness.command('browser_navigate', { url: moved, targetTabId: sessions[0].tabId });
  expect(nav.success).toBe(true);
  const after = { ...shots };
  for (const s of sessions) {
    const shot = await harness.command('browser_screenshot', { targetTabId: s.tabId });
    after[s.key] = shotBytes(shot);
  }
  expect(after.a).not.toBe(before.a);
  expect(after.b).toBe(before.b);
  expect(after.c).toBe(before.c);
});
