/**
 * Polling shared by the popup stores: start it, stop it (safe to call twice). Each store polls
 * its own state; the interval and the guard are the same in all of them.
 */
export function usePolling(refresh: () => unknown, everyMs = 2000) {
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  return {
    startPolling(): void {
      refresh();
      pollInterval = setInterval(refresh, everyMs);
    },
    stopPolling(): void {
      if (!pollInterval) return;
      clearInterval(pollInterval);
      pollInterval = null;
    },
  };
}
