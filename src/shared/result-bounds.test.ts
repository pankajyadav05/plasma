import { describe, expect, it } from 'vitest';
import {
  FIRST_CURSOR_CHUNK,
  MAX_RESULT_BYTES,
  MAX_RESULT_ROWS,
  RESULT_CURSOR_CHUNK,
  appendBoundedRows,
  emptyBoundState,
  estimateCellBytes,
  estimateRowBytes,
  nextCursorChunk,
} from './result-bounds';

describe('estimateCellBytes / estimateRowBytes', () => {
  it('sizes primitives and nulls', () => {
    expect(estimateCellBytes(null)).toBe(4);
    expect(estimateCellBytes(1)).toBe(8);
    expect(estimateCellBytes('abc')).toBe(6);
  });

  it('sums cells for a row', () => {
    expect(estimateRowBytes(['hi', 1, null])).toBe(8 + 4 + 8 + 4);
  });
});

describe('appendBoundedRows', () => {
  it('stops at the row cap and sets truncated', () => {
    const state = emptyBoundState();
    const batch = Array.from({ length: 5 }, (_, i) => [i]);
    const stop = appendBoundedRows(state, batch, 3, MAX_RESULT_BYTES);
    expect(stop).toBe(true);
    expect(state.truncated).toBe(true);
    expect(state.rows).toHaveLength(3);
    expect(state.rows.map((r) => r[0])).toEqual([0, 1, 2]);
  });

  it('stops at the byte cap', () => {
    const state = emptyBoundState();
    const big = 'x'.repeat(1000);
    const batch = [[big], [big], [big]];
    const stop = appendBoundedRows(state, batch, MAX_RESULT_ROWS, 2500);
    expect(stop).toBe(true);
    expect(state.truncated).toBe(true);
    expect(state.rows.length).toBeLessThan(3);
    expect(state.rows.length).toBeGreaterThan(0);
  });

  it('returns true on empty batch without truncating', () => {
    const state = emptyBoundState();
    expect(appendBoundedRows(state, [])).toBe(true);
    expect(state.truncated).toBe(false);
    expect(state.rows).toHaveLength(0);
  });

  it('accepts a full under-budget batch', () => {
    const state = emptyBoundState();
    const stop = appendBoundedRows(state, [[1], [2]], 10, MAX_RESULT_BYTES);
    expect(stop).toBe(false);
    expect(state.truncated).toBe(false);
    expect(state.rows).toHaveLength(2);
  });
});

describe('nextCursorChunk (P2-3)', () => {
  it('asks for the full chunk when rows are narrow', () => {
    expect(nextCursorChunk(Array.from({ length: 100 }, () => [1, 'a']))).toBe(RESULT_CURSOR_CHUNK);
  });

  it('shrinks the read when rows are wide', () => {
    const wide = [['x'.repeat(500_000)]];
    const n = nextCursorChunk(wide);
    expect(n).toBeLessThan(10);
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it('falls back to the first-chunk size with no sample', () => {
    expect(nextCursorChunk([])).toBe(FIRST_CURSOR_CHUNK);
  });
});
