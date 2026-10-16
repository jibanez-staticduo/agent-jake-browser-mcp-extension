import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { readSecret } from '@/content/read-secret';
import { CANARY, DECOY } from '../helpers/secret-flow';
import { getCurrentSnapshot, getElementByRef } from '@/content/aria-tree';

vi.mock('@/content/aria-tree', () => ({ getCurrentSnapshot: vi.fn(), getElementByRef: vi.fn() }));

/**
 * The node test environment has no DOM: this reads the elements of the real fixture
 * (tag, id, class, text, value) and answers the selectors the tests use (`#id`, `.class`,
 * comma lists). Anything else is a syntax error, like an invalid selector in a page.
 */
function fixtureDoc(html = readFileSync(new URL('../../fixtures/fixture-secreto.html', import.meta.url), 'utf8')) {
  const els = [...html.matchAll(/<(h1|p|code|span|input)\b([^>]*)>(?:([^<]*)<\/\1>)?/g)].map(([, tag, attrs, text = '']) => ({
    tagName: tag.toUpperCase(),
    id: /\bid="([^"]*)"/.exec(attrs)?.[1],
    classes: (/\bclass="([^"]*)"/.exec(attrs)?.[1] ?? '').split(' '),
    value: /\bvalue="([^"]*)"/.exec(attrs)?.[1] ?? '',
    textContent: text,
  }));
  return {
    querySelectorAll(selector: string) {
      if (/[^\w#.,\s-]/.test(selector)) throw new SyntaxError('invalid selector');
      const parts = selector.split(',').map((s) => s.trim());
      return els.filter((e) => parts.some((p) => (p.startsWith('#') ? e.id === p.slice(1)
        : p.startsWith('.') ? e.classes.includes(p.slice(1)) : e.tagName === p.toUpperCase())));
    },
    body: { innerText: els.filter((e) => e.tagName !== 'INPUT').map((e) => e.textContent).join('\n') },
  } as unknown as Document;
}

const read = (payload: { selector?: string; regex?: string }, doc: Document = fixtureDoc()) => readSecret(payload, doc);
const oneElement = (textContent: string) => ({
  querySelectorAll: () => [{ tagName: 'P', textContent }],
  body: { innerText: '' },
}) as unknown as Document;

describe('readSecret: the value', () => {
  it('reads a snapshot element identity without querying a CSS decoy', () => {
    const doc = fixtureDoc();
    const query = vi.spyOn(doc, 'querySelectorAll');
    vi.mocked(getCurrentSnapshot).mockReturnValue({} as never);
    vi.mocked(getElementByRef).mockReturnValue({ tagName: 'INPUT', value: CANARY, isConnected: true, ownerDocument: doc } as unknown as Element);
    expect(readSecret({ ref: 's1e42' }, doc)).toEqual({ ok: true, value: CANARY });
    expect(query).not.toHaveBeenCalled();
    vi.mocked(getElementByRef).mockReturnValue(null);
    expect(readSecret({ ref: 's1e42' }, doc)).toEqual({ ok: false, code: 'SECRET_NO_MATCH' });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects unsupported patterns before reading any page data', () => {
    const doc = fixtureDoc();
    const query = vi.spyOn(doc, 'querySelectorAll');
    for (const regex of ['(x)\\1', '(?=x)(x)', '(?<=x)(x)', '(']) {
      expect(read({ selector: '#semilla', regex }, doc)).toEqual({ ok: false, code: 'SECRET_REGEX_INVALID' });
    }
    expect(query).not.toHaveBeenCalled();
  });
  it('returns the trimmed text of the element and nothing else', () => {
    const result = read({ selector: '#semilla' });
    expect(result).toEqual({ ok: true, value: CANARY });
    expect(Object.keys(result)).toEqual(['ok', 'value']);
  });

  it('reads the value of an input, not its text', () => {
    expect(read({ selector: '#campo' })).toEqual({ ok: true, value: CANARY });
  });

  it('returns group 1 of the regex over the element text', () => {
    expect(read({ selector: '#semilla', regex: 'CANARY-(SEED-[0-9A-F]+)' })).toEqual({ ok: true, value: 'SEED-7F3A9C21' });
  });

  it('with only a regex, runs it over the page text', () => {
    expect(read({ regex: 'CANARY-(SEED-[0-9A-F]+)' })).toEqual({ ok: true, value: 'SEED-7F3A9C21' });
  });
});

describe('readSecret: errors name the code and never carry the value or the page text', () => {
  const cases: Array<[string, { selector?: string; regex?: string }, Document | undefined, object]> = [
    ['no element', { selector: '#no-existe' }, undefined, { ok: false, code: 'SECRET_NO_MATCH' }],
    ['invalid CSS selector', { selector: '#semilla(' }, undefined, { ok: false, code: 'SECRET_NO_MATCH' }],
    ['two elements', { selector: '#semilla, .dup' }, undefined, { ok: false, code: 'SECRET_AMBIGUOUS' }],
    ['empty element', { selector: '#vacio' }, undefined, { ok: false, code: 'SECRET_EMPTY' }],
    ['regex that does not compile', { selector: '#semilla', regex: '(' }, undefined, { ok: false, code: 'SECRET_REGEX_INVALID' }],
    ['regex without a capture group', { selector: '#semilla', regex: 'CANARY' }, undefined, { ok: false, code: 'SECRET_REGEX_INVALID' }],
    ['regex that does not match', { selector: '#semilla', regex: 'NADA-(\\d+)' }, undefined, { ok: false, code: 'SECRET_REGEX_NO_MATCH' }],
    ['regex whose group 1 is empty', { selector: '#semilla', regex: 'CANARY-(X*)' }, undefined, { ok: false, code: 'SECRET_REGEX_NO_MATCH' }],
    ['only a regex that does not match', { regex: 'NADA-(\\d+)' }, undefined, { ok: false, code: 'SECRET_REGEX_NO_MATCH' }],
    ['value over 4096 characters', { selector: 'p' }, oneElement(`${CANARY}${'x'.repeat(4096)}`), { ok: false, code: 'SECRET_TOO_LARGE' }],
    ['text over 65536 characters', { selector: 'p', regex: `(${CANARY})` }, oneElement(`${CANARY}${' '.repeat(65536)}`), { ok: false, code: 'SECRET_TOO_LARGE' }],
    ['regex group over 4096 characters', { selector: 'p', regex: '(x+)' }, oneElement('x'.repeat(4097)), { ok: false, code: 'SECRET_TOO_LARGE' }],
  ];

  it.each(cases)('%s', (_name, payload, doc, expected) => {
    const result = read(payload, doc);
    expect(result).toEqual(expected);
    const json = JSON.stringify(result);
    expect(json).not.toContain(CANARY);
    expect(json).not.toContain(DECOY);
  });
});
