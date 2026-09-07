import { describe, expect, it } from 'vitest';
import {
  compareCells,
  slicePageSorted,
  slicePageUnsorted,
  sortRowsWithIndex,
} from './display-rows';

describe('slicePageUnsorted', () => {
  it('wraps only the visible page and keeps absolute originalIndex', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => [i, `r${i}`]);
    const page = slicePageUnsorted(rows, 2, 50);
    expect(page).toHaveLength(50);
    expect(page[0]).toEqual({ row: [100, 'r100'], originalIndex: 100 });
    expect(page[49]).toEqual({ row: [149, 'r149'], originalIndex: 149 });
  });

  it('does not allocate wrappers for rows outside the page', () => {
    const rows = Array.from({ length: 100_000 }, (_, i) => [i]);
    const page = slicePageUnsorted(rows, 0, 50);
    expect(page).toHaveLength(50);
    expect(page[0].originalIndex).toBe(0);
    expect(page[49].originalIndex).toBe(49);
  });

  it('clamps the final short page', () => {
    const rows = [[0], [1], [2]];
    expect(slicePageUnsorted(rows, 1, 2)).toEqual([{ row: [2], originalIndex: 2 }]);
    expect(slicePageUnsorted(rows, 5, 10)).toEqual([]);
  });
});

describe('sortRowsWithIndex + slicePageSorted', () => {
  const rows = [
    ['b', 2],
    ['a', 1],
    ['c', 3],
    ['a', 0],
  ];

  it('memoizable sorted order is independent of page', () => {
    const ordered = sortRowsWithIndex(rows, { index: 0, direction: 'asc' });
    expect(ordered.map((e) => e.row[0])).toEqual(['a', 'a', 'b', 'c']);
    expect(ordered.map((e) => e.originalIndex)).toEqual([1, 3, 0, 2]);

    expect(slicePageSorted(ordered, 0, 2).map((e) => e.originalIndex)).toEqual([1, 3]);
    expect(slicePageSorted(ordered, 1, 2).map((e) => e.originalIndex)).toEqual([0, 2]);
  });

  it('sorts descending and leaves nulls last', () => {
    const withNull = [[null], [3], [1], [null], [2]];
    const ordered = sortRowsWithIndex(withNull, { index: 0, direction: 'desc' });
    expect(ordered.map((e) => e.row[0])).toEqual([3, 2, 1, null, null]);
  });
});

describe('compareCells', () => {
  it('compares numbers and strings', () => {
    expect(compareCells(1, 2, 'asc')).toBeLessThan(0);
    expect(compareCells(1, 2, 'desc')).toBeGreaterThan(0);
    expect(compareCells('a', 'b', 'asc')).toBeLessThan(0);
  });
});
