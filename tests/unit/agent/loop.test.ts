import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { runAgent, completionsUrl, parseArgs, AgentStopped, type AgentDeps } from '@/background/agent/loop';
import { AGENT_TOOLS, SCREENSHOT_TOOL, agentTools } from '@/background/agent/tools-catalog';
import { formatPageContext, truncate } from '@/background/agent/context';
import { DEFAULT_COPILOT_SETTINGS, type WorkerToPanel } from '@/types/copilot';

const settings = { ...DEFAULT_COPILOT_SETTINGS, apiKey: 'sk-test', maxSteps: 5 };

function reply(message: Record<string, unknown>) {
  return new Response(JSON.stringify({ choices: [{ message }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function toolCall(id: string, name: string, args: unknown) {
  return { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

function makeDeps(replies: Response[], overrides: Partial<AgentDeps> = {}) {
  const events: WorkerToPanel[] = [];
  const bodies: { messages: { role: string; content: unknown }[]; tools: { function: { name: string } }[] }[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const next = replies.shift();
    if (!next) throw new Error('no more replies');
    return next;
  });
  const deps: AgentDeps = {
    fetch: fetchMock as unknown as typeof fetch,
    execTool: vi.fn(async () => ({ ok: true, result: { clicked: true } })),
    getContext: async () => '<page_context>Target tab: [7] Example</page_context>',
    emit: (e) => events.push(e),
    signal: new AbortController().signal,
    ...overrides,
  };
  return { deps, events, bodies, fetchMock };
}

describe('copilot agent loop', () => {
  it('runs tool call → result → final answer', async () => {
    const { deps, events, bodies, fetchMock } = makeDeps([
      reply(toolCall('c1', 'browser_click', { ref: '12' })),
      reply({ role: 'assistant', content: 'Hecho: pulsé el botón.' }),
    ]);

    const text = await runAgent([{ role: 'user', content: 'hola' }, { role: 'assistant', content: 'hey' }], 'pulsa comprar', settings, deps);

    expect(text).toBe('Hecho: pulsé el botón.');
    expect(deps.execTool).toHaveBeenCalledWith('browser_click', { ref: '12' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://litellm.lan.e-dani.com/v1/chat/completions');
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-test' });

    // First request: system + history + prompt carrying the page context.
    const first = bodies[0].messages;
    expect(first.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(first[3].content).toContain('<page_context>');
    expect(first[3].content).toContain('pulsa comprar');

    // Second request carries the tool result.
    const second = bodies[1].messages;
    expect(second.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: '{"clicked":true}' });

    expect(events.map((e) => e.type)).toEqual(['step', 'tool_call', 'tool_result', 'step', 'assistant']);
  });

  it('reports tool errors to the model instead of failing', async () => {
    const { deps, bodies, events } = makeDeps([
      reply(toolCall('c1', 'browser_click', { ref: 'zz' })),
      reply({ role: 'assistant', content: 'No encontré el elemento.' }),
    ], { execTool: vi.fn(async () => ({ ok: false, error: 'Ref not found' })) });

    await runAgent([], 'x', settings, deps);

    expect(bodies[1].messages.at(-1)).toMatchObject({ role: 'tool', content: 'Error: Ref not found' });
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false, summary: 'Ref not found' });
  });

  it('survives malformed tool arguments', async () => {
    const bad = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'browser_click', arguments: '{nope' } }] };
    const { deps, bodies } = makeDeps([reply(bad), reply({ role: 'assistant', content: 'ok' })]);

    await runAgent([], 'x', settings, deps);

    expect(deps.execTool).not.toHaveBeenCalled();
    expect(String(bodies[1].messages.at(-1)?.content)).toMatch(/^Error: /);
  });

  it('stops at maxSteps', async () => {
    const replies = Array.from({ length: 3 }, (_, i) => reply(toolCall(`c${i}`, 'browser_state', {})));
    const { deps, fetchMock } = makeDeps(replies);

    const text = await runAgent([], 'loop', { ...settings, maxSteps: 3 }, deps);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(text).toMatch(/Stopped after 3 steps/);
  });

  it('aborts between tools', async () => {
    const controller = new AbortController();
    const { deps } = makeDeps([reply(toolCall('c1', 'browser_click', { ref: '1' }))], {
      signal: controller.signal,
      execTool: vi.fn(async () => {
        controller.abort();
        return { ok: true, result: {} };
      }),
    });

    await expect(runAgent([], 'x', settings, deps)).rejects.toBeInstanceOf(AgentStopped);
  });

  it('maps a fetch AbortError to AgentStopped', async () => {
    const { deps } = makeDeps([], {
      fetch: (async () => {
        throw new DOMException('aborted', 'AbortError');
      }) as unknown as typeof fetch,
    });
    await expect(runAgent([], 'x', settings, deps)).rejects.toBeInstanceOf(AgentStopped);
  });

  it('surfaces HTTP errors from the LLM', async () => {
    const { deps } = makeDeps([new Response('bad key', { status: 401 })]);
    await expect(runAgent([], 'x', settings, deps)).rejects.toThrow('LLM 401: bad key');
  });

  it('attaches screenshots as an image message when vision is on', async () => {
    const { deps, bodies } = makeDeps([
      reply(toolCall('c1', 'browser_screenshot', {})),
      reply({ role: 'assistant', content: 'veo un formulario' }),
    ], { execTool: vi.fn(async () => ({ ok: true, result: { image: 'data:image/png;base64,AAAA' } })) });

    await runAgent([], 'mira', { ...settings, vision: true }, deps);

    expect(bodies[0].tools.map((t) => t.function.name)).toContain('browser_screenshot');
    const last = bodies[1].messages.at(-1) as { role: string; content: { type: string; image_url?: { url: string } }[] };
    expect(last.role).toBe('user');
    expect(last.content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
  });

  it('does not offer screenshots without vision', async () => {
    const { deps, bodies } = makeDeps([reply({ role: 'assistant', content: 'ok' })]);
    await runAgent([], 'x', settings, deps);
    expect(bodies[0].tools.map((t) => t.function.name)).not.toContain('browser_screenshot');
  });
});

describe('helpers', () => {
  it('builds the completions URL', () => {
    expect(completionsUrl('https://h/v1/')).toBe('https://h/v1/chat/completions');
    expect(completionsUrl('https://h/v1/chat/completions')).toBe('https://h/v1/chat/completions');
  });

  it('parses string and object arguments', () => {
    expect(parseArgs('{"a":1}')).toEqual({ a: 1 });
    expect(parseArgs({ a: 1 })).toEqual({ a: 1 });
    expect(parseArgs('')).toEqual({});
  });
});

describe('page context', () => {
  const tabs = [
    { id: 1, url: 'https://a.test/', title: 'A', active: false, connected: false },
    { id: 2, url: 'https://b.test/x', title: 'B', active: true, connected: true },
  ];

  it('marks the target tab and includes the state', () => {
    const text = formatPageContext({ tabs, targetTabId: 2, state: '[1] button "Buy"' });
    expect(text).toContain('Target tab: [2] B — https://b.test/x');
    expect(text).toContain('- [2] (target,active) B');
    expect(text).toContain('[1] button "Buy"');
  });

  it('truncates a large state', () => {
    const text = formatPageContext({ tabs, targetTabId: 2, state: 'x'.repeat(100), maxChars: 10 });
    expect(text).toContain('…[truncated 90 chars]');
  });

  it('reports an unreadable tab', () => {
    const text = formatPageContext({ tabs, targetTabId: 2, state: null, stateError: 'Cannot access chrome:// URL' });
    expect(text).toContain('Target tab state unavailable: Cannot access chrome:// URL');
  });

  it('truncate is a no-op under the limit', () => {
    expect(truncate('abc', 5)).toBe('abc');
  });
});

describe('tool catalog', () => {
  // Every tool offered to the model must exist as a handler key in tools/handlers.
  const dir = resolve(__dirname, '../../../src/background/tools/handlers');
  const source = readdirSync(dir).map((f) => readFileSync(resolve(dir, f), 'utf8')).join('\n');

  it.each([...AGENT_TOOLS, SCREENSHOT_TOOL].map((t) => t.function.name))('%s has a handler', (name) => {
    expect(source).toMatch(new RegExp(`\\b${name}: async`));
  });

  it('has unique names', () => {
    const names = agentTools(true).map((t) => t.function.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
