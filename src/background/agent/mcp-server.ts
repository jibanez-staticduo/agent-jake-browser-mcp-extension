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
  token = '',
): Promise<{ result?: Record<string, unknown>; sessionId: string | null }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      // Never forward a credential or MCP session to a redirect destination.
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
  } catch {
    throw new Error('MCP: no se pudo completar la solicitud.');
  }
  const session = response.headers.get('mcp-session-id') ?? sessionId ?? null;
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
  let body: string;
  try {
    body = await response.text();
  } catch {
    throw new Error('MCP: no se pudo leer la respuesta.');
  }
  // SSE: la respuesta útil va en la primera línea `data:`.
  const payload = body.includes('data:') ? body.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim() : body;
  let parsed: { result?: Record<string, unknown>; error?: { code: number } };
  try {
    parsed = payload ? JSON.parse(payload) : {};
  } catch {
    throw new Error('MCP: respuesta JSON no válida.');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('MCP: respuesta no válida.');
  if (parsed.error) throw new Error('MCP: el servidor rechazó la solicitud.');
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
  bearerToken = '',
): Promise<ServerPlugin> {
  const token = bearerToken.trim();
  const init = await rpc(fetchImpl, url, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  }, null, signal, token);
  const { sessionId } = init;
  await rpc(fetchImpl, url, 'notifications/initialized', undefined, sessionId, signal, token);
  const listed = await rpc(fetchImpl, url, 'tools/list', {}, sessionId, signal, token);
  const tools = ((listed.result?.tools as unknown[] | undefined) ?? [])
    .map(asTool)
    .filter((t): t is FunctionTool => t !== null);
  return {
    tools,
    call: async (name, args) => {
      try {
        const { result } = await rpc(fetchImpl, url, 'tools/call', { name, arguments: args }, sessionId, signal, token);
        const parts = (result?.content as { type?: string; text?: string }[] | undefined) ?? [];
        const text = parts.map((p) => p.text ?? '').join('\n').trim();
        const safeText = token ? text.split(token).join('[redacted]') : text;
        return result?.isError ? { ok: false, error: safeText || `El servidor falló: ${name}` } : { ok: true, result: safeText };
      } catch (error) {
        return { ok: false, error: token ? String((error as Error).message).split(token).join('[redacted]') : (error as Error).message };
      }
    },
  };
}
