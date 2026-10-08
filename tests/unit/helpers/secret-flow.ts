import { vi } from 'vitest';
import { createToolHandlers } from '@/background/tool-handlers';

/** Test-only values from tests/fixtures/fixture-secreto.html: never a real credential. */
export const CANARY = 'CANARY-SEED-7F3A9C21';
export const DECOY = 'TEXTO-SENUELO-DE-LA-PAGINA';

/**
 * The real handleMessage over a stand-in browser: the connected tab is 7 and its content
 * script answers every `readSecret` with `answer` (what readSecret returns, not a Chrome reply).
 */
export function secretFlow(answer: unknown) {
  const sendMessage = vi.fn(async () => ({ success: true, data: answer }));
  vi.stubGlobal('chrome', { ...(globalThis as { chrome?: object }).chrome, tabs: { sendMessage } });
  const tabManager = { getConnectedTabId: () => 7, hasTab: async () => true, connectTab: async () => {} };
  const handleMessage = createToolHandlers(tabManager as never);
  const readSecret = (payload: Record<string, unknown>) =>
    handleMessage({ id: 'r1', type: 'browser_read_secret', payload: { targetTabId: 7, ...payload } });
  return { handleMessage, readSecret, sendMessage };
}
