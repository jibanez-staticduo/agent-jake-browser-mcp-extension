import { describe, expect, it } from 'vitest';
import { glideMs } from '@/content/cursor';

describe('glideMs', () => {
  it('is proportional to distance and clamped to [160, 450] ms', () => {
    expect(glideMs(300)).toBe(240);
    expect(glideMs(100)).toBe(160);
    expect(glideMs(1000)).toBe(450);
  });
});
