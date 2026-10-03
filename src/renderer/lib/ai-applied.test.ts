import { describe, expect, it } from 'vitest';
import { forgetAiApplied, isAiApplied, markAiApplied } from './ai-applied';

describe('ai-applied', () => {
  it('recognises applied statements regardless of whitespace, case and a trailing semicolon', () => {
    markAiApplied('t1', 'UPDATE users\n  SET active = false;\nDELETE FROM sessions;');
    expect(isAiApplied('t1', 'update users set active = false')).toBe(true);
    expect(isAiApplied('t1', 'DELETE FROM sessions;')).toBe(true);
    expect(isAiApplied('t1', 'DROP TABLE users')).toBe(false);
    expect(isAiApplied('t2', 'DELETE FROM sessions')).toBe(false);
  });

  it('forgets a tab', () => {
    markAiApplied('t3', 'select 1');
    forgetAiApplied('t3');
    expect(isAiApplied('t3', 'select 1')).toBe(false);
  });

  it('ignores empty input', () => {
    markAiApplied(undefined, 'select 1');
    markAiApplied('t4', '   ');
    expect(isAiApplied('t4', '')).toBe(false);
  });
});
