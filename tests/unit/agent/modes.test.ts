import { describe, it, expect, vi } from 'vitest';
import { runAgent, readStream, normalizePlan, AgentStopped, type AgentDeps } from '@/background/agent/loop';
import { agentTools } from '@/background/agent/tools-catalog';
import { renderMarkdown } from '@/sidepanel/markdown';
import { chatModels, titleOf } from '@/sidepanel/chats';
import { DEFAULT_COPILOT_SETTINGS, type CopilotMode, type UserRequest, type UserResponse, type WorkerToPanel } from '@/types/copilot';

const base = { ...DEFAULT_COPILOT_SETTINGS, apiKey: 'k', maxSteps: 8 };

function json(message: Record<string, unknown>) {
  return new Response(JSON.stringify({ choices: [{ message }] }), { headers: { 'Content-Type': 'application/json' } });
}
function call(id: string, name: string, args: unknown) {
  return json({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
}
function final(text: string) {
  return json({ role: 'assistant', content: text });
}
function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

function setup(replies: Response[], answers: UserResponse[] = [], overrides: Partial<AgentDeps> = {}) {
  const events: WorkerToPanel[] = [];
  const requests: UserRequest[] = [];
  const bodies: { tools: { function: { name: string } }[]; messages: { role: string; content: unknown }[]; stream: boolean }[] = [];
  const deps: AgentDeps = {
    fetch: vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const r = replies.shift();
      if (!r) throw new Error('no more replies');
      return r;
    }) as unknown as typeof fetch,
    execTool: vi.fn(async (name: string) => ({ ok: true, result: { ran: name } })),
    getContext: async () => '<page_context/>',
    emit: (e) => events.push(e),
    signal: new AbortController().signal,
    requestUser: vi.fn(async (r: UserRequest) => {
      requests.push(r);
      const a = answers.shift();
      if (!a) throw new Error('no answer');
      return a;
    }),
    currentOrigin: async () => 'https://shop.test',
    isOriginAllowed: async () => false,
    allowOrigin: vi.fn(async () => {}),
    ...overrides,
  };
  return { deps, events, requests, bodies };
}

const run = (mode: CopilotMode, deps: AgentDeps) => runAgent([], 'go', { ...base, mode }, deps);

describe('ask mode', () => {
  it('runs read-only tools without asking', async () => {
    const { deps, requests } = setup([call('c1', 'browser_state', {}), final('ok')]);
    await run('ask', deps);
    expect(requests).toEqual([]);
    expect(deps.execTool).toHaveBeenCalledWith('browser_state', {});
  });

  it('asks before a page-changing tool and runs it when allowed', async () => {
    const { deps, requests } = setup([call('c1', 'browser_click', { ref: '3' }), final('ok')], [{ kind: 'approve', decision: 'allow' }]);
    await run('ask', deps);
    expect(requests[0]).toEqual({ kind: 'approve', tool: 'browser_click', args: { ref: '3' }, origin: 'https://shop.test' });
    expect(deps.execTool).toHaveBeenCalledWith('browser_click', { ref: '3' });
    expect(deps.allowOrigin).not.toHaveBeenCalled();
  });

  it('does not run a denied tool and tells the model', async () => {
    const { deps, bodies } = setup([call('c1', 'browser_click', { ref: '3' }), final('vale')], [{ kind: 'approve', decision: 'deny' }]);
    await run('ask', deps);
    expect(deps.execTool).not.toHaveBeenCalled();
    expect(bodies[1].messages.at(-1)).toMatchObject({ role: 'tool', content: 'Error: The user denied this action.' });
  });

  it('remembers "always on this site"', async () => {
    const { deps } = setup([call('c1', 'browser_click', { ref: '3' }), final('ok')], [{ kind: 'approve', decision: 'allow_site' }]);
    await run('ask', deps);
    expect(deps.allowOrigin).toHaveBeenCalledWith('https://shop.test');
    expect(deps.execTool).toHaveBeenCalled();
  });

  it('skips the question on an allowed site', async () => {
    const { deps, requests } = setup([call('c1', 'browser_click', { ref: '3' }), final('ok')], [], { isOriginAllowed: async () => true });
    await run('ask', deps);
    expect(requests).toEqual([]);
    expect(deps.execTool).toHaveBeenCalled();
  });
});

