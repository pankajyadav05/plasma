import { describe, expect, it } from 'vitest';
import { hasPartialResults, isErrorTabActive } from './result-view';

describe('result-view (E6)', () => {
  const failed = { kind: 'sql', queryError: 'boom', queryResults: [{}, {}], queryGeneration: 3 };

  it('shows the error tab by default after a partial failure', () => {
    expect(isErrorTabActive(failed)).toBe(true);
    expect(hasPartialResults(failed)).toBe(true);
  });

  it('shows results once the user picked one for this run', () => {
    expect(isErrorTabActive({ ...failed, errorTabHiddenGen: 3 })).toBe(false);
    // A later run that fails again starts on the error.
    expect(isErrorTabActive({ ...failed, errorTabHiddenGen: 2 })).toBe(true);
  });

  it('always shows errors without results, and never without an error', () => {
    expect(isErrorTabActive({ kind: 'sql', queryError: 'x', queryResults: [] })).toBe(true);
    expect(isErrorTabActive({ kind: 'table', queryError: 'x', queryResults: [{}] })).toBe(true);
    expect(isErrorTabActive({ kind: 'sql', queryError: null, queryResults: [{}] })).toBe(false);
  });
});
