import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// INFRA-699: chrome.scripting.executeScript waits for document_idle unless it is told to inject
// immediately, and a page that never finishes loading never gets there. One call without the flag
// hangs every command that passes through it (state, switch_tab, close_tab, new_tab...) until the
// server cuts it at 30 s. The behaviour tests in tab-manager.test.ts cover the call sites that
// exist; this one covers the next one somebody adds.
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|vue)$/.test(name) ? [path] : [];
  });
}

/** The call whose "(" is at `open`, up to its matching ")". */
function callAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

describe('chrome.scripting.executeScript', () => {
  it('injects immediately everywhere in src', () => {
    const offenders: string[] = [];
    let calls = 0;
    for (const file of sources('src')) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/scripting\.executeScript\(/g)) {
        calls++;
        const open = match.index! + match[0].length - 1;
        if (!callAt(text, open).includes('injectImmediately: true')) {
          offenders.push(`${file}:${text.slice(0, match.index).split('\n').length}`);
        }
      }
    }
    expect(calls).toBeGreaterThan(0); // the scan found the calls it is about
    expect(offenders).toEqual([]);
  });
});
