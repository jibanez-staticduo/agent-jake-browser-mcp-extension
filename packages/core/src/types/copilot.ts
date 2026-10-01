/**
 * Copilot side panel <-> service worker protocol.
 * The panel opens a chrome.runtime Port named COPILOT_PORT and exchanges these messages.
 */

export const COPILOT_PORT = 'copilot';
export const COPILOT_SETTINGS_KEY = 'copilotSettings';
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
  model: 'tooling',
  mode: 'ask',
  maxSteps: 30,
  vision: false,
};

/** Shared by the panel and worker: no browser data is sent before setup. */
export function isCopilotConfigured(settings: CopilotSettings): boolean {
  if (typeof settings.baseUrl !== 'string' || typeof settings.model !== 'string' || !settings.model.trim()) return false;
  try {
    const url = new URL(settings.baseUrl.trim());
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    return !url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback));
  } catch {
    return false;
  }
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
