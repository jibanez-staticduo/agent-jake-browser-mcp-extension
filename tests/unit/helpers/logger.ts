import { vi } from 'vitest';

/** Stand-in for @/utils/logger: `vi.mock('@/utils/logger', () => import('../helpers/logger'))`. */
export const log = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
