/**
 * Copilot agent loop: OpenAI-compatible chat completions (streamed) with tool calling,
 * browser tools executed by the extension's own handlers, and three modes:
 *   ask  — page-changing tools wait for the user's approval (per action or per site)
 *   auto — everything runs
 *   plan — read-only investigation, present_plan, and only after approval execution
 * Pure apart from injected deps, so it is unit-tested with a fake fetch and fake tools.
 */
import type {
  ChatTurn,
  CopilotMode,
  CopilotSettings,
  PlanStep,
  PlanStatus,
  UserRequest,
  UserResponse,
  WorkerToPanel,
} from '@/types/copilot';
import { agentTools, READ_ONLY_TOOLS } from './tools-catalog';
import { isCopilotConfigured } from '@/types/copilot';
import { truncate } from './context';

export const TOOL_RESULT_MAX_CHARS = 12000;

const BASE_PROMPT = `You are a browser copilot living in the user's Chrome side panel.
You act on real tabs through the browser_* tools. Every user message carries a <page_context>
block with the target tab, the open tabs and the target's current state (interactive elements
with [n] refs): read it before calling tools, and do not call browser_state again unless the page
may have changed. Refs go stale after navigation or DOM changes — re-read state then.
To work on another tab, browser_switch_tab (or browser_new_tab) first; later tools act on it.
For tasks with 3 or more steps keep a checklist with update_plan. When the request is ambiguous
or a choice belongs to the user, ask_user instead of guessing.
Be fast: prefer one decisive action over exploration. Answer in the user's language, briefly,
using Markdown when it helps, and say what you did. Never submit payments, delete data or send
messages on the user's behalf unless the prompt explicitly asks for it.`;

const MODE_PROMPT: Record<CopilotMode, string> = {
  ask: 'Mode: ASK. Actions that change the page are shown to the user for approval before they run; if one is denied, do not retry it — adapt or ask.',
  auto: 'Mode: AUTO. Your actions run without confirmation: be careful with anything irreversible.',
  plan: 'Mode: PLAN. You may only use read-only tools. Investigate what you need, then call present_plan with a concrete step list. Do not attempt page-changing actions before the plan is approved.',
};

export function systemPrompt(mode: CopilotMode): string {
  return `${BASE_PROMPT}\n\n${MODE_PROMPT[mode]}`;
}

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
  /** Resolves with the user's answer; rejects with AgentStopped if the run is stopped. */
  requestUser: (request: UserRequest) => Promise<UserResponse>;
  /** Origin of the page the next action lands on (connected tab). */
  currentTarget: () => Promise<{ tabId: number | null; origin: string }>;
  isOriginAllowed: (origin: string) => Promise<boolean>;
  allowOrigin: (origin: string) => Promise<void>;
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

function resultText(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result ?? null);
}

export function summarize(outcome: ToolOutcome): string {
  if (!outcome.ok) return outcome.error || 'failed';
  if (imageOf(outcome.result)) return 'screenshot captured';
  return truncate(resultText(outcome.result), 200);
}

const PLAN_STATUSES: PlanStatus[] = ['pending', 'in_progress', 'done'];

export function normalizePlan(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => (typeof s === 'string' ? { text: s, status: 'pending' } : s) as { text?: unknown; status?: unknown })
    .filter((s) => typeof s?.text === 'string' && s.text.trim())
    .map((s) => ({
      text: String(s.text).trim(),
      status: PLAN_STATUSES.includes(s.status as PlanStatus) ? (s.status as PlanStatus) : 'pending',
    }));
}

/**
 * Read an OpenAI-style SSE stream into one assistant message, emitting text and
 * reasoning deltas as they arrive. Tool call fragments are merged by index.
 */
