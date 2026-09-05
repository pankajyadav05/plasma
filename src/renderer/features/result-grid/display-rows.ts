/**
 * Client-side page / sort helpers for SQL-tab result grids (U14).
 *
 * Unsorted pages slice first, then wrap only the visible rows — a 50-row
 * page over a 100k-row result must not allocate 100k `{row, originalIndex}`
 * wrappers. Sorted order is built once from `(rows, sort)` and reused
 * across page changes.
 */

export type IndexedRow = { row: unknown[]; originalIndex: number };

export type SortColumn = { index: number; direction: 'asc' | 'desc' };

/**
 * Slice the current page from an unsorted result, then wrap each visible
 * row with its absolute original index (used by selection / edit / delete).
 */
export function slicePageUnsorted(
  rows: readonly unknown[][],
  page: number,
  pageSize: number,
): IndexedRow[] {
  const start = Math.max(0, page * pageSize);
  const end = Math.min(start + pageSize, rows.length);
  const out: IndexedRow[] = new Array(Math.max(0, end - start));
  for (let i = start; i < end; i++) {
    out[i - start] = { row: rows[i] as unknown[], originalIndex: i };
  }
  return out;
}

/**
 * Wrap every row and sort by the given column. Memoize on `(rows, sort)`
 * only — page changes must not re-run this.
 */
export function sortRowsWithIndex(
  rows: readonly unknown[][],
  sortColumn: SortColumn,
): IndexedRow[] {
  const withIdx: IndexedRow[] = rows.map((row, i) => ({
    row: row as unknown[],
    originalIndex: i,
  }));
  const { index, direction } = sortColumn;
  withIdx.sort((a, b) => compareCells(a.row[index], b.row[index], direction));
  return withIdx;
}

/** Slice a page from a previously sorted/indexed row list. */
export function slicePageSorted(
  ordered: readonly IndexedRow[],
  page: number,
  pageSize: number,
): IndexedRow[] {
  const start = Math.max(0, page * pageSize);
  return ordered.slice(start, start + pageSize) as IndexedRow[];
}

export function compareCells(a: unknown, b: unknown, direction: 'asc' | 'desc'): number {
  const mul = direction === 'asc' ? 1 : -1;
  const na = a === null || a === undefined;
  const nb = b === null || b === undefined;
  if (na && nb) return 0;
  if (na) return 1; // nulls sort last regardless of direction
  if (nb) return -1;
  // Numeric fast path
  if (typeof a === 'number' && typeof b === 'number') return (a - b) * mul;
  // Compare as strings for everything else (matches pg's display order
  // well enough for most types; M3 can use type-aware comparators).
  const sa = String(a);
  const sb = String(b);
  if (sa < sb) return -1 * mul;
  if (sa > sb) return 1 * mul;
  return 0;
}
