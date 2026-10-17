import { describe, expect, it, vi } from 'vitest';
import { createQueryHandlers } from '@/background/tools/handlers/queries';
import type { HandlerContext } from '@/background/tools/handlers';
import { schemas } from '@/background/tools/schemas';
import { agentTools } from '@/background/agent/tools-catalog';
import { secretFlow } from '../helpers/secret-flow';
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
  it('rejects unsupported regex before a content request', async () => {
    const { ctx, run } = handlerFor({ ok: true, value: CANARY });
    await expect(run({ regex: '(x)\\1' })).rejects.toMatchObject({ name: 'SECRET_REGEX_INVALID' });
    expect(ctx.sendToContent).not.toHaveBeenCalled();
  });

  it('closes unknown results and transport errors without echoing their content', async () => {
    for (const answer of [null, { ok: false, code: CANARY }, { ok: true, value: {} }]) {
      const { run } = handlerFor(answer);
      await expect(run({ selector: '#semilla' })).rejects.toMatchObject({ name: 'SECRET_NO_MATCH', message: 'No element matches the selector' });
    }
    const { ctx, run } = handlerFor(null);
    ctx.sendToContent.mockRejectedValueOnce(new Error(CANARY));
    await expect(run({ ref: 'f3:s1e42' })).rejects.toMatchObject({ name: 'SECRET_NO_MATCH', message: 'No element matches the selector' });
    expect(ctx.resolveTarget).not.toHaveBeenCalled();
  });
  it('turns the content script answer into {value} and nothing else', async () => {
    const { ctx, run } = handlerFor({ ok: true, value: CANARY, extra: DECOY });
    await expect(run({ selector: '#semilla', regex: '(C.+)' })).resolves.toEqual({ value: CANARY });
    expect(ctx.sendToContent).toHaveBeenCalledWith('readSecret', { ref: undefined, selector: '#semilla', regex: '(C.+)' }, 0);
  });

  it('reads a ref in the frame it lives in', async () => {
    const { ctx, run } = handlerFor({ ok: true, value: CANARY });
    await run({ ref: 'f3:12' });
    expect(ctx.sendToContent).toHaveBeenCalledWith('readSecret', { ref: '12', selector: undefined, regex: undefined }, 3);
  });

  it('with only a regex it asks the top frame and resolves no element', async () => {
    const { ctx, run } = handlerFor({ ok: true, value: CANARY });
    await run({ regex: 'CANARY-(.+)' });
    expect(ctx.resolveTarget).not.toHaveBeenCalled();
    expect(ctx.sendToContent).toHaveBeenCalledWith('readSecret', { ref: undefined, selector: undefined, regex: 'CANARY-(.+)' }, 0);
  });

  it.each([
    [{ code: 'SECRET_NO_MATCH' }, 'No element matches the selector'],
    [{ code: 'SECRET_AMBIGUOUS', count: 3 }, 'Multiple elements match the selector'],
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


describe('internal read boundaries', () => {
  it('never advertises an internal reader even when a plugin announces it', () => {
    const reader = { type: 'function' as const, function: { name: 'browser_read_secret', description: 'internal', parameters: {} } };
    expect(agentTools(false, 'auto', [reader]).map(t => t.function.name)).not.toContain('browser_read_secret');
  });
  it('pins the tab before reading and removes remote content from errors', async () => {
    const success = secretFlow({ ok: true, value: CANARY });
    expect(await success.readSecret({ selector: '#semilla' })).toMatchObject({ success: true, result: { value: CANARY } });
    expect(success.sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({ action: 'readSecret' }), expect.anything());
    const failed = secretFlow({ ok: false, code: CANARY });
    const reply = await failed.readSecret({ selector: '#semilla' });
    expect(reply).toMatchObject({ success: false, error: { code: 'SECRET_NO_MATCH' } });
    expect(JSON.stringify(reply)).not.toContain(CANARY);
  });
});
