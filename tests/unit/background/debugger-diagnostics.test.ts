import { beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '@/utils/logger';
import { logDebuggerDetached, logDebuggerDetachFailure } from '@/background/debugger-diagnostics';

vi.mock('@/utils/logger', () => ({ log: { debug: vi.fn(), warn: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());

describe('debugger lifecycle diagnostics', () => {
  it('logs normal target closure without a warning', () => {
    logDebuggerDetached(1077013388, 'target_closed');
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith('Debugger detached from tab 1077013388: target_closed');
  });

  it.each(['No tab with given id 1077013388.', 'Debugger is not attached to the tab with id: 1077013395.'])(
    'logs expected detach response at debug: %s', message => {
      const error = new Error(message);
      logDebuggerDetachFailure(error);
      expect(log.warn).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalledWith('Debugger already detached:', error);
    },
  );

  it.each(['Permission denied', 'Debugger is not attached to the tab with id: invalid', 'No tab with given id 1. Unexpected failure'])(
    'retains warnings for unexpected detach failure: %s', message => {
      const error = new Error(message);
      logDebuggerDetachFailure(error);
      expect(log.warn).toHaveBeenCalledWith('Failed to detach debugger:', error);
      expect(log.debug).not.toHaveBeenCalled();
    },
  );

  it('retains warnings for detach events other than normal target closure', () => {
    logDebuggerDetached(1, 'canceled_by_user');
    expect(log.warn).toHaveBeenCalledWith('Debugger detached from tab 1: canceled_by_user');
  });
});
