/**
 * Copilot agent loop: OpenAI-compatible chat completions with tool calling,
 * tools executed by the extension's own handlers. Pure apart from injected deps,
 * so it is unit-tested with a fake fetch and fake tools.
 */
import type { ChatTurn, CopilotSettings, WorkerToPanel } from '@/types/copilot';
import { agentTools } from './tools-catalog';
import { truncate } from './context';

export const TOOL_RESULT_MAX_CHARS = 12000;

export const SYSTEM_PROMPT = `You are a browser copilot living in the user's Chrome side panel.
You act on real tabs through the browser_* tools. Every user message carries a <page_context>
block with the target tab, the open tabs and the target's current state (interactive elements
with [n] refs): read it before calling tools, and do not call browser_state again unless the page
may have changed. Refs go stale after navigation or DOM changes — re-read state then.
To work on another tab, browser_switch_tab (or browser_new_tab) first; later tools act on it.
Be fast: prefer one decisive action over exploration. Answer in the user's language, briefly, in
plain text (the panel does not render Markdown), and say what you did. Never submit payments, delete data or send messages on the user's behalf
unless the prompt explicitly asks for it.`;

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string | Record<string, unknown> };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface AgentDeps {
  fetch: typeof fetch;
  execTool: (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;
  getContext: () => Promise<string>;
  emit: (event: WorkerToPanel) => void;
  signal: AbortSignal;
}

export class AgentStopped extends Error {
  constructor() {
    super('Stopped');
    this.name = 'AgentStopped';
  }
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new AgentStopped();
}

export function completionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

export function parseArgs(raw: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

/** Screenshot results carry a data URL; everything else is JSON for the model. */
function imageOf(result: unknown): string | null {
  const image = (result as { image?: unknown } | null)?.image;
  return typeof image === 'string' && image.startsWith('data:image/') ? image : null;
}

export function summarize(outcome: ToolOutcome): string {
  if (!outcome.ok) return outcome.error || 'failed';
  if (imageOf(outcome.result)) return 'screenshot captured';
  const text = typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result ?? null);
  return truncate(text, 200);
}

async function complete(
  settings: CopilotSettings,
  messages: ChatMessage[],
  deps: AgentDeps,
): Promise<ChatMessage> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

  const response = await deps.fetch(completionsUrl(settings.baseUrl), {
    method: 'POST',
    headers,
    signal: deps.signal,
    body: JSON.stringify({
      model: settings.model,
      messages,
      tools: agentTools(settings.vision),
      tool_choice: 'auto',
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`LLM ${response.status}: ${truncate(body, 400)}`);
  }
  const data = await response.json() as { choices?: { message?: ChatMessage }[] };
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error('LLM returned no choices');
  return message;
}

/**
 * Run one prompt to completion. Returns the final assistant text.
 * Throws AgentStopped when the signal aborts.
 */
export async function runAgent(
  history: ChatTurn[],
  prompt: string,
  settings: CopilotSettings,
  deps: AgentDeps,
): Promise<string> {
  const context = await deps.getContext();
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map((t) => ({ role: t.role, content: t.content })),
    { role: 'user', content: `${context}\n\n${prompt}` },
  ];

  try {
    for (let step = 1; step <= settings.maxSteps; step++) {
      checkAbort(deps.signal);
      deps.emit({ type: 'step', step });

      const reply = await complete(settings, messages, deps);
      const calls = reply.tool_calls ?? [];
      messages.push({ role: 'assistant', content: reply.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) });

      if (!calls.length) {
        const text = typeof reply.content === 'string' ? reply.content.trim() : '';
        deps.emit({ type: 'assistant', text });
        return text;
      }

      const images: string[] = [];
      for (const call of calls) {
        checkAbort(deps.signal);
        const name = call.function?.name ?? '';
        let outcome: ToolOutcome;
        let args: Record<string, unknown> = {};
        try {
          args = parseArgs(call.function?.arguments);
          deps.emit({ type: 'tool_call', id: call.id, name, args });
          outcome = await deps.execTool(name, args);
        } catch (error) {
          if (error instanceof AgentStopped) throw error;
          deps.emit({ type: 'tool_call', id: call.id, name, args });
          outcome = { ok: false, error: (error as Error).message };
        }
        deps.emit({ type: 'tool_result', id: call.id, name, ok: outcome.ok, summary: summarize(outcome) });

        const image = outcome.ok ? imageOf(outcome.result) : null;
        if (image) images.push(image);
        const content = !outcome.ok
          ? `Error: ${outcome.error}`
          : image
            ? 'Screenshot captured; the image is attached in the next message.'
            : truncate(JSON.stringify(outcome.result ?? null), TOOL_RESULT_MAX_CHARS);
        messages.push({ role: 'tool', tool_call_id: call.id, content });
      }

      if (images.length) {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: 'Screenshot(s) requested above:' },
            ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
          ],
        });
      }
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new AgentStopped();
    throw error;
  }

  const text = `Stopped after ${settings.maxSteps} steps without a final answer.`;
  deps.emit({ type: 'assistant', text });
  return text;
}