export async function readStream(body: ReadableStream<Uint8Array>, emit: (e: WorkerToPanel) => void): Promise<ChatMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const calls: ToolCall[] = [];

  const handle = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let chunk: { choices?: { delta?: Record<string, unknown> }[] };
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      emit({ type: 'delta', text: delta.content });
    }
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string' && reasoning) emit({ type: 'reasoning', text: reasoning });
    const fragments = delta.tool_calls as
      | { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
      | undefined;
    for (const f of fragments ?? []) {
      const i = f.index ?? 0;
      calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (f.id) calls[i].id = f.id;
      if (f.function?.name) calls[i].function.name += f.function.name;
      if (f.function?.arguments) calls[i].function.arguments += f.function.arguments;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    lines.forEach((l) => handle(l.trim()));
  }
  handle(buffer.trim());

  const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
  return { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
}

async function complete(
  settings: CopilotSettings,
  mode: CopilotMode,
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
      tools: agentTools(settings.vision, mode),
      tool_choice: 'auto',
      stream: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`LLM ${response.status}: ${truncate(body, 400)}`);
  }
  if ((response.headers.get('content-type') || '').includes('text/event-stream') && response.body) {
    return readStream(response.body, deps.emit);
  }
  // Backends that ignore `stream` answer with plain JSON.
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
  if (!isCopilotConfigured(settings)) throw new Error('Configure a valid endpoint and model before using Copilot.');
  let mode: CopilotMode = settings.mode;
  const context = await deps.getContext();
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(mode) },
    ...history.map((t) => ({ role: t.role, content: t.content })),
    { role: 'user', content: `${context}\n\n${prompt}` },
  ];

  /** Meta tools are answered here and by the user; browser tools go to the handlers. */
  async function dispatch(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    if (!agentTools(settings.vision, mode).some((tool) => tool.function.name === name)) {
      return { ok: false, error: `Tool unavailable in ${mode} mode: ${name}` };
    }
    if (name === 'update_plan') {
      const steps = normalizePlan(args.steps);
      deps.emit({ type: 'plan', steps });
      return { ok: true, result: `Checklist updated (${steps.length} steps).` };
    }

    if (name === 'ask_user') {
      const question = String(args.question ?? '').trim();
      const options = Array.isArray(args.options) ? args.options.map(String).filter(Boolean) : [];
      const res = await deps.requestUser({ kind: 'question', question, options });
      const answer = res.kind === 'question' ? res.answer : '';
      return { ok: true, result: `The user answered: ${answer}` };
    }

    if (name === 'present_plan') {
      if (mode !== 'plan') return { ok: false, error: 'present_plan is only available in plan mode' };
      const steps = normalizePlan(args.steps).map((s) => s.text);
      const summary = String(args.summary ?? '').trim();
      const res = await deps.requestUser({ kind: 'plan', summary, steps });
      if (res.kind === 'plan' && res.decision === 'approve') {
        mode = res.execMode;
        deps.emit({ type: 'mode', mode });
        deps.emit({ type: 'plan', steps: steps.map((text) => ({ text, status: 'pending' as const })) });
        return {
          ok: true,
          result: `The user APPROVED the plan. Execute it now (mode: ${mode.toUpperCase()}); `
            + 'keep the checklist current with update_plan.',
        };
      }
      const feedback = res.kind === 'plan' && res.decision === 'reject' ? res.feedback : '';
      return { ok: true, result: `The user REJECTED the plan. Feedback: ${feedback || '(none)'}. Revise it and present_plan again.` };
    }

    const readOnly = READ_ONLY_TOOLS.has(name);
    if (mode === 'plan' && !readOnly) {
      return { ok: false, error: 'Plan mode: only read-only tools until the user approves a plan (present_plan).' };
    }
    if (mode === 'ask' && !readOnly) {
      const target = await deps.currentTarget();
      const { origin } = target;
      let rememberOrigin = false;
      if (!(await deps.isOriginAllowed(origin))) {
        const res = await deps.requestUser({ kind: 'approve', tool: name, args, origin });
        const decision = res.kind === 'approve' ? res.decision : 'deny';
        if (decision === 'deny') return { ok: false, error: 'The user denied this action.' };
        rememberOrigin = decision === 'allow_site';
      }
      const current = await deps.currentTarget();
      if (current.tabId !== target.tabId || current.origin !== origin) {
        return { ok: false, error: 'Action cancelled: target tab or origin changed while awaiting approval. Request approval again.' };
      }
      if (rememberOrigin) await deps.allowOrigin(origin);
      const beforeExecution = await deps.currentTarget();
      if (beforeExecution.tabId !== target.tabId || beforeExecution.origin !== origin) {
        return { ok: false, error: 'Action cancelled: target tab or origin changed before execution.' };
      }
    }
    return deps.execTool(name, args);
  }

  try {
    for (let step = 1; step <= settings.maxSteps; step++) {
      checkAbort(deps.signal);
      deps.emit({ type: 'step', step });

      const reply = await complete(settings, mode, messages, deps);
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
          outcome = await dispatch(name, args);
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
            : truncate(resultText(outcome.result), TOOL_RESULT_MAX_CHARS);
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
