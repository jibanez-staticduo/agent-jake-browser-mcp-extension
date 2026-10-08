/**
 * A payload flagged `secret` (browser_fill_secret on the server) carries a password or
 * similar: the activity log must never keep its text.
 */
export function redactPayload(payload: unknown): unknown {
  const p = payload as Record<string, unknown> | undefined;
  if (p && typeof p === 'object' && p.secret) return { ...p, text: '[secret]' };
  return payload;
}

/**
 * What the activity log may keep of a tool's result. browser_read_secret returns the value
 * it read from the page: the log never gets it (activity-log.ts drops results too; this is
 * the second wall, at the place where the result is handed over).
 */
export function redactResult(type: string, result: unknown): unknown {
  return type === 'browser_read_secret' ? { value: '[secret]' } : result;
}