describe('auto mode', () => {
  it('runs page-changing tools without asking', async () => {
    const { deps, requests } = setup([call('c1', 'browser_click', { ref: '3' }), final('ok')]);
    await run('auto', deps);
    expect(requests).toEqual([]);
    expect(deps.execTool).toHaveBeenCalledWith('browser_click', { ref: '3' });
  });
});

describe('plan mode', () => {
  it('offers only read-only tools plus ask_user/present_plan', () => {
    const names = agentTools(false, 'plan').map((t) => t.function.name);
    expect(names).toContain('browser_state');
    expect(names).toContain('present_plan');
    expect(names).not.toContain('browser_click');
    expect(names).not.toContain('update_plan');
    expect(agentTools(false, 'auto').map((t) => t.function.name)).not.toContain('present_plan');
  });

  it('refuses page-changing tools before approval', async () => {
    const { deps, bodies } = setup([call('c1', 'browser_click', { ref: '1' }), final('ok')]);
    await run('plan', deps);
    expect(deps.execTool).not.toHaveBeenCalled();
    expect(String(bodies[1].messages.at(-1)?.content)).toMatch(/Plan mode/);
  });

  it('executes after approval in the chosen mode', async () => {
    const { deps, events, bodies, requests } = setup([
      call('c1', 'present_plan', { summary: 'Rellenar', steps: ['Escribir nombre', 'Enviar'] }),
      call('c2', 'browser_click', { ref: '1' }),
      final('hecho'),
    ], [{ kind: 'plan', decision: 'approve', execMode: 'auto' }]);

    await run('plan', deps);

    expect(requests[0]).toEqual({ kind: 'plan', summary: 'Rellenar', steps: ['Escribir nombre', 'Enviar'] });
    expect(events).toContainEqual({ type: 'mode', mode: 'auto' });
    expect(events).toContainEqual({ type: 'plan', steps: [{ text: 'Escribir nombre', status: 'pending' }, { text: 'Enviar', status: 'pending' }] });
    // After approval the full tool set is offered and the click runs unasked.
    expect(bodies[1].tools.map((t) => t.function.name)).toContain('browser_click');
    expect(deps.execTool).toHaveBeenCalledWith('browser_click', { ref: '1' });
    expect(String(bodies[1].messages.at(-1)?.content)).toMatch(/APPROVED/);
  });

  it('feeds a rejection back to the model', async () => {
    const { deps, bodies } = setup([
      call('c1', 'present_plan', { summary: 's', steps: ['a'] }),
      final('rehago'),
    ], [{ kind: 'plan', decision: 'reject', feedback: 'usa la otra pestaña' }]);
    await run('plan', deps);
    expect(String(bodies[1].messages.at(-1)?.content)).toMatch(/REJECTED.*usa la otra pestaña/);
    expect(bodies[1].tools.map((t) => t.function.name)).not.toContain('browser_click');
  });
});

