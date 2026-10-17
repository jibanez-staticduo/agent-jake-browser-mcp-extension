/**
 * Cliente MCP del servidor agent-jake al que está emparejado el panel (INFRA-909).
 *
 * Lo que el servidor anuncia en `tools/list` son plugins del copiloto: una capacidad nueva es un
 * fichero en el servidor, no código aquí. Streamable HTTP: un POST por petición, con la respuesta
 * en JSON o en SSE, y el `Mcp-Session-Id` que devuelve `initialize` en todas las siguientes.
 */

import type { FunctionTool } from './tools-catalog';
import type { ToolOutcome } from './loop';

const PROTOCOL_VERSION = '2025-03-26';
const CLIENT_INFO = { name: 'agent-browser-copilot', version: '1.0.0' };

type Fetch = typeof fetch;

let seq = 0;

/** Un POST JSON-RPC. Acepta respuesta en JSON o en SSE (`data: {…}`); devuelve el `result` y la sesión. */
async function rpc(
  fetchImpl: Fetch,
  url: string,
  method: string,
  params?: unknown,
  sessionId?: string | null,
  signal?: AbortSignal,
): Promise<{ result?: Record<string, unknown>; sessionId: string | null }> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      ...(method.startsWith('notifications/') ? {} : { id: ++seq }),
      method,
      ...(params === undefined ? {} : { params }),
    }),
    signal,
  });
  const session = response.headers.get('mcp-session-id') ?? sessionId ?? null;
  const body = await response.text();
  if (!response.ok) throw new Error(`MCP ${response.status}: ${body.slice(0, 200)}`);
  // SSE: la respuesta útil va en la primera línea `data:`.
  const payload = body.includes('data:') ? body.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim() : body;
  const parsed = payload ? (JSON.parse(payload) as { result?: Record<string, unknown>; error?: { code: number; message: string } }) : {};
  if (parsed.error) throw new Error(`MCP ${parsed.error.code}: ${parsed.error.message}`);
  return { result: parsed.result, sessionId: session };
}

function asTool(raw: unknown): FunctionTool | null {
  const t = raw as { name?: string; description?: string; inputSchema?: Record<string, unknown> };
  if (!t?.name || !t.inputSchema || typeof t.inputSchema !== 'object') return null;
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? t.name,
      parameters: { additionalProperties: false, ...t.inputSchema },
    },
  };
}

export interface ServerPlugin {
  tools: FunctionTool[];
  call: (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;
}

/** Abre la sesión contra el servidor y devuelve lo que anuncia más la forma de llamarlo. */
export async function openServer(
  fetchImpl: Fetch,
  url: string,
  signal?: AbortSignal,
): Promise<ServerPlugin> {
  const init = await rpc(fetchImpl, url, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  }, null, signal);
  const { sessionId } = init;
  await rpc(fetchImpl, url, 'notifications/initialized', undefined, sessionId, signal);
  const listed = await rpc(fetchImpl, url, 'tools/list', {}, sessionId, signal);
  const tools = ((listed.result?.tools as unknown[] | undefined) ?? [])
    .map(asTool)
    .filter((t): t is FunctionTool => t !== null);
  return {
    tools,
    call: async (name, args) => {
      try {
        const { result } = await rpc(fetchImpl, url, 'tools/call', { name, arguments: args }, sessionId, signal);
        const parts = (result?.content as { type?: string; text?: string }[] | undefined) ?? [];
        const text = parts.map((p) => p.text ?? '').join('\n').trim();
        return result?.isError ? { ok: false, error: text || `El servidor falló: ${name}` } : { ok: true, result: text };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },
  };
}
