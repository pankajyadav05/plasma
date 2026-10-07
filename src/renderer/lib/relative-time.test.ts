import { describe, expect, it } from 'vitest';
import { relativeTime } from './relative-time';

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

describe('relativeTime', () => {
  it('names the unit that fits', () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe('just now');
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5 min ago');
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago');
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe('2 d ago');
  });
  it('falls back to a date after a month', () => {
    expect(relativeTime(NOW - 90 * 86_400_000, NOW)).not.toMatch(/ago/);
  });
  it('never reports the future as negative', () => {
    expect(relativeTime(NOW + 60_000, NOW)).toBe('just now');
  });
});
