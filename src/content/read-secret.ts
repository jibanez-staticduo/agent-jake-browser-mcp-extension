/**
 * Content-script side of the internal message browser_read_secret (SC-2102).
 *
 * It answers with the value or with a code from a closed set, and nothing else: no error
 * here carries the value or any text of the page. Untrusted patterns use RE2's linear-time
 * engine, never the browser's backtracking RegExp engine.
 */
import { RE2JS } from 're2js';
import { getElementByRef, getCurrentSnapshot } from './aria-tree';

export type SecretCode =
  | 'SECRET_NO_MATCH'
  | 'SECRET_AMBIGUOUS'
  | 'SECRET_EMPTY'
  | 'SECRET_REGEX_INVALID'
  | 'SECRET_REGEX_NO_MATCH'
  | 'SECRET_TOO_LARGE';

export type ReadSecretResult = { ok: true; value: string } | { ok: false; code: SecretCode };

const MAX_TEXT = 65_536;
const MAX_VALUE = 4_096;

export function readSecret(payload: { ref?: string; selector?: string; regex?: string }, doc: Document = document): ReadSecretResult {
  const fail = (code: SecretCode): ReadSecretResult => ({ ok: false, code });

  let re: RE2JS | undefined;
  if (payload.regex !== undefined) {
    try {
      if (!payload.regex.length || payload.regex.length > 256) return fail('SECRET_REGEX_INVALID');
      re = RE2JS.compile(payload.regex);
      if (re.groupCount() < 1) return fail('SECRET_REGEX_INVALID');
    } catch {
      return fail('SECRET_REGEX_INVALID');
    }
  }

  let text: string;
  if (payload.selector || payload.ref) {
    let found: ArrayLike<Element>;
    try {
      if (payload.ref && !/^\d+$/.test(payload.ref)) {
        // Use the snapshot's element identity; a CSS reconstruction can target a decoy.
        const el = getCurrentSnapshot() && getElementByRef(payload.ref);
        found = el && el.isConnected && el.ownerDocument === doc ? [el] : [];
      } else {
        found = doc.querySelectorAll(payload.ref ? `[data-hx="${payload.ref}"]` : payload.selector!);
      }
    } catch {
      return fail('SECRET_NO_MATCH'); // a selector that does not parse matches nothing
    }
    if (!found.length) return fail('SECRET_NO_MATCH');
    if (found.length > 1) return fail('SECRET_AMBIGUOUS');
    const el = found[0];
    text = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ? (el as HTMLInputElement).value : el.textContent ?? '';
  } else {
    text = doc.body?.innerText ?? '';
  }

  if (text.length > MAX_TEXT) return fail('SECRET_TOO_LARGE');
  text = text.trim();
  if (!text) return fail('SECRET_EMPTY');

  let value = text;
  if (re) {
    const matcher = re.matcher(text);
    value = matcher.find() ? matcher.group(1)?.trim() ?? '' : '';
    if (!value) return fail('SECRET_REGEX_NO_MATCH');
  }

  return value.length > MAX_VALUE ? fail('SECRET_TOO_LARGE') : { ok: true, value };
}
