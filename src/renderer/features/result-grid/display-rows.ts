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
  typeName?: string | null,
): IndexedRow[] {
  const withIdx: IndexedRow[] = rows.map((row, i) => ({
    row: row as unknown[],
    originalIndex: i,
  }));
  const { index, direction } = sortColumn;
  const kind = sortKindFor(typeName);
  withIdx.sort((a, b) => compareCells(a.row[index], b.row[index], direction, kind));
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

/** How a column's values compare (from its pg `dataTypeName`). */
export type SortKind = 'numeric' | 'temporal' | 'bool' | 'text';

const NUMERIC_TYPES = new Set([
  'int2',
  'int4',
  'int8',
  'float4',
  'float8',
  'numeric',
  'money',
  'oid',
  'smallint',
  'integer',
  'bigint',
  'real',
  'double precision',
  'decimal',
]);
const TEMPORAL_TYPES = new Set([
  'date',
  'timestamp',
  'timestamptz',
  'time',
  'timetz',
  'timestamp without time zone',
  'timestamp with time zone',
]);

export function sortKindFor(typeName: string | null | undefined): SortKind {
  const t = (typeName ?? '')
    .replace(/\(.*\)/, '')
    .trim()
    .toLowerCase();
  if (NUMERIC_TYPES.has(t)) return 'numeric';
  if (TEMPORAL_TYPES.has(t)) return 'temporal';
  if (t === 'bool' || t === 'boolean') return 'bool';
  return 'text';
}

/**
 * Compare two numeric values that may arrive as strings (int8 / numeric
 * are strings from pg to keep precision). Exact for arbitrarily long
 * integers and decimals — no Number() rounding.
 */
export function compareNumericText(a: string, b: string): number {
  const parse = (s: string) => {
    const t = s.trim();
    const neg = t.startsWith('-');
    const body = t.replace(/^[-+]/, '');
    const [intRaw = '', frac = ''] = body.split('.');
    const int = intRaw.replace(/^0+(?=\d)/, '');
    return { neg, int, frac: frac.replace(/0+$/, '') };
  };
  const x = parse(a);
  const y = parse(b);
  const sign = (v: { neg: boolean; int: string; frac: string }) =>
    /^0*$/.test(v.int) && v.frac === '' ? 0 : v.neg ? -1 : 1;
  const sx = sign(x);
  const sy = sign(y);
  if (sx !== sy) return sx < sy ? -1 : 1;
  if (sx === 0) return 0;
  let mag = 0;
  if (x.int.length !== y.int.length) mag = x.int.length < y.int.length ? -1 : 1;
  else if (x.int !== y.int) mag = x.int < y.int ? -1 : 1;
  else {
    const len = Math.max(x.frac.length, y.frac.length);
    const fx = x.frac.padEnd(len, '0');
    const fy = y.frac.padEnd(len, '0');
    mag = fx === fy ? 0 : fx < fy ? -1 : 1;
  }
  return x.neg ? -mag : mag;
}

const NUMERIC_TEXT = /^\s*[-+]?\d+(\.\d+)?\s*$/;

function temporalValue(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const t = Date.parse(v.includes('T') || !/^\d{4}-/.test(v) ? v : v.replace(' ', 'T'));
    return Number.isNaN(t) ? null : t;
  }
  if (typeof v === 'number') return v;
  return null;
}

export function compareCells(
  a: unknown,
  b: unknown,
  direction: 'asc' | 'desc',
  kind: SortKind = 'text',
): number {
  const mul = direction === 'asc' ? 1 : -1;
  const na = a === null || a === undefined;
  const nb = b === null || b === undefined;
  if (na && nb) return 0;
  if (na) return 1; // nulls sort last regardless of direction
  if (nb) return -1;
  // Numeric fast path
  if (typeof a === 'number' && typeof b === 'number') return (a - b) * mul;
  if (typeof a === 'bigint' && typeof b === 'bigint') return (a < b ? -1 : a > b ? 1 : 0) * mul;
  if (kind === 'numeric' || (typeof a === 'number') !== (typeof b === 'number')) {
    const sa = String(a);
    const sb = String(b);
    if (NUMERIC_TEXT.test(sa) && NUMERIC_TEXT.test(sb)) return compareNumericText(sa, sb) * mul;
    if (kind === 'numeric') {
      const fa = Number(sa);
      const fb = Number(sb);
      if (!Number.isNaN(fa) && !Number.isNaN(fb)) return (fa < fb ? -1 : fa > fb ? 1 : 0) * mul;
    }
  }
  if (kind === 'temporal' || a instanceof Date || b instanceof Date) {
    const ta = temporalValue(a);
    const tb = temporalValue(b);
    if (ta !== null && tb !== null) return (ta < tb ? -1 : ta > tb ? 1 : 0) * mul;
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') return (Number(a) - Number(b)) * mul;
  // Everything else: locale-aware, numeric-aware string order.
  const sa = typeof a === 'object' ? JSON.stringify(a) : String(a);
  const sb = typeof b === 'object' ? JSON.stringify(b) : String(b);
  return COLLATOR.compare(sa, sb) * mul;
}

const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'variant' });
