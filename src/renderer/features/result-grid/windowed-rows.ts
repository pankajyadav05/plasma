/**
 * Viewport window over a page of display rows (U15 step 4).
 *
 * Replaces the hard MAX_DOM_ROWS clamp with a scroll-driven window so
 * large pageSize values do not mount thousands of <tr> nodes.
 */

export const ROW_HEIGHT_PX = 34;
/** Extra rows above/below the viewport to reduce scroll flicker. */
export const ROW_OVERSCAN = 20;

export type RowWindow = {
  start: number;
  end: number; // exclusive
  topPadPx: number;
  bottomPadPx: number;
};

/**
 * Compute the inclusive-exclusive index window for a vertical scrollport.
 * `scrollTop`/`viewportHeight` are in CSS pixels; `total` is row count.
 */
export function computeRowWindow(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number = ROW_HEIGHT_PX,
  overscan: number = ROW_OVERSCAN,
): RowWindow {
  if (total <= 0) {
    return { start: 0, end: 0, topPadPx: 0, bottomPadPx: 0 };
  }
  const safeScroll = Math.max(0, scrollTop);
  const safeViewport = Math.max(rowHeight, viewportHeight);
  const first = Math.floor(safeScroll / rowHeight);
  const visible = Math.ceil(safeViewport / rowHeight) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(total, first + visible + overscan);
  return {
    start,
    end,
    topPadPx: start * rowHeight,
    bottomPadPx: Math.max(0, total - end) * rowHeight,
  };
}
