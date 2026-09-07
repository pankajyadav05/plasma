import { describe, expect, it } from 'vitest';
import {
  MAX_STRING_BYTES,
  accumulateHashFields,
  exceedsFetchBudget,
  largeValueStub,
  pairsFromHscanFlat,
} from './redis-value';

describe('exceedsFetchBudget', () => {
  it('gates only when size is a finite number above the limit', () => {
    expect(exceedsFetchBudget(MAX_STRING_BYTES + 1)).toBe(true);
    expect(exceedsFetchBudget(MAX_STRING_BYTES)).toBe(false);
    expect(exceedsFetchBudget(0)).toBe(false);
  });

  it('does not gate when size is unknown', () => {
    expect(exceedsFetchBudget(null)).toBe(false);
    expect(exceedsFetchBudget(undefined)).toBe(false);
    expect(exceedsFetchBudget(Number.NaN)).toBe(false);
  });
});

describe('largeValueStub', () => {
  it('marks truncated and includes size in the error message', () => {
    const stub = largeValueStub(2_097_152);
    expect(stub.truncated).toBe(true);
    expect(stub.sizeBytes).toBe(2_097_152);
    expect(stub.error).toContain('2.0 MiB');
    expect(stub.error).toContain('not fetched');
  });
});

describe('pairsFromHscanFlat', () => {
  it('pairs field/value entries', () => {
    expect(pairsFromHscanFlat(['a', '1', 'b', '2'])).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
  });

  it('drops a trailing orphan field', () => {
    expect(pairsFromHscanFlat(['a', '1', 'orphan'])).toEqual([['a', '1']]);
  });

  it('returns empty for an empty reply', () => {
    expect(pairsFromHscanFlat([])).toEqual([]);
  });
});

describe('accumulateHashFields', () => {
  it('stops once the cap is reached and keeps earlier fields', () => {
    const items: [string, string][] = [];
    const capped = accumulateHashFields(items, ['a', '1', 'b', '2', 'c', '3'], 2);
    expect(capped).toBe(true);
    expect(items).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
  });

  it('returns false when the page fits under the cap', () => {
    const items: [string, string][] = [['x', '0']];
    const capped = accumulateHashFields(items, ['a', '1'], 5);
    expect(capped).toBe(false);
    expect(items).toEqual([
      ['x', '0'],
      ['a', '1'],
    ]);
  });
});
