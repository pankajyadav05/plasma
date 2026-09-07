/**
 * Pure keyboard-navigation helpers for the result grid (U38).
 *
 * Spreadsheet-style traversal: Tab advances to the next cell (wrapping to
 * the next row), Shift+Tab goes backward. Used by ResultGrid when Tab is
 * pressed on a selected cell or while an inline edit is open.
 */

export type CellCoord = { row: number; col: number };

/**
 * Next cell after `current` within a `rowCount × colCount` grid.
 * Returns null when the grid is empty or dimensions are invalid.
 * Wraps from the last cell back to the first.
 */
export function nextCell(
  current: CellCoord,
  rowCount: number,
  colCount: number,
): CellCoord | null {
  if (rowCount <= 0 || colCount <= 0) return null;
  const row = clamp(current.row, 0, rowCount - 1);
  const col = clamp(current.col, 0, colCount - 1);
  if (col < colCount - 1) return { row, col: col + 1 };
  if (row < rowCount - 1) return { row: row + 1, col: 0 };
  return { row: 0, col: 0 };
}

/**
 * Previous cell before `current`. Wraps from the first cell to the last.
 */
export function prevCell(
  current: CellCoord,
  rowCount: number,
  colCount: number,
): CellCoord | null {
  if (rowCount <= 0 || colCount <= 0) return null;
  const row = clamp(current.row, 0, rowCount - 1);
  const col = clamp(current.col, 0, colCount - 1);
  if (col > 0) return { row, col: col - 1 };
  if (row > 0) return { row: row - 1, col: colCount - 1 };
  return { row: rowCount - 1, col: colCount - 1 };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
