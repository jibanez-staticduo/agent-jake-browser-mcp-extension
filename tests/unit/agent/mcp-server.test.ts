import { describe, expect, it, vi } from 'vitest';
import { openServer } from '@/background/agent/mcp-server';
import { agentTools, LOCAL_TOOL_NAMES } from '@/background/agent/tools-catalog';

/** Servidor MCP de mentira: `initialize` en JSON, `tools/list` en SSE, el resto en JSON. */
function fakeServer(calls: { method: string; params?: unknown; headers: Record<string, string> }[]) {
  return vi.fn(async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    const body = JSON.parse(init.body) as { id?: number; method: string; params?: unknown };
    calls.push({ method: body.method, params: body.params, headers: init.headers });
    const json = (result: unknown) => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json', 'mcp-session-id': 'sess-1' }),
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
    });
    if (body.method === 'initialize') return json({ protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'jake' } });
    if (body.method === 'notifications/initialized') return { ok: true, status: 202, headers: new Headers(), text: async () => '' };
    if (body.method === 'tools/list') {
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { tools: [
          { name: 'browser_state', description: 'la del servidor', inputSchema: { type: 'object', properties: {} } },
          { name: 'delegar', description: 'Delegar un trabajo', inputSchema: { type: 'object', properties: { orden: { type: 'string' } }, required: ['orden'] } },
        ] },
      });
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), text: async () => `event: message\ndata: ${payload}\n\n` };
    }
    return json({ content: [{ type: 'text', text: 'agente lanzado' }] });
  }) as unknown as typeof fetch;
}

describe('plugins del servidor MCP (INFRA-909)', () => {
  it('opens a session, parses the SSE answer and echoes the session id', async () => {
    const calls: { method: string; params?: unknown; headers: Record<string, string> }[] = [];
    const plugin = await openServer(fakeServer(calls), 'https://jake.test/mcp');

    expect(calls.map((c) => c.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    expect(calls[2].headers['Mcp-Session-Id']).toBe('sess-1');
    expect(calls.every((c) => !('Authorization' in c.headers))).toBe(true);
    expect(plugin.tools.map((t) => t.function.name)).toEqual(['browser_state', 'delegar']);
    expect(plugin.tools[1].function.parameters).toMatchObject({ required: ['orden'], additionalProperties: false });
  });

  it('authenticates every RPC only at the configured URL and rejects redirects', async () => {
    const calls: { method: string; headers: Record<string, string> }[] = [];
    const fetcher = vi.mocked(fakeServer(calls));
    const plugin = await openServer(fetcher, 'https://gateway.test/mcp', undefined, ' token-secret ');
    await plugin.call('delegar', {});
    expect(calls).toHaveLength(4);
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toBe('https://gateway.test/mcp');
      expect(init).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer token-secret' } });
    }
  });

  it('treats a blank credential as unauthenticated', async () => {
    const calls: { method: string; headers: Record<string, string> }[] = [];
    await openServer(fakeServer(calls), 'https://gateway.test/mcp', undefined, '   ');
    expect(calls.every((c) => !('Authorization' in c.headers))).toBe(true);
  });

  it.each(['http', 'rpc', 'json', 'network'])('does not expose secrets from %s errors', async (kind) => {
    const secret = 'token-secret';
    const fetcher = vi.fn(async () => {
      if (kind === 'network') throw new Error(`failed ${secret}`);
      return new Response(kind === 'rpc'
        ? JSON.stringify({ error: { code: -1, message: secret } })
        : secret, { status: kind === 'http' ? 401 : 200 });
    }) as unknown as typeof fetch;
    await expect(openServer(fetcher, 'https://gateway.test/mcp', undefined, secret)).rejects.toThrow(/MCP/);
    await expect(openServer(fetcher, 'https://gateway.test/mcp', undefined, secret)).rejects.not.toThrow(secret);
  });

  it('redacts credentials echoed in tool errors', async () => {
    const calls: { method: string; headers: Record<string, string> }[] = [];
    const fetcher = vi.mocked(fakeServer(calls));
    const plugin = await openServer(fetcher, 'https://gateway.test/mcp', undefined, 'token-secret');
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ result: {
      isError: true, content: [{ type: 'text', text: 'bad token-secret' }],
    } })));
    expect(await plugin.call('delegar', {})).toEqual({ ok: false, error: 'bad [redacted]' });
  });

  it('calls a plugin through tools/call and hands back its text', async () => {
    const calls: { method: string; params?: unknown; headers: Record<string, string> }[] = [];
    const plugin = await openServer(fakeServer(calls), 'https://jake.test/mcp');
    const outcome = await plugin.call('delegar', { orden: 'monta el informe' });

    expect(outcome).toEqual({ ok: true, result: 'agente lanzado' });
    expect(calls.at(-1)).toMatchObject({ method: 'tools/call', params: { name: 'delegar', arguments: { orden: 'monta el informe' } } });
  });

  it('the panel keeps its own names: only what it cannot do itself comes from the server', async () => {
    const calls: { method: string; params?: unknown; headers: Record<string, string> }[] = [];
    const plugin = await openServer(fakeServer(calls), 'https://jake.test/mcp');

    expect(LOCAL_TOOL_NAMES.has('browser_state')).toBe(true);
    const auto = agentTools(false, 'auto', plugin.tools);
    expect(auto.some((t) => t.function.name === 'delegar')).toBe(true);
    // La browser_state del servidor no se añade: el nombre local gana y no hay dos herramientas iguales.
    expect(auto.filter((t) => t.function.name === 'browser_state')).toHaveLength(1);
    // En ask y plan el panel solo lee la página: un plugin puede escribir fuera de ella.
    expect(agentTools(false, 'ask', plugin.tools).some((t) => t.function.name === 'delegar')).toBe(false);
    expect(agentTools(false, 'plan', plugin.tools).some((t) => t.function.name === 'delegar')).toBe(false);
  });
});
