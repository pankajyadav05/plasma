import { describe, expect, it } from 'vitest';
import { describeQueryOutcome } from './live-announce';

describe('describeQueryOutcome', () => {
  it('summarises rows and timing', () => {
    expect(describeQueryOutcome({ rowCount: 12, durationMs: 13.4 }, null)).toBe('12 rows · 13 ms');
    expect(describeQueryOutcome({ rowCount: 1, durationMs: 2, command: 'SELECT' }, null)).toBe(
      '1 row · 2 ms',
    );
    expect(
      describeQueryOutcome(
        { rowCount: 3, durationMs: 5, command: 'UPDATE', truncated: true },
        null,
      ),
    ).toBe('UPDATE · 3 rows (truncated) · 5 ms');
  });
  it('reports errors first', () => {
    expect(describeQueryOutcome(null, 'syntax error')).toBe('Query failed: syntax error');
  });
});
