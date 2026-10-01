/**
 * Formatting utilities composable.
 * Provides reusable date/time and duration formatting functions.
 */

/**
 * Format a timestamp as a localized time string (HH:MM:SS).
 */
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * Returns empty string if undefined, "Xms" for sub-second, "X.Xs" for seconds.
 */
export function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Composable that returns formatting utilities.
 * Use this in Vue components for reactive formatting.
 */
export function useFormatting() {
  return {
    formatTime,
    formatDuration,
  };
}
