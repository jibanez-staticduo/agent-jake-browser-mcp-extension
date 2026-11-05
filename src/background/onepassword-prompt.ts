/**
 * 1Password's «Use passkey» prompt (INFRA-374). 1Password signs a passkey only after a trusted
 * click on it, and the prompt is a frame of ITS extension: Chrome refuses every debugger command
 * while it is in the page, and its handlers drop synthetic events (`isTrusted`). So the click is a
 * real one from the x86's native host (`agent-jake-click.py`, installed by agent-browser-sync), at
 * a point found here in a capture of the same ceremony — security's condition 2 of INFRA-1171.
 */

/** The native messaging host that makes the click (x86-host-runtime). */
export const ONEPASSWORD_CLICK_HOST = 'com.pocharlies.agent_jake_click';

/** 1Password's universal sign-on prompt: a closed shadow root, so we only see its host element. */
export const ONEPASSWORD_PROMPT_ELEMENT = 'com-1password-uso';

/** The prompt sits at the very top of the viewport (measured 05-11: button ~45 CSS px down). */
const PROMPT_BAND_CSS_PX = 110;
/** It is centred; the button is right of the centre, the account and logo left of it. */
const PROMPT_HALF_WIDTH_CSS_PX = 260;
/** Columns closer than this belong to the same blob (the gaps between letters). */
const CLUSTER_GAP_CSS_PX = 8;
/** «Use passkey» is ~60 CSS px wide with its icon; anything much wider is not the button. */
const BUTTON_MAX_WIDTH_CSS_PX = 170;
/** Below this the blob is anti-aliasing fringe of black text, not the button. */
const BUTTON_MIN_PIXELS = 12;

export interface PromptPoint {
  x: number;
  y: number;
}

/** The button's blue; text fringes of dark text are far less saturated. */
function isButtonBlue(r: number, g: number, b: number): boolean {
  return b >= 140 && b - r >= 70 && b - g >= 25;
}

/**
 * Where «Use passkey» is in the top band of a capture (captureTopBand): RGBA rows of `width`
 * device pixels, `height` rows. The densest cluster of blue columns right of the centre is the
 * button. Returns device pixels, or null when no blob looks like it.
 */
export function findUsePasskeyButton(rgba: Uint8ClampedArray, width: number, height: number, dpr: number): PromptPoint | null {
  const left = Math.floor(width / 2);
  const right = Math.min(width, left + Math.round(PROMPT_HALF_WIDTH_CSS_PX * dpr));
  const count = new Array<number>(right - left).fill(0);
  const rowSum = new Array<number>(right - left).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = left; x < right; x++) {
      const i = (y * width + x) * 4;
      if (isButtonBlue(rgba[i], rgba[i + 1], rgba[i + 2])) {
        count[x - left]++;
        rowSum[x - left] += y;
      }
    }
  }

  const gap = Math.round(CLUSTER_GAP_CSS_PX * dpr);
  interface Cluster { start: number; end: number; pixels: number; rows: number }
  let best: Cluster | null = null;
  let current: Cluster | null = null;
  for (let c = 0; c <= count.length; c++) {
    const n = c < count.length ? count[c] : 0;
    if (n > 0) {
      if (current && c - current.end <= gap) {
        current.end = c;
        current.pixels += n;
        current.rows += rowSum[c];
      } else {
        current = { start: c, end: c, pixels: n, rows: rowSum[c] };
      }
      if (!best || current.pixels > best.pixels) best = { ...current };
    }
  }
  if (!best || best.pixels < BUTTON_MIN_PIXELS) return null;
  if (best.end - best.start > BUTTON_MAX_WIDTH_CSS_PX * dpr) return null;
  return { x: left + Math.round((best.start + best.end) / 2), y: Math.round(best.rows / best.pixels) };
}

/** The visible tab of `windowId`, top band only: what findUsePasskeyButton reads, plus the full size. */
export async function captureTopBand(windowId: number, dpr: number): Promise<{
  rgba: Uint8ClampedArray; width: number; height: number; bandHeight: number;
}> {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const { width, height } = bitmap;
  const bandHeight = Math.min(height, Math.round(PROMPT_BAND_CSS_PX * dpr));
  const canvas = new OffscreenCanvas(width, bandHeight);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No 2D context to read the capture');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { rgba: context.getImageData(0, 0, width, bandHeight).data, width, height, bandHeight };
}
