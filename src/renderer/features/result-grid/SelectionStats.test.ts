import { describe, expect, it } from 'vitest';
import { summarizeSelection } from './SelectionStats';
import type { ColumnStat } from './column-stats';

const base: ColumnStat = {
  col: 0,
  name: 'price',
  cells: 4,
  count: 4,
  nulls: 0,
  numeric: false,
  numericCount: 0,
};

describe('summarizeSelection', () => {
  it('shows sum and average of a numeric column', () => {
    const s = { ...base, numeric: true, numericCount: 4, sum: 10, avg: 2.5 };
    expect(summarizeSelection([s], 4, 4)).toBe('count 4 · sum 10 · avg 2.5');
    expect(summarizeSelection([s, { ...base, col: 1, name: 'x' }], 8, 4)).toBe(
      'price: count 4 · sum 10 · avg 2.5',
    );
  });
  it('falls back to the cell count for non-numeric selections', () => {
    expect(summarizeSelection([base], 4, 4)).toBe('4 cells (4 × 1)');
  });
});
