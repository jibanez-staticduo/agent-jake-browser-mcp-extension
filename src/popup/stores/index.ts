/**
 * Pinia store setup and shared utilities.
 */

// Chrome messaging helper (shared across stores)
export async function sendMessage<T>(action: string, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response === undefined) {
        reject(new Error('No response from background script'));
      } else {
        resolve(response as T);
      }
    });
  });
}

// Re-export stores for convenience
export { useAuthStore } from './auth';
export { useStatusStore } from './status';
export { useServerStore } from './server';
export { useActivityStore } from './activity';
