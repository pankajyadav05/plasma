/**
 * Result Compare engine (C2): diff two result sets by key.
 *
 * Pure and framework-free. The caller keeps the two row arrays; the diff
 * only holds row *indices* into them, so a 200k-row compare does not copy
 * the data. Work runs in slices and yields between them, so the UI thread
 * stays responsive (`compareResults` is async for that reason only).
 *
 * Rules worth knowing:
 *  - Columns are matched by name (exact, then case-insensitive). A column on
 *    one side only is reported and never compared.
 *  - NULL equals NULL, and NULL never equals an empty string.
 *  - A column is numeric when either side's type says so; numbers then
 *    compare as numbers (so `1.50` equals `1.5`, and a tolerance applies).
 *    Integers past 2^53 compare exactly as decimal text, never as floats.
 *  - A key that appears more than once on a side is reported as a
 *    duplicate and is not compared (merging it would hide a real problem).
 *  - With no key columns, whole rows are compared as a multiset.
 */

export const MAX_COMPARE_ROWS = 200_000;

export interface CompareSource {
  columns: string[];
  /** Driver type names, same order as `columns` (used to spot numeric columns). */
  types?: string[];
  rows: unknown[][];
}

export interface CompareOptions {
  /** Key column names; empty compares whole rows as a multiset. */
  keys: string[];
  /** Columns left out of the comparison (e.g. `updated_at`). */
  ignore: string[];
  /** Absolute tolerance for numeric columns (0 = exact). */
  tolerance: number;
  ignoreCase: boolean;
  /** Ignore leading, trailing and repeated whitespace in text. */
  trimWhitespace: boolean;
}

export const DEFAULT_COMPARE_OPTIONS: CompareOptions = {
  keys: [],
  ignore: [],
  tolerance: 0,
  ignoreCase: false,
  trimWhitespace: false,
};

export type DiffKind = 'added' | 'removed' | 'changed' | 'unchanged' | 'duplicate';

export interface DiffRow {
  kind: DiffKind;
  /** Index into the left rows, or -1. */
  li: number;
  /** Index into the right rows, or -1. */
  ri: number;
  /** Indices into `DiffResult.columns` of cells that differ (changed rows). */
  changed: number[];
  /** Duplicate keys: every row index on each side. */
  lis?: number[];
  ris?: number[];
}

export interface DiffSummary {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  /** Distinct keys that repeat on at least one side. */
  duplicates: number;
}

export interface DiffResult {
  /** Compared columns, in left order (key columns first). */
  columns: string[];
  /** Per compared column: its index in the left / right source, or -1. */
  leftIndex: number[];
  rightIndex: number[];
  /** Key columns (subset of `columns`), as resolved. */
  keys: string[];
  keyIndexes: number[];
  /** Columns present on one side only. */
  onlyLeft: string[];
  onlyRight: string[];
  /** Ignored columns that were found. */
  ignored: string[];
  summary: DiffSummary;
  rows: DiffRow[];
  /** Per column: how many changed cells. */
  changedPerColumn: number[];
}

export class CompareError extends Error {
  constructor(
    readonly code: 'too-large' | 'missing-key' | 'no-columns' | 'cancelled',
    message: string,
  ) {
    super(message);
    this.name = 'CompareError';
  }
}

export interface CompareRunOptions {
  /** Rows handled per slice before yielding (default 4000). */
  sliceRows?: number;
  /** Awaited between slices; default is a macrotask turn. */
  yieldFn?: () => Promise<void>;
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
}

// ───────────────────────── value normalisation ─────────────────────────

const NUMERIC_TYPE =
  /^(int|integer|smallint|bigint|tinyint|mediumint|serial|bigserial|numeric|decimal|dec|number|float|double|real|money|oid|uint|int\d+|uint\d+|float\d+|decimal\(.*\)|numeric\(.*\))/i;

/** True for driver type names of numeric columns (int4, numeric, DOUBLE, UInt32, …). */
export function isNumericType(typeName: string | undefined): boolean {
  if (!typeName) return false;
  return NUMERIC_TYPE.test(typeName.trim());
}

