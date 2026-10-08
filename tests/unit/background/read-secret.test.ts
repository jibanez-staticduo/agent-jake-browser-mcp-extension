import { describe, expect, it, vi } from 'vitest';
import { createQueryHandlers } from '@/background/tools/handlers/queries';
import type { HandlerContext } from '@/background/tools/handlers';
import { schemas } from '@/background/tools/schemas';
import { CANARY, DECOY } from '../helpers/secret-flow';

function handlerFor(answer: unknown) {
  const ctx = {
    sendToContent: vi.fn(async () => answer),
    resolveTarget: vi.fn(async (t: { ref?: string; selector?: string }) =>
      t.ref ? { frameId: 3, selector: '[data-hx="12"]' } : { frameId: 0, selector: t.selector as string }),
  };
  return { ctx, run: createQueryHandlers(ctx as unknown as HandlerContext).browser_read_secret };
}

describe('browser_read_secret handler', () => {
  it('turns the content script answer into {value} and nothing else', async () => {
    const { ctx, run } = handlerFor({ ok: true, value: CANARY, extra: DECOY });
    await expect(run({ selector: '#semilla', regex: '(C.+)' })).resolves.toEqual({ value: CANARY });
    expect(ctx.sendToContent).toHaveBeenCalledWith('readSecret', { selector: '#semilla', regex: '(C.+)' }, 0);
  });

  it('reads a ref in the frame it lives in', async () => {
    const { ctx, run } = handlerFor({ ok: true, value: CANARY });
    await run({ ref: 'f3:12' });
    expect(ctx.sendToContent).toHaveBeenCalledWith('readSecret', { selector: '[data-hx="12"]', regex: undefined }, 3);
  });

  it('with only a regex it asks the top frame and resolves no element', async () => {
    const { ctx, run } = handlerFor({ ok: true, value: CANARY });
    await run({ regex: 'CANARY-(.+)' });
    expect(ctx.resolveTarget).not.toHaveBeenCalled();
    expect(ctx.sendToContent).toHaveBeenCalledWith('readSecret', { selector: undefined, regex: 'CANARY-(.+)' }, 0);
  });

  it.each([
    [{ code: 'SECRET_NO_MATCH' }, 'No element matches the selector'],
    [{ code: 'SECRET_AMBIGUOUS', count: 3 }, '3 elements match the selector'],
    [{ code: 'SECRET_EMPTY' }, 'The element has no text'],
    [{ code: 'SECRET_REGEX_INVALID' }, 'The regex is not valid or has no capture group'],
    [{ code: 'SECRET_REGEX_NO_MATCH' }, 'The regex did not match'],
    [{ code: 'SECRET_TOO_LARGE' }, 'The text is too large'],
  ])('throws %j as an Error named after the code with the fixed text', async (failure, message) => {
    // The page text is planted in every field of the answer: none of it may reach the Error.
    const { run } = handlerFor({ ok: false, ...failure, text: CANARY, detail: DECOY });
    const error = await run({ selector: '#semilla' }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe(failure.code);
    expect((error as Error).message).toBe(message);
    expect(JSON.stringify([(error as Error).name, (error as Error).message])).not.toContain(CANARY);
  });
});

describe('schemas.browser_read_secret', () => {
  const ok = (p: unknown) => schemas.browser_read_secret.safeParse(p).success;

  it('needs a ref, a selector or a regex', () => {
    expect(ok({})).toBe(false);
    expect(ok({ ref: 's1e4' })).toBe(true);
    expect(ok({ selector: '#semilla' })).toBe(true);
    expect(ok({ regex: 'a-(b)' })).toBe(true);
  });

  it('caps the regex at 256 characters and refuses an empty one', () => {
    expect(ok({ regex: `(${'a'.repeat(254)})` })).toBe(true);
    expect(ok({ regex: `(${'a'.repeat(255)})` })).toBe(false);
    expect(ok({ regex: '' })).toBe(false);
    expect(ok({ selector: '#semilla', regex: '' })).toBe(false);
  });
});
