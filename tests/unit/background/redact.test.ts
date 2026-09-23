import { describe, it, expect } from 'vitest';
import { redactPayload } from '@/background/redact';

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