const DECIMAL_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/** Canonical decimal text: no `+`, no leading or trailing zeros, `-0` is `0`. null when not a plain decimal. */
export function canonicalDecimal(text: string): string | null {
  const s = text.trim();
  if (!DECIMAL_RE.test(s)) {
    // Exponent form: only trust it when it round-trips through Number.
    if (/^[+-]?(\d+\.?\d*|\.\d+)[eE][+-]?\d+$/.test(s)) {
      const n = Number(s);
      return Number.isFinite(n) ? canonicalFromNumber(n) : null;
    }
    return null;
  }
  let sign = '';
  let body = s;
  if (body.startsWith('-')) {
    sign = '-';
    body = body.slice(1);
  } else if (body.startsWith('+')) body = body.slice(1);
  let [int = '', frac = ''] = body.split('.');
  int = int.replace(/^0+(?=\d)/, '');
  frac = frac.replace(/0+$/, '');
  if (int === '') int = '0';
  const out = frac ? `${int}.${frac}` : int;
  return out === '0' ? '0' : `${sign}${out}`;
}

function canonicalFromNumber(n: number): string {
  if (Object.is(n, -0)) return '0';
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n);
  // Avoid exponent form for ordinary magnitudes.
  const s = String(n);
  if (!/e/i.test(s)) return canonicalDecimal(s) ?? s;
  return canonicalDecimal(n.toFixed(20)) ?? s;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

const NULL_TOKEN = '\u0000null';

