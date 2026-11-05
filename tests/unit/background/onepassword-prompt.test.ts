import { describe, expect, it } from 'vitest';
import { findUsePasskeyButton } from '@/background/onepassword-prompt';

const WHITE = [255, 255, 255];
const BUTTON_BLUE = [5, 100, 230];
const FRINGE = [120, 160, 215]; // sub-pixel fringe of dark text: bluish, sparse
const LOGO_BLUE = [26, 140, 255];

/** A white capture with the prompt as measured on the x86 on 05-11 (viewport 1672 px, DPR 1). */
function capture(width: number, height: number, paint: (set: (x: number, y: number, rgb: number[]) => void) => void) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const set = (x: number, y: number, [r, g, b]: number[]) => {
    const i = (y * width + x) * 4;
    rgba.set([r, g, b, 255], i);
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) set(x, y, WHITE);
  paint(set);
  return rgba;
}

function rect(set: (x: number, y: number, rgb: number[]) => void, x0: number, y0: number, w: number, h: number, rgb: number[], every = 1) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x += every) set(x, y, rgb);
}

describe('findUsePasskeyButton', () => {
  const W = 1672;
  const H = 110;

  it('finds the blue «Use passkey» right of the centre, not the logo or the text fringes', () => {
    const rgba = capture(W, H, (set) => {
      rect(set, 650, 30, 24, 24, LOGO_BLUE);           // 1Password logo / Google G, left of the centre
      rect(set, 790, 36, 60, 14, FRINGE, 9);            // account text fringes, crossing the centre
      rect(set, 860, 38, 110, 14, BUTTON_BLUE, 2);      // «Use passkey»: icon + text, letter gaps
    });
    const point = findUsePasskeyButton(rgba, W, H, 1);
    expect(point).not.toBeNull();
    expect(point!.x).toBeGreaterThanOrEqual(905);
    expect(point!.x).toBeLessThanOrEqual(920);
    expect(point!.y).toBeGreaterThanOrEqual(42);
    expect(point!.y).toBeLessThanOrEqual(48);
  });

  it('scales with the device pixel ratio', () => {
    const rgba = capture(W * 2, H * 2, (set) => rect(set, 1720, 76, 220, 28, BUTTON_BLUE, 2));
    const point = findUsePasskeyButton(rgba, W * 2, H * 2, 2);
    expect(point).toEqual({ x: 1829, y: 90 });
  });

  it('answers null when there is no prompt', () => {
    expect(findUsePasskeyButton(capture(W, H, () => undefined), W, H, 1)).toBeNull();
  });

  it('answers null for a wide blue bar: a page banner is not the button', () => {
    const rgba = capture(W, H, (set) => rect(set, 836, 60, 260, 4, BUTTON_BLUE));
    expect(findUsePasskeyButton(rgba, W, H, 1)).toBeNull();
  });

  it('answers null for a few stray blue pixels', () => {
    const rgba = capture(W, H, (set) => rect(set, 900, 40, 3, 3, BUTTON_BLUE));
    expect(findUsePasskeyButton(rgba, W, H, 1)).toBeNull();
  });
});
