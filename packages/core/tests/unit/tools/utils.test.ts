/**
 * Unit tests for tool handler utility functions.
 * Tests isNavigationError from the extracted utils module.
 */

import { describe, it, expect } from 'vitest';
import { isNavigationError } from '@/background/tools/utils';

describe('isNavigationError', () => {
  it('detects BFCache errors', () => {
    const error = new Error('The page keeping the extension port is moved into back/forward cache');
    expect(isNavigationError(error)).toBe(true);
  });

  it('detects message channel closed errors', () => {
    const error = new Error('message channel is closed');
    expect(isNavigationError(error)).toBe(true);
  });

  it('detects port closed errors', () => {
    const error = new Error('port closed');
    expect(isNavigationError(error)).toBe(true);
  });

  it('detects receiving end does not exist errors', () => {
    const error = new Error('Could not establish connection. Receiving end does not exist.');
    expect(isNavigationError(error)).toBe(true);
  });

  it('returns false for element not found errors', () => {
    const error = new Error('Element not found: #submit-btn');
    expect(isNavigationError(error)).toBe(false);
  });

  it('returns false for timeout errors', () => {
    const error = new Error('Timeout waiting for element');
    expect(isNavigationError(error)).toBe(false);
  });

  it('returns false for debugger not attached errors', () => {
    const error = new Error('Debugger is not attached to the tab');
    expect(isNavigationError(error)).toBe(false);
  });

  it('is case-insensitive', () => {
    const error = new Error('MESSAGE CHANNEL IS CLOSED');
    expect(isNavigationError(error)).toBe(true);
  });
});
