/**
 * Content-script side of the internal message browser_read_secret (SC-2102).
 *
 * It answers with the value or with a code from a closed set, and nothing else: no error
 * here carries the value or any text of the page. The regex runs HERE, in the tab's own
 * process, so a catastrophic one hangs the tab and not the extension's service worker.
 */

export type SecretCode =
  | 'SECRET_NO_MATCH'
  | 'SECRET_AMBIGUOUS'
  | 'SECRET_EMPTY'
  | 'SECRET_REGEX_INVALID'
  | 'SECRET_REGEX_NO_MATCH'
  | 'SECRET_TOO_LARGE';

export type ReadSecretResult = { ok: true; value: string } | { ok: false; code: SecretCode; count?: number };

const MAX_TEXT = 65_536;
const MAX_VALUE = 4_096;

export function readSecret(payload: { selector?: string; regex?: string }, doc: Document = document): ReadSecretResult {
  const fail = (code: SecretCode, count?: number): ReadSecretResult => (count === undefined ? { ok: false, code } : { ok: false, code, count });

  let text: string;
  if (payload.selector) {
    let found: ArrayLike<Element>;
    try {
      found = doc.querySelectorAll(payload.selector);
    } catch {
      return fail('SECRET_NO_MATCH'); // a selector that does not parse matches nothing
    }
    if (!found.length) return fail('SECRET_NO_MATCH');
    if (found.length > 1) return fail('SECRET_AMBIGUOUS', found.length);
    const el = found[0];
    text = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ? (el as HTMLInputElement).value : el.textContent ?? '';
  } else {
    text = doc.body.innerText;
  }

  if (text.length > MAX_TEXT) return fail('SECRET_TOO_LARGE');
  text = text.trim();
  if (!text) return fail('SECRET_EMPTY');

  let value = text;
  if (payload.regex !== undefined) {
    let re: RegExp;
    try {
      re = new RegExp(payload.regex);
    } catch {
      return fail('SECRET_REGEX_INVALID');
    }
    // Appending an empty alternative makes the pattern match '': the match array then has one slot per group.
    if (new RegExp(`${payload.regex}|`).exec('')!.length < 2) return fail('SECRET_REGEX_INVALID');
    value = re.exec(text)?.[1]?.trim() ?? '';
    if (!value) return fail('SECRET_REGEX_NO_MATCH');
  }

  return value.length > MAX_VALUE ? fail('SECRET_TOO_LARGE') : { ok: true, value };
}
