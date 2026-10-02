/**
 * Page context injected into every prompt, so the agent "sees" the tab without asking.
 */
import type { TabInfo } from '@/types/messages';

export const CONTEXT_STATE_MAX_CHARS = 8000;

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

export interface PageContextInput {
  tabs: TabInfo[];
  targetTabId: number | null;
  /** browser_state output of the target tab, or null if it could not be read. */
  state: string | null;
  stateError?: string;
  maxChars?: number;
}

export function formatPageContext(input: PageContextInput): string {
  const { tabs, targetTabId, state, stateError, maxChars = CONTEXT_STATE_MAX_CHARS } = input;
  const target = tabs.find((t) => t.id === targetTabId);
  const lines: string[] = ['<page_context>'];

  lines.push(target
    ? `Target tab: [${target.id}] ${target.title} — ${target.url}`
    : 'Target tab: none');

  lines.push('Open tabs:');
  for (const t of tabs) {
    const flags = [t.id === targetTabId ? 'target' : '', t.active ? 'active' : ''].filter(Boolean).join(',');
    lines.push(`- [${t.id}]${flags ? ` (${flags})` : ''} ${truncate(t.title || '', 80)} — ${truncate(t.url || '', 160)}`);
  }

  if (state) {
    lines.push('Target tab state (browser_state):', truncate(state, maxChars));
  } else if (stateError) {
    lines.push(`Target tab state unavailable: ${stateError}`);
  }

  lines.push('</page_context>');
  return lines.join('\n');
}
