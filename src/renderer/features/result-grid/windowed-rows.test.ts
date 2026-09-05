import { describe, expect, it } from 'vitest';
import { ROW_HEIGHT_PX, computeRowWindow } from './windowed-rows';

describe('computeRowWindow', () => {
  it('returns empty window for zero rows', () => {
    expect(computeRowWindow(0, 0, 340)).toEqual({
      start: 0,
      end: 0,
      topPadPx: 0,
      bottomPadPx: 0,
    });
  });

  it('windows a tall list around the scroll position', () => {
    const total = 5000;
    const scrollTop = 1000; // ~row 29 at 34px
    const viewport = 340; // ~10 rows
    const w = computeRowWindow(total, scrollTop, viewport, ROW_HEIGHT_PX, 5);
    expect(w.start).toBeGreaterThanOrEqual(0);
    expect(w.end).toBeGreaterThan(w.start);
    expect(w.end - w.start).toBeLessThan(50);
    expect(w.topPadPx).toBe(w.start * ROW_HEIGHT_PX);
    expect(w.bottomPadPx + w.topPadPx + (w.end - w.start) * ROW_HEIGHT_PX).toBe(
      total * ROW_HEIGHT_PX,
    );
  });

  it('clamps to the end of the list', () => {
    const w = computeRowWindow(30, 10_000, 200, 34, 2);
    expect(w.end).toBe(30);
    expect(w.bottomPadPx).toBe(0);
  });
});
