import { log } from '@/utils/logger';

export function logDebuggerDetached(tabId: number | undefined, reason: string): void {
  const message = `Debugger detached from tab ${tabId}: ${reason}`;
  if (reason === 'target_closed') log.debug(message);
  else log.warn(message);
}

export function logDebuggerDetachFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (/^(?:No tab with given id \d+\.?|Debugger is not attached to the tab with id: \d+\.?)$/.test(message)) {
    log.debug('Debugger already detached:', error);
  } else {
    log.warn('Failed to detach debugger:', error);
  }
}
