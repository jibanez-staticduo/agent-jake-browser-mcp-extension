/**
 * Simple logger utility for extension debugging.
 * Prefixes all messages with [AgentJake] for easy filtering.
 */

const PREFIX = '[AgentJake]';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Set minimum log level (can be changed for production)
let minLevel: LogLevel = 'debug';

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[minLevel];
}

function formatArgs(args: unknown[]): unknown[] {
  return args.map(arg => {
    if (arg instanceof Error) {
      return `${arg.message}\n${arg.stack}`;
    }
    if (typeof arg === 'object' && arg !== null) {
      try {
        return JSON.stringify(arg, null, 2);
      } catch {
        return String(arg);
      }
    }
    return arg;
  });
}

export const log = {
  debug: (...args: unknown[]): void => {
    if (shouldLog('debug')) {
      console.debug(PREFIX, ...formatArgs(args));
    }
  },

  info: (...args: unknown[]): void => {
    if (shouldLog('info')) {
      console.info(PREFIX, ...formatArgs(args));
    }
  },

  warn: (...args: unknown[]): void => {
    if (shouldLog('warn')) {
      console.warn(PREFIX, ...formatArgs(args));
    }
  },

  error: (...args: unknown[]): void => {
    if (shouldLog('error')) {
      console.error(PREFIX, ...formatArgs(args));
    }
  },
};
