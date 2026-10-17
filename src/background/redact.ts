/**
 * A payload flagged `secret` (browser_fill_secret on the server) carries a password or
 * similar: the activity log must never keep its text.
 */
export function redactPayload(payload: unknown, type?: string): unknown {
  if (type === 'browser_read_secret') return { secret: true };
  const p = payload as Record<string, unknown> | undefined;
  if (p && typeof p === 'object' && p.secret) return { ...p, text: '[secret]' };
  return payload;
}

export function redactResult(type: string, result: unknown): unknown {
  return type === 'browser_read_secret' ? { value: '[secret]' } : result;
}
