import { describe, expect, it } from 'vitest';
import { shouldUseEstimatedCount } from './session-sql-heuristics';

describe('shouldUseEstimatedCount', () => {
  it('uses the estimate once it reaches the threshold', () => {
    expect(shouldUseEstimatedCount(100_000, 100_000)).toBe(true);
    expect(shouldUseEstimatedCount(100_000, 99_999)).toBe(false);
  });
  it('0 means always count exactly; unknown estimates count', () => {
    expect(shouldUseEstimatedCount(0, 10_000_000)).toBe(false);
    expect(shouldUseEstimatedCount(1, null)).toBe(false);
    expect(shouldUseEstimatedCount(1, -1)).toBe(false);
  });
});