/** A cell reduced to a comparable token (equal tokens = equal cells, tolerance aside). */
export function cellToken(value: unknown, numeric: boolean, o: CompareOptions): string {
  if (value === null || value === undefined) return NULL_TOKEN;
  if (typeof value === 'number' || typeof value === 'bigint') {
    return `n:${typeof value === 'bigint' ? String(value) : canonicalFromNumber(value)}`;
  }
  if (typeof value === 'boolean') return `b:${value}`;
  if (value instanceof Date) return `s:${value.toISOString()}`;
  if (value instanceof Uint8Array) {
    return `x:${Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  if (typeof value === 'object') return `j:${stableStringify(value)}`;
  let s = String(value);
  if (numeric) {
    const d = canonicalDecimal(s);
    if (d !== null) return `n:${d}`;
  }
  if (o.trimWhitespace) s = s.trim().replace(/\s+/g, ' ');
  if (o.ignoreCase) s = s.toLowerCase();
  return `s:${s}`;
}

function tokenNumber(token: string): number | null {
  if (!token.startsWith('n:')) return null;
  const n = Number(token.slice(2));
  return Number.isFinite(n) ? n : null;
}

/** Equal tokens, or numbers within the tolerance. */
function tokensEqual(a: string, b: string, tolerance: number): boolean {
  if (a === b) return true;
  if (tolerance > 0) {
    const x = tokenNumber(a);
    const y = tokenNumber(b);
    if (x !== null && y !== null) return Math.abs(x - y) <= tolerance;
  }
  return false;
}

// ───────────────────────────── the diff ─────────────────────────────

function resolveColumns(source: CompareSource, name: string): number {
  const exact = source.columns.indexOf(name);
  if (exact >= 0) return exact;
  const lower = name.toLowerCase();
  return source.columns.findIndex((c) => c.toLowerCase() === lower);
}

const defaultYield = () => new Promise<void>((r) => setTimeout(r, 0));

export async function compareResults(
  left: CompareSource,
  right: CompareSource,
  options: CompareOptions,
  run: CompareRunOptions = {},
): Promise<DiffResult> {
  if (left.rows.length > MAX_COMPARE_ROWS || right.rows.length > MAX_COMPARE_ROWS) {
    throw new CompareError(
      'too-large',
      `Compare handles up to ${MAX_COMPARE_ROWS.toLocaleString()} rows per side. Narrow the query with a WHERE or LIMIT.`,
    );
  }
  const o = options;
  const ignore = new Set(o.ignore.map((c) => c.toLowerCase()));

  // Compared columns: left order, present on both sides, not ignored.
  const columns: string[] = [];
  const leftIndex: number[] = [];
  const rightIndex: number[] = [];
  const onlyLeft: string[] = [];
  const ignored: string[] = [];
  const usedRight = new Set<number>();
  left.columns.forEach((name, li) => {
    const ri = resolveColumns(right, name);
    if (ignore.has(name.toLowerCase())) {
      ignored.push(name);
      if (ri >= 0) usedRight.add(ri);
      return;
    }
    if (ri < 0) {
      onlyLeft.push(name);
      return;
    }
    usedRight.add(ri);
    columns.push(name);
    leftIndex.push(li);
    rightIndex.push(ri);
  });
  const onlyRight = right.columns.filter(
    (name, ri) => !usedRight.has(ri) && !ignore.has(name.toLowerCase()),
  );
  if (columns.length === 0) {
    throw new CompareError('no-columns', 'The two results have no column in common to compare.');
  }

  // Keys first (in the order chosen), then the other columns.
  const keyNames: string[] = [];
  for (const k of o.keys) {
    const at = columns.findIndex((c) => c.toLowerCase() === k.toLowerCase());
    if (at < 0) {
      throw new CompareError(
        'missing-key',
        `Key column "${k}" is not in both results (or is ignored).`,
      );
    }
    if (!keyNames.includes(columns[at]!)) keyNames.push(columns[at]!);
  }
  const order = [
    ...keyNames.map((k) => columns.indexOf(k)),
    ...columns.map((_, i) => i).filter((i) => !keyNames.includes(columns[i]!)),
  ];
  const ordered = {
    columns: order.map((i) => columns[i]!),
    leftIndex: order.map((i) => leftIndex[i]!),
    rightIndex: order.map((i) => rightIndex[i]!),
  };
  const keyIndexes = keyNames.map((_, i) => i);
  const numeric = ordered.columns.map(
    (_, i) =>
      isNumericType(left.types?.[ordered.leftIndex[i]!]) ||
      isNumericType(right.types?.[ordered.rightIndex[i]!]),
  );

  const sliceRows = run.sliceRows ?? 4000;
  const yieldFn = run.yieldFn ?? defaultYield;
  const total = left.rows.length + right.rows.length;
  let done = 0;
  const tick = async (n: number) => {
    done += n;
    if (run.isCancelled?.()) throw new CompareError('cancelled', 'Comparison cancelled.');
    run.onProgress?.(Math.min(done, total), total);
    await yieldFn();
  };

  // Tokens per row, per compared column; keys joined into one string.
  const tokensOf = (row: unknown[], side: 'l' | 'r'): string[] => {
    const idx = side === 'l' ? ordered.leftIndex : ordered.rightIndex;
    return idx.map((ci, i) => cellToken(row[ci], numeric[i]!, o));
  };
  const keyOf = (tokens: string[]): string =>
    keyIndexes.length > 0 ? keyIndexes.map((i) => tokens[i]).join('\u0001') : tokens.join('\u0001');

  // Index the right side: key → row indices (+ tokens cached for the match).
  const rightByKey = new Map<string, number[]>();
  const rightTokens: string[][] = new Array(right.rows.length);
  for (let i = 0; i < right.rows.length; i++) {
    const t = tokensOf(right.rows[i]!, 'r');
    rightTokens[i] = t;
    const k = keyOf(t);
    const list = rightByKey.get(k);
    if (list) list.push(i);
    else rightByKey.set(k, [i]);
    if ((i + 1) % sliceRows === 0) await tick(sliceRows);
  }

  // Left side: group by key too, so duplicates are known before matching.
  const leftByKey = new Map<string, number[]>();
  const leftTokens: string[][] = new Array(left.rows.length);
  const leftOrder: string[] = [];
  for (let i = 0; i < left.rows.length; i++) {
    const t = tokensOf(left.rows[i]!, 'l');
    leftTokens[i] = t;
    const k = keyOf(t);
    const list = leftByKey.get(k);
    if (list) list.push(i);
    else {
      leftByKey.set(k, [i]);
      leftOrder.push(k);
    }
    if ((i + 1) % sliceRows === 0) await tick(sliceRows);
  }

  const rows: DiffRow[] = [];
  const summary: DiffSummary = { added: 0, removed: 0, changed: 0, unchanged: 0, duplicates: 0 };
  const changedPerColumn = new Array<number>(ordered.columns.length).fill(0);
  const keyless = keyIndexes.length === 0;
  const seenRight = new Set<string>();
  let processed = 0;

  for (const k of leftOrder) {
    const lis = leftByKey.get(k)!;
    const ris = rightByKey.get(k);
    seenRight.add(k);
    if (keyless) {
      // Multiset: pair equal rows one-to-one, the surplus is added / removed.
      const rn = ris?.length ?? 0;
      const paired = Math.min(lis.length, rn);
      for (let n = 0; n < lis.length; n++) {
        if (n < paired) {
          rows.push({ kind: 'unchanged', li: lis[n]!, ri: ris![n]!, changed: [] });
          summary.unchanged++;
        } else {
          rows.push({ kind: 'removed', li: lis[n]!, ri: -1, changed: [] });
          summary.removed++;
        }
      }
      for (let n = paired; n < rn; n++) {
        rows.push({ kind: 'added', li: -1, ri: ris![n]!, changed: [] });
        summary.added++;
      }
    } else if (lis.length > 1 || (ris?.length ?? 0) > 1) {
      rows.push({
        kind: 'duplicate',
        li: lis[0]!,
        ri: ris?.[0] ?? -1,
        changed: [],
        lis,
        ris: ris ?? [],
      });
      summary.duplicates++;
    } else if (!ris) {
      rows.push({ kind: 'removed', li: lis[0]!, ri: -1, changed: [] });
      summary.removed++;
    } else {
      const lt = leftTokens[lis[0]!]!;
      const rt = rightTokens[ris[0]!]!;
      const changed: number[] = [];
      for (let c = 0; c < lt.length; c++) {
        if (!tokensEqual(lt[c]!, rt[c]!, o.tolerance)) {
          changed.push(c);
          changedPerColumn[c]!++;
        }
      }
      if (changed.length === 0) {
        rows.push({ kind: 'unchanged', li: lis[0]!, ri: ris[0]!, changed });
        summary.unchanged++;
      } else {
        rows.push({ kind: 'changed', li: lis[0]!, ri: ris[0]!, changed });
        summary.changed++;
      }
    }
    processed += lis.length;
    if (processed >= sliceRows) {
      await tick(processed);
      processed = 0;
    }
  }
  // Right-only keys, in right order.
  const rightKeysInOrder = new Set<string>();
  for (let i = 0; i < right.rows.length; i++) {
    const k = keyOf(rightTokens[i]!);
    if (seenRight.has(k) || rightKeysInOrder.has(k)) continue;
    rightKeysInOrder.add(k);
    const ris = rightByKey.get(k)!;
    if (!keyless && ris.length > 1) {
      rows.push({ kind: 'duplicate', li: -1, ri: ris[0]!, changed: [], lis: [], ris });
      summary.duplicates++;
    } else {
      for (const ri of ris) {
        rows.push({ kind: 'added', li: -1, ri, changed: [] });
        summary.added++;
      }
    }
  }
  run.onProgress?.(total, total);

  return {
    columns: ordered.columns,
    leftIndex: ordered.leftIndex,
    rightIndex: ordered.rightIndex,
    keys: keyNames,
    keyIndexes,
    onlyLeft,
    onlyRight,
    ignored,
    summary,
    rows,
    changedPerColumn,
  };
}

// ───────────────────────── reading cells back ─────────────────────────

/** The A-side value of compared column `c` of `row`, or undefined when the row has no A side. */
export function leftCell(d: DiffResult, left: CompareSource, row: DiffRow, c: number): unknown {
  return row.li < 0 ? undefined : left.rows[row.li]?.[d.leftIndex[c]!];
}

/** The B-side value of compared column `c` of `row`, or undefined when the row has no B side. */
export function rightCell(d: DiffResult, right: CompareSource, row: DiffRow, c: number): unknown {
  return row.ri < 0 ? undefined : right.rows[row.ri]?.[d.rightIndex[c]!];
}

/** Rows to show for a filter set (`unchanged` off = differences only). */
export function filterRows(rows: DiffRow[], show: ReadonlySet<DiffKind>): DiffRow[] {
  return rows.filter((r) => show.has(r.kind));
}

// ───────────────────────────── key suggestion ─────────────────────────────

export interface KeySuggestion {
  keys: string[];
  reason: 'primary key' | 'unique column' | 'unique columns';
}

const ID_LIKE = /^(id|uuid|guid|pk|key|code|number|no)$|(_id|_uuid|_key|_code|id)$/i;

/**
 * Likely key columns for a result, best first. A candidate must be present
 * in both sources, non-null and unique in each. `primaryKeys` are the
 * primary-key column sets known from the schema (matched case-insensitively).
 */
export function suggestKeys(
  left: CompareSource,
  right: CompareSource | null,
  primaryKeys: string[][] = [],
  ignore: string[] = [],
): KeySuggestion[] {
  const skip = new Set(ignore.map((c) => c.toLowerCase()));
  const shared = left.columns.filter(
    (c) =>
      !skip.has(c.toLowerCase()) &&
      (right === null || right.columns.some((r) => r.toLowerCase() === c.toLowerCase())),
  );
  const opts: CompareOptions = DEFAULT_COMPARE_OPTIONS;
  const SAMPLE = 20_000;
  const uniqueIn = (src: CompareSource, names: string[]): boolean => {
    const idx = names.map((n) => resolveColumns(src, n));
    if (idx.some((i) => i < 0)) return false;
    const numeric = idx.map((i) => isNumericType(src.types?.[i]));
    const seen = new Set<string>();
    const n = Math.min(src.rows.length, SAMPLE);
    for (let r = 0; r < n; r++) {
      const toks = idx.map((ci, j) => cellToken(src.rows[r]![ci], numeric[j]!, opts));
      if (toks.some((t) => t === NULL_TOKEN)) return false;
      const k = toks.join('\u0001');
      if (seen.has(k)) return false;
      seen.add(k);
    }
    return n > 0;
  };
  const ok = (names: string[]) =>
    uniqueIn(left, names) && (right === null || uniqueIn(right, names));
  const out: KeySuggestion[] = [];
  const have = (keys: string[]) => out.some((s) => s.keys.join() === keys.join());

  for (const pk of primaryKeys) {
    const names = pk.map((p) => shared.find((c) => c.toLowerCase() === p.toLowerCase()));
    if (names.length > 0 && names.every((n): n is string => n !== undefined) && ok(names)) {
      out.push({ keys: names, reason: 'primary key' });
    }
  }
  const singles = shared
    .filter((c) => ok([c]))
    .sort((a, b) => Number(ID_LIKE.test(b)) - Number(ID_LIKE.test(a)));
  for (const c of singles) if (!have([c])) out.push({ keys: [c], reason: 'unique column' });
  if (singles.length === 0) {
    // Pairs, among the id-like columns first, bounded.
    const pool = [
      ...shared.filter((c) => ID_LIKE.test(c)),
      ...shared.filter((c) => !ID_LIKE.test(c)),
    ].slice(0, 8);
    pairs: for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const pair = [pool[i]!, pool[j]!];
        if (ok(pair)) {
          out.push({ keys: pair, reason: 'unique columns' });
          break pairs;
        }
      }
    }
  }
  return out.slice(0, 4);
}

// ───────────────────────────── export ─────────────────────────────

export interface DiffExport {
  columns: string[];
  rows: unknown[][];
}

/**
 * The diff as a flat table: `diff`, `changed_columns`, the key columns once,
 * then `<col> (A)` / `<col> (B)` for every other compared column.
 * `kinds` limits which rows are written.
 */
export function diffToTable(
  d: DiffResult,
  left: CompareSource,
  right: CompareSource,
  kinds: ReadonlySet<DiffKind>,
): DiffExport {
  const keyCount = d.keys.length;
  const columns = ['diff', 'changed_columns'];
  for (let c = 0; c < d.columns.length; c++) {
    if (c < keyCount) columns.push(d.columns[c]!);
    else columns.push(`${d.columns[c]} (A)`, `${d.columns[c]} (B)`);
  }
  const rows: unknown[][] = [];
  for (const r of d.rows) {
    if (!kinds.has(r.kind)) continue;
    const out: unknown[] = [r.kind, r.changed.map((c) => d.columns[c]).join(', ')];
    for (let c = 0; c < d.columns.length; c++) {
      const a = leftCell(d, left, r, c);
      const b = rightCell(d, right, r, c);
      if (c < keyCount) out.push(a ?? b ?? null);
      else out.push(r.li < 0 ? null : (a ?? null), r.ri < 0 ? null : (b ?? null));
    }
    rows.push(out);
  }
  return { columns, rows };
}

// ───────────────────────── saved definition ─────────────────────────

/** Where one side of a comparison comes from, enough to re-run it. */
export interface SavedCompareSide {
  /** Saved connection id; null = whichever connection is active. */
  connectionId: string | null;
  connectionName?: string;
  sql: string;
}

export interface SavedComparison {
  id: string;
  name: string;
  a: SavedCompareSide;
  b: SavedCompareSide;
  options: CompareOptions;
  savedAt: number;
}

/** Validate an untrusted saved definition; null when unusable. */
export function parseSavedComparison(raw: unknown): SavedComparison | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const side = (v: unknown): SavedCompareSide | null => {
    if (!v || typeof v !== 'object') return null;
    const s = v as Record<string, unknown>;
    if (typeof s.sql !== 'string' || s.sql.trim() === '') return null;
    if (s.connectionId !== null && typeof s.connectionId !== 'string') return null;
    return {
      connectionId: (s.connectionId as string | null) ?? null,
      ...(typeof s.connectionName === 'string' ? { connectionName: s.connectionName } : {}),
      sql: s.sql,
    };
  };
  const a = side(r.a);
  const b = side(r.b);
  if (!a || !b || typeof r.id !== 'string' || typeof r.name !== 'string') return null;
  const o = (r.options ?? {}) as Partial<CompareOptions>;
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return {
    id: r.id,
    name: r.name,
    a,
    b,
    options: {
      keys: strings(o.keys),
      ignore: strings(o.ignore),
      tolerance:
        typeof o.tolerance === 'number' && Number.isFinite(o.tolerance) && o.tolerance >= 0
          ? o.tolerance
          : 0,
      ignoreCase: o.ignoreCase === true,
      trimWhitespace: o.trimWhitespace === true,
    },
    savedAt: typeof r.savedAt === 'number' ? r.savedAt : 0,
  };
}