describe('interaction tools', () => {
  it('ask_user waits for the answer and passes it to the model', async () => {
    const { deps, requests, bodies } = setup([
      call('c1', 'ask_user', { question: '¿Qué talla?', options: ['M', 'L'] }),
      final('ok'),
    ], [{ kind: 'question', answer: 'L' }]);
    await run('auto', deps);
    expect(requests[0]).toEqual({ kind: 'question', question: '¿Qué talla?', options: ['M', 'L'] });
    expect(bodies[1].messages.at(-1)).toMatchObject({ role: 'tool', content: 'The user answered: L' });
  });

  it('update_plan emits the checklist', async () => {
    const { deps, events } = setup([
      call('c1', 'update_plan', { steps: [{ text: 'a', status: 'done' }, { text: 'b', status: 'in_progress' }, { text: 'c', status: 'weird' }] }),
      final('ok'),
    ]);
    await run('auto', deps);
    expect(events).toContainEqual({ type: 'plan', steps: [
      { text: 'a', status: 'done' }, { text: 'b', status: 'in_progress' }, { text: 'c', status: 'pending' },
    ] });
    expect(deps.execTool).not.toHaveBeenCalled();
  });

  it('stops while waiting for the user', async () => {
    const { deps } = setup([call('c1', 'ask_user', { question: '?' })], [], {
      requestUser: async () => { throw new AgentStopped(); },
    });
    await expect(run('auto', deps)).rejects.toBeInstanceOf(AgentStopped);
  });

  it('normalizePlan accepts plain strings', () => {
    expect(normalizePlan(['x', ' ', { text: 'y', status: 'done' }])).toEqual([
      { text: 'x', status: 'pending' }, { text: 'y', status: 'done' },
    ]);
  });
});

describe('streaming', () => {
  it('requests a stream and merges SSE text and tool call fragments', async () => {
    const { deps, events, bodies } = setup([
      sse([
        { choices: [{ delta: { reasoning_content: 'pienso' } }] },
        { choices: [{ delta: { content: 'Voy ' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'browser_', arguments: '{"re' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'click', arguments: 'f":"7"}' } }] } }] },
      ]),
      sse([{ choices: [{ delta: { content: 'Lis' } }] }, { choices: [{ delta: { content: 'to.' } }] }]),
    ]);

    const text = await run('auto', deps);

    expect(bodies[0].stream).toBe(true);
    expect(deps.execTool).toHaveBeenCalledWith('browser_click', { ref: '7' });
    expect(text).toBe('Listo.');
    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text)).toEqual(['Voy ', 'Lis', 'to.']);
    expect(events).toContainEqual({ type: 'reasoning', text: 'pienso' });
    expect(bodies[1].messages[bodies[1].messages.length - 2]).toMatchObject({ role: 'assistant', content: 'Voy ' });
  });

  it('handles chunks split mid-line', async () => {
    const enc = new TextEncoder();
    const parts = ['data: {"choices":[{"delta":{"con', 'tent":"hola"}}]}\n', '\ndata: [DONE]\n'];
    const body = new ReadableStream<Uint8Array>({
      start(c) { parts.forEach((p) => c.enqueue(enc.encode(p))); c.close(); },
    });
    const msg = await readStream(body, () => {});
    expect(msg).toEqual({ role: 'assistant', content: 'hola' });
  });
});

describe('markdown', () => {
  it('escapes raw HTML', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> **ok**');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('<strong>ok</strong>');
  });

  it('only links http(s)', () => {
    expect(renderMarkdown('[a](https://x.test/p)')).toContain('<a href="https://x.test/p" target="_blank" rel="noopener noreferrer">a</a>');
    expect(renderMarkdown('[a](javascript:alert(1))')).not.toContain('<a');
  });

  it('renders lists, code and fences', () => {
    const html = renderMarkdown('- uno\n- `dos`\n\n1. tres\n\n```\n<b>x</b>\n```');
    expect(html).toContain('<ul><li>uno</li><li><code>dos</code></li></ul>');
    expect(html).toContain('<ol><li>tres</li></ol>');
    expect(html).toContain('<pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre>');
  });

  it('does not format inside inline code', () => {
    expect(renderMarkdown('`**no**`')).toBe('<p><code>**no**</code></p>');
  });
});

describe('panel helpers', () => {
  it('keeps only chat models', () => {
    expect(chatModels(['tooling', 'bge-m3', 'whisper-1', 'tts-1', 'or-glm', 'grok-imagine', 'tooling'])).toEqual(['or-glm', 'tooling']);
  });

  it('titles a chat from its first prompt', () => {
    expect(titleOf([{ kind: 'user', text: '  rellena\nel formulario ' }])).toBe('rellena el formulario');
    expect(titleOf([])).toBe('Nueva conversación');
  });
});
