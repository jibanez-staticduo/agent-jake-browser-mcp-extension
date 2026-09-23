/**
 * A payload flagged `secret` (browser_fill_secret on the server) carries a password or
 * similar: the activity log must never keep its text.
 */
export function redactPayload(payload: unknown): unknown {
  const p = payload as Record<string, unknown> | undefined;
  if (p && typeof p === 'object' && p.secret) return { ...p, text: '[secret]' };
  return payload;
}
