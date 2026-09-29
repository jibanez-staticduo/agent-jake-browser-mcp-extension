/**
 * Copilot side panel <-> service worker protocol.
 * The panel opens a chrome.runtime Port named COPILOT_PORT and exchanges these messages.
 */

export const COPILOT_PORT = 'copilot';
export const COPILOT_SETTINGS_KEY = 'copilotSettings';

export interface CopilotSettings {
  /** OpenAI-compatible base URL, e.g. https://litellm.example.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Hard cap on model round-trips per prompt. */
  maxSteps: number;
  /** Offer browser_screenshot and send the image back to the model. */
  vision: boolean;
}

export const DEFAULT_COPILOT_SETTINGS: CopilotSettings = {
  baseUrl: 'https://litellm.lan.e-dani.com/v1',
  apiKey: '',
  model: 'tooling',
  maxSteps: 25,
  vision: false,
};

/** One finished turn of the visible conversation (tool traffic stays in the worker). */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type PanelToWorker =
  | { type: 'prompt'; history: ChatTurn[]; prompt: string; targetTabId: number | null }
  | { type: 'stop' };

export type WorkerToPanel =
  | { type: 'step'; step: number }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; summary: string }
  | { type: 'assistant'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done'; stopped: boolean };
