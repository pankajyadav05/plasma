/**
 * Safe Run: turn a report's BEFORE / AFTER rows into the rows the review
 * grid draws. Pure, so the pairing rules are unit-tested.
 *
 *   - INSERT: every returned row is `inserted`.
 *   - DELETE: every captured row is `deleted`.
 *   - UPDATE: rows are paired by primary / unique key; when the table has
 *     none, by physical order of `ctid` (an UPDATE gives a row a new ctid,
 *     so this is only trusted when both sides hold the same number of rows).
 *     Rows that cannot be paired are shown as `old` (before) and `new`.
 *   - Anything else (MERGE, CTE, UPDATE without a before snapshot): the rows
 *     the statement returned, as `new`.
 */
import type { ColumnMeta, SafeRunReport, SafeRunStep } from './protocol';

/** A single-statement report, or one step of a script report. */
export type SafeRunDiffInput = SafeRunReport | SafeRunStep;

export type DiffStatus = 'changed' | 'unchanged' | 'deleted' | 'inserted' | 'old' | 'new';

export interface DiffRow {
  status: DiffStatus;
  before: unknown[] | null;
  after: unknown[] | null;
  /** Per displayed column: the cell differs between before and after. */
  changed: boolean[];
}

export interface SafeRunDiff {
  columns: ColumnMeta[];
  rows: DiffRow[];
  /** How many rows an UPDATE left as they were. */
  unchangedCount: number;
  /** BEFORE and AFTER could be lined up row by row. */
  paired: boolean;
  /** How the pairing was done, for the caption under the grid. */
  pairing: 'key' | 'ctid-order' | 'none';
}

/** Stable text for a cell so objects, arrays and bigints compare by value. */
export function cellKey(v: unknown): string {
  if (v === null || v === undefined) return '\u0000null';
  if (typeof v === 'bigint') return `b:${v}`;
  if (v instanceof Date) return `d:${v.getTime()}`;
  if (typeof v === 'object') {
    try {
      return `o:${JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x))}`;
    } catch {
      return `o:${String(v)}`;
    }
  }
  return `${typeof v}:${String(v)}`;
}

/** `(12,3)` → [12, 3]; anything else sorts last. */
function ctidParts(c: string): [number, number] {
  const m = /^\((\d+),(\d+)\)$/.exec(c);
  return m ? [Number(m[1]), Number(m[2])] : [Number.MAX_SAFE_INTEGER, 0];
}

function orderByCtid(rows: unknown[][], ctids: string[]): unknown[][] {
  return rows
    .map((row, i) => ({ row, ct: ctidParts(ctids[i] ?? '') }))
    .sort((a, b) => a.ct[0] - b.ct[0] || a.ct[1] - b.ct[1])
    .map((x) => x.row);
}

function mark(
  status: DiffStatus,
  before: unknown[] | null,
  after: unknown[] | null,
  n: number,
): DiffRow {
  return { status, before, after, changed: new Array<boolean>(n).fill(false) };
}

