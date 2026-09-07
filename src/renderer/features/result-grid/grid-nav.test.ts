import { describe, expect, it } from 'vitest';
import { nextCell, prevCell } from './grid-nav';

describe('nextCell', () => {
  it('returns null for empty grids', () => {
    expect(nextCell({ row: 0, col: 0 }, 0, 3)).toBeNull();
    expect(nextCell({ row: 0, col: 0 }, 2, 0)).toBeNull();
  });

  it('advances within a row', () => {
    expect(nextCell({ row: 1, col: 0 }, 3, 4)).toEqual({ row: 1, col: 1 });
  });

  it('wraps to the next row after the last column', () => {
    expect(nextCell({ row: 0, col: 3 }, 3, 4)).toEqual({ row: 1, col: 0 });
  });

  it('wraps from the last cell to the first', () => {
    expect(nextCell({ row: 2, col: 3 }, 3, 4)).toEqual({ row: 0, col: 0 });
  });

  it('clamps out-of-range coords before advancing', () => {
    expect(nextCell({ row: 99, col: 99 }, 3, 4)).toEqual({ row: 0, col: 0 });
  });
});

describe('prevCell', () => {
  it('returns null for empty grids', () => {
    expect(prevCell({ row: 0, col: 0 }, 0, 3)).toBeNull();
  });

  it('moves backward within a row', () => {
    expect(prevCell({ row: 1, col: 2 }, 3, 4)).toEqual({ row: 1, col: 1 });
  });

  it('wraps to the previous row before the first column', () => {
    expect(prevCell({ row: 1, col: 0 }, 3, 4)).toEqual({ row: 0, col: 3 });
  });

  it('wraps from the first cell to the last', () => {
    expect(prevCell({ row: 0, col: 0 }, 3, 4)).toEqual({ row: 2, col: 3 });
  });
});
