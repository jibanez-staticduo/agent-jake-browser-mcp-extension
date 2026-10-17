import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Rule of the panel: informative text is >= 4.5:1 on every background, in each published theme. */
const css = readFileSync('src/popup/styles/variables.css', 'utf8');
const darkStart = css.indexOf('prefers-color-scheme: dark');

function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/(--[a-z-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
}
const light = tokens(css.slice(0, darkStart));
const dark = { ...light, ...tokens(css.slice(darkStart)) };

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

const TEXT = ['--text-primary', '--text-secondary', '--text-tertiary', '--accent-primary', '--accent-success', '--accent-warning', '--accent-danger'];
const BG = ['--bg-deepest', '--bg-deep', '--bg-surface', '--bg-elevated'];

describe.each([['dark', dark], ['light', light]])('%s theme contrast', (_name, theme) => {
  for (const t of TEXT) {
    for (const b of BG) {
      it(`${t} on ${b} is >= 4.5:1`, () => {
        expect(ratio(theme[t], theme[b])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