export function buildSafeRunDiff(report: SafeRunDiffInput): SafeRunDiff {
  const afterOnlyColumns = report.afterColumns;

  if (report.kind === 'insert') {
    const n = afterOnlyColumns.length;
    return {
      columns: afterOnlyColumns,
      rows: report.after.map((r) => mark('inserted', null, r, n)),
      unchangedCount: 0,
      paired: true,
      pairing: 'none',
    };
  }

  const hasBefore = report.mode === 'diff' && report.before !== null;

  if (report.kind === 'delete') {
    if (hasBefore) {
      const n = report.beforeColumns.length;
      return {
        columns: report.beforeColumns,
        rows: report.before!.map((r) => mark('deleted', r, null, n)),
        unchangedCount: 0,
        paired: true,
        pairing: 'none',
      };
    }
    const n = afterOnlyColumns.length;
    return {
      columns: afterOnlyColumns,
      rows: report.after.map((r) => mark('deleted', null, r, n)),
      unchangedCount: 0,
      paired: true,
      pairing: 'none',
    };
  }

  if (report.kind !== 'update' || !hasBefore) {
    const n = afterOnlyColumns.length;
    return {
      columns: afterOnlyColumns,
      rows: report.after.map((r) => mark('new', null, r, n)),
      unchangedCount: 0,
      paired: false,
      pairing: 'none',
    };
  }

  // UPDATE with a before snapshot.
  const columns = report.beforeColumns;
  const afterIndex = new Map(afterOnlyColumns.map((c, i) => [c.name, i] as const));
  // Column i of the display → index in an AFTER row (or -1 when it was not returned).
  const map = columns.map((c) => afterIndex.get(c.name) ?? -1);
  const project = (row: unknown[]): unknown[] => map.map((ix) => (ix >= 0 ? row[ix] : undefined));
  const comparable = (before: unknown[], after: unknown[]): boolean[] =>
    columns.map((_c, i) => map[i]! >= 0 && cellKey(before[i]) !== cellKey(after[i]));

  const before = report.before!;
  type Pair = { b: unknown[]; a: unknown[] };
  const pairs: Pair[] = [];
  const oldOnly: unknown[][] = [];
  const newOnly: unknown[][] = [];
  let pairing: SafeRunDiff['pairing'] = 'none';

  const keyIdx = report.keyColumns.map((k) => columns.findIndex((c) => c.name === k));
  const keyInAfter = report.keyColumns.every((k) => afterIndex.has(k));
  const keyed =
    (report.keyKind === 'pk' || report.keyKind === 'unique') &&
    report.keyColumns.length > 0 &&
    keyIdx.every((i) => i >= 0) &&
    keyInAfter;

  if (keyed) {
    pairing = 'key';
    const keyOf = (row: unknown[], idx: number[]) => idx.map((i) => cellKey(row[i])).join('\u0001');
    const afterKeyIdx = report.keyColumns.map((k) => afterIndex.get(k)!);
    const byKey = new Map<string, unknown[]>();
    for (const a of report.after) byKey.set(keyOf(a, afterKeyIdx), a);
    const used = new Set<string>();
    for (const b of before) {
      const k = keyOf(b, keyIdx);
      const a = byKey.get(k);
      if (a && !used.has(k)) {
        used.add(k);
        pairs.push({ b, a: project(a) });
      } else oldOnly.push(b);
    }
    for (const [k, a] of byKey) if (!used.has(k)) newOnly.push(a);
  } else if (
    report.keyKind === 'ctid' &&
    report.beforeCtids &&
    report.afterCtids &&
    before.length === report.after.length &&
    columns.every((_c, i) => map[i]! >= 0) &&
    before.length === report.beforeTotal &&
    report.after.length === report.afterTotal
  ) {
    pairing = 'ctid-order';
    const b = orderByCtid(before, report.beforeCtids);
    const a = orderByCtid(report.after, report.afterCtids);
    for (let i = 0; i < b.length; i++) pairs.push({ b: b[i]!, a: project(a[i]!) });
  } else {
    for (const b of before) oldOnly.push(b);
    for (const a of report.after) newOnly.push(a);
  }

  // When either side was cut at the row cap, the two prefixes need not
  // cover the same rows: an unmatched row is probably just beyond the cap,
  // so only the matched pairs are shown.
  const capped = report.beforeTotal > before.length || report.afterTotal > report.after.length;
  if (capped) {
    oldOnly.length = 0;
    newOnly.length = 0;
  }

  const rows: DiffRow[] = [];
  let unchangedCount = 0;
  for (const { b, a } of pairs) {
    const changed = comparable(b, a);
    const any = changed.some(Boolean);
    if (!any) unchangedCount++;
    rows.push({ status: any ? 'changed' : 'unchanged', before: b, after: a, changed });
  }
  const n = columns.length;
  for (const b of oldOnly) rows.push(mark('old', b, null, n));
  for (const a of newOnly) rows.push({ ...mark('new', null, project(a), n) });

  return {
    columns,
    rows,
    unchangedCount,
    paired: !capped && oldOnly.length === 0 && newOnly.length === 0,
    pairing,
  };
}
