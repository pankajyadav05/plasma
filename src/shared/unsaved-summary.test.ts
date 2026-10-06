import { describe, expect, it } from 'vitest';
import { describeLoss, joinLoss } from './unsaved-summary';

const none = { openTransaction: false, pendingEdits: 0 };

describe('describeLoss', () => {
  it('is empty when nothing is at stake', () => {
    expect(describeLoss(none)).toEqual([]);
    expect(
      describeLoss({ ...none, runningQuery: false, safeRunPending: false, unsavedSqlTabs: 0 }),
    ).toEqual([]);
  });

  it('lists exactly what would be lost', () => {
    expect(describeLoss({ ...none, pendingEdits: 1 })).toEqual(['1 unsaved grid edit']);
    expect(describeLoss({ ...none, pendingEdits: 3 })).toEqual(['3 unsaved grid edits']);
    expect(
      describeLoss({
        openTransaction: true,
        pendingEdits: 2,
        runningQuery: true,
        safeRunPending: true,
        unsavedSqlTabs: 2,
      }),
    ).toEqual([
      'an open transaction (it will be rolled back)',
      '2 unsaved grid edits',
      'a Safe Run waiting for Commit or Roll back (it will be rolled back)',
      'a query that is still running (it will be cancelled)',
      '2 SQL tabs with unsaved text that cannot be restored',
    ]);
  });

  it('joins naturally', () => {
    expect(joinLoss([])).toBe('');
    expect(joinLoss(['a'])).toBe('a');
    expect(joinLoss(['a', 'b'])).toBe('a and b');
    expect(joinLoss(['a', 'b', 'c'])).toBe('a, b and c');
  });
});
