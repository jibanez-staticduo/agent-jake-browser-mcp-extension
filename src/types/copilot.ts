/**
 * Copilot side panel <-> service worker protocol.
 * The panel opens a chrome.runtime Port named COPILOT_PORT and exchanges these messages.
 */

export const COPILOT_PORT = 'copilot';
export const COPILOT_SETTINGS_KEY = 'copilotSettings';
/** SHA-256 hashes of what background/provision.ts last seeded ({ baseUrl, apiKey }), to tell a user edit from a stale seed. */
export const COPILOT_PROVISIONED_KEY = 'copilotProvisioned';
export const COPILOT_ALLOWED_ORIGINS_KEY = 'copilotAllowedOrigins';

/**
 * ask  = actions that change the page need the user's OK; reads run freely.
 * auto = everything runs without asking.
 * plan = read-only investigation, then a plan the user approves before anything runs.
 */
export type CopilotMode = 'ask' | 'auto' | 'plan';

export interface CopilotSettings {
  /** OpenAI-compatible base URL, e.g. https://litellm.example.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  mode: CopilotMode;
  /** Hard cap on model round-trips per prompt. */
  maxSteps: number;
  /** Offer browser_screenshot and send the image back to the model. */
  vision: boolean;
}

export const DEFAULT_COPILOT_SETTINGS: CopilotSettings = {
  baseUrl: '',
  apiKey: '',
  model: 'qwen38-flash-next',
  mode: 'ask',
  maxSteps: 30,
  vision: false,
};

export type CopilotField = 'baseUrl' | 'apiKey' | 'model';

function isLoopback(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

/**
 * What is still missing before the copilot can run. The single source for the worker, the chat
 * notice, the Opciones summary and the amber dot. The key is optional only for a loopback endpoint.
 */
export function copilotMissing(settings: CopilotSettings): CopilotField[] {
  const missing: CopilotField[] = [];
  let loopback = false;
  try {
    const url = new URL(String(settings.baseUrl).trim());
    loopback = isLoopback(url);
    const safe = !url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback));
    if (!safe) missing.push('baseUrl');
  } catch {
    missing.push('baseUrl');
  }
  if (!loopback && !(typeof settings.apiKey === 'string' && settings.apiKey.trim())) missing.push('apiKey');
  if (typeof settings.model !== 'string' || !settings.model.trim()) missing.push('model');
  return missing;
}

/** Shared by the panel and worker: no browser data is sent before setup. */
export function isCopilotConfigured(settings: CopilotSettings): boolean {
  return copilotMissing(settings).length === 0;
}

/** One finished turn of the visible conversation (tool traffic stays in the worker). */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type PlanStatus = 'pending' | 'in_progress' | 'done';

export interface PlanStep {
  text: string;
  status: PlanStatus;
}

/** Something the agent needs from the user before it can go on. */
export type UserRequest =
  | { kind: 'approve'; tool: string; args: Record<string, unknown>; origin: string }
  | { kind: 'question'; question: string; options: string[] }
  | { kind: 'plan'; summary: string; steps: string[] };

export type UserResponse =
  | { kind: 'approve'; decision: 'allow' | 'allow_site' | 'deny' }
  | { kind: 'question'; answer: string }
  | { kind: 'plan'; decision: 'approve'; execMode: 'auto' | 'ask' }
  | { kind: 'plan'; decision: 'reject'; feedback: string };

export type PanelToWorker =
  | { type: 'prompt'; history: ChatTurn[]; prompt: string; targetTabId: number | null; mode: CopilotMode; model: string }
  | { type: 'response'; requestId: string; response: UserResponse }
  | { type: 'stop' };

export type WorkerToPanel =
  | { type: 'step'; step: number }
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; summary: string }
  | { type: 'request'; requestId: string; request: UserRequest }
  | { type: 'plan'; steps: PlanStep[] }
  | { type: 'mode'; mode: CopilotMode }
  | { type: 'assistant'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done'; stopped: boolean };
