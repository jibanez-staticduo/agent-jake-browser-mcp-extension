import { describe, it, expect } from 'vitest';
import { redactPayload, redactResult } from '@/background/redact';
import { CANARY } from '../helpers/secret-flow';

describe('redactPayload', () => {
  it('drops the text of a payload flagged secret', () => {
    expect(redactPayload({ ref: 'e5', text: 'hunter2', secret: true })).toEqual({ ref: 'e5', text: '[secret]', secret: true });
  });
  it('leaves normal payloads untouched', () => {
    const p = { ref: 'e5', text: 'hello' };
    expect(redactPayload(p)).toBe(p);
    expect(redactPayload(undefined)).toBeUndefined();
  });
});

describe('redactResult', () => {
  it('drops the value browser_read_secret returns', () => {
    const redacted = redactResult('browser_read_secret', { value: CANARY });
    expect(JSON.stringify(redacted)).not.toContain(CANARY);
  });
  it('leaves the result of any other tool untouched', () => {
    const result = { value: CANARY };
    expect(redactResult('browser_get_text', result)).toBe(result);
    expect(redactResult('browser_fill_form', undefined)).toBeUndefined();
  });
});
