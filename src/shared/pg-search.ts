/**
 * "Search in database" — pure SQL builder and cell matcher.
 *
 * One SELECT per table: `SELECT t.* FROM "s"."t" t WHERE (c1::text ILIKE $1 OR …) LIMIT n`.
 * The search term always travels as a bind parameter; identifiers are
 * quoted; the LIMIT is a clamped integer literal. The renderer runs each
 * statement on the aux connection (read-only + statement timeout).
 */

export type SearchOp = 'contains' | 'equals' | 'startsWith' | 'regex';
export const SEARCH_OPS: readonly { id: SearchOp; label: string }[] = [
  { id: 'contains', label: 'contains' },
  { id: 'equals', label: 'equals' },
  { id: 'startsWith', label: 'starts with' },
  { id: 'regex', label: 'matches regex' },
];

export type SearchColumnClass =
  | 'text'
  | 'number'
  | 'uuid'
  | 'datetime'
  | 'boolean'
  | 'json'
  | 'binary'
  | 'other';

export const SEARCH_CLASS_LABEL: Record<SearchColumnClass, string> = {
  text: 'Text',
  number: 'Numbers',
  uuid: 'UUID',
  datetime: 'Dates',
  boolean: 'Booleans',
  json: 'JSON',
  binary: 'Binary',
  other: 'Other',
};

/** Classes searched unless the user opts in to more. */
export const DEFAULT_SEARCH_CLASSES: readonly SearchColumnClass[] = ['text', 'number', 'uuid'];

export function classifyColumn(dataType: string): SearchColumnClass {
  const t = dataType.toLowerCase().trim();
  if (t.endsWith('[]')) return 'other';
  if (
    /^(smallint|integer|int|int2|int4|int8|bigint|serial|bigserial|smallserial|numeric|decimal|real|float|float4|float8|double precision|money)\b/.test(
      t,
    )
  ) {
    return 'number';
  }
  if (/^(text|character varying|varchar|character|char|bpchar|name|citext|"char")\b/.test(t))
    return 'text';
  if (t === 'uuid') return 'uuid';
  if (/^(date|time|timestamp|interval)/.test(t)) return 'datetime';
  if (t === 'boolean' || t === 'bool') return 'boolean';
  if (t === 'json' || t === 'jsonb') return 'json';
  if (t === 'bytea') return 'binary';
  return 'other';
}

export function isNumericTerm(term: string): boolean {
  return /^\s*[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$/.test(term);
}

export interface SearchColumn {
  name: string;
  dataType: string;
}

export interface SearchSpec {
  term: string;
  op: SearchOp;
  caseSensitive?: boolean;
  /** Column classes to search. */
  classes?: readonly SearchColumnClass[];
  /** Per-table row cap. */
  limit?: number;
}

export const MAX_SEARCH_LIMIT = 1000;
export const DEFAULT_SEARCH_LIMIT = 50;

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Escape LIKE metacharacters (backslash is the default escape). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || (limit as number) < 1) return DEFAULT_SEARCH_LIMIT;
  return Math.min(Math.floor(limit as number), MAX_SEARCH_LIMIT);
}

/** Columns worth searching for `spec`: chosen classes, and numbers only for numeric terms. */
export function searchableColumns(
  columns: readonly SearchColumn[],
  spec: SearchSpec,
): SearchColumn[] {
  const classes = new Set(spec.classes ?? DEFAULT_SEARCH_CLASSES);
  const numeric = isNumericTerm(spec.term);
  return columns.filter((c) => {
    const cls = classifyColumn(c.dataType);
    if (!classes.has(cls)) return false;
    // A number column can only equal a numeric term; for text-ish operators
    // it is compared through ::text like everything else.
    if (cls === 'number' && spec.op === 'equals' && !numeric) return false;
    return true;
  });
}

export interface SearchQuery {
  sql: string;
  params: string[];
  /** Columns the predicate covers (so the UI can highlight matches). */
  columns: string[];
}

/** Null when the term is empty or no column qualifies. */
export function buildTableSearch(
  schema: string,
  table: string,
  columns: readonly SearchColumn[],
  spec: SearchSpec,
): SearchQuery | null {
  if (spec.term === '') return null;
  const cols = searchableColumns(columns, spec);
  if (cols.length === 0) return null;
  const cs = spec.caseSensitive === true;
  const numeric = isNumericTerm(spec.term);
  const params: string[] = [];
  const slots = new Map<string, number>();
  // Text and numeric uses of the same value get separate parameters — one
  // placeholder can't be inferred as both text and numeric.
  const bind = (value: string, kind: 't' | 'n' = 't'): string => {
    const key = `${kind}\u0000${value}`;
    const at = slots.get(key);
    if (at !== undefined) return `$${at}`;
    params.push(value);
    slots.set(key, params.length);
    return `$${params.length}`;
  };
  const like = cs ? 'LIKE' : 'ILIKE';
  const preds = cols.map((c) => {
    const id = `t.${quoteIdent(c.name)}`;
    const cls = classifyColumn(c.dataType);
    switch (spec.op) {
      case 'contains':
        return `${id}::text ${like} ${bind(`%${escapeLike(spec.term)}%`)}`;
      case 'startsWith':
        return `${id}::text ${like} ${bind(`${escapeLike(spec.term)}%`)}`;
      case 'regex':
        return `${id}::text ${cs ? '~' : '~*'} ${bind(spec.term)}`;
      default:
        if (cls === 'number' && numeric)
          return `${id}::numeric = ${bind(spec.term.trim(), 'n')}::numeric`;
        return cs
          ? `${id}::text = ${bind(spec.term)}`
          : `lower(${id}::text) = lower(${bind(spec.term)})`;
    }
  });
  const sql = `SELECT t.* FROM ${quoteIdent(schema)}.${quoteIdent(table)} t WHERE (${preds.join(' OR ')}) LIMIT ${clampLimit(spec.limit)}`;
  return { sql, params, columns: cols.map((c) => c.name) };
}

/** Client-side mirror of the predicate, used to highlight the matching cells of a row. */
export function cellMatches(
  value: unknown,
  spec: Pick<SearchSpec, 'term' | 'op' | 'caseSensitive'>,
): boolean {
  if (value === null || value === undefined) return false;
  const raw = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const cs = spec.caseSensitive === true;
  const a = cs ? raw : raw.toLowerCase();
  const b = cs ? spec.term : spec.term.toLowerCase();
  switch (spec.op) {
    case 'contains':
      return a.includes(b);
    case 'startsWith':
      return a.startsWith(b);
    case 'equals':
      return (
        a === b ||
        (isNumericTerm(spec.term) && isNumericTerm(raw) && Number(raw) === Number(spec.term))
      );
    case 'regex':
      try {
        return new RegExp(spec.term, cs ? '' : 'i').test(raw);
      } catch {
        return false;
      }
  }
}

/**
 * Filters that open the table at one result row: the primary key when the
 * table has one (all its columns present in the result), otherwise the
 * first matching column.
 */
export function rowFilters(
  resultColumns: readonly string[],
  row: readonly unknown[],
  pkColumns: readonly string[],
  matchedColumns: readonly string[],
): { column: string; value: string }[] {
  const val = (col: string): string | null => {
    const i = resultColumns.indexOf(col);
    const v = i >= 0 ? row[i] : null;
    if (v === null || v === undefined) return null;
    return v instanceof Date
      ? v.toISOString()
      : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v);
  };
  if (pkColumns.length > 0) {
    const vals = pkColumns.map((c) => ({ column: c, value: val(c) }));
    if (vals.every((v) => v.value !== null)) return vals as { column: string; value: string }[];
  }
  for (const c of matchedColumns) {
    const v = val(c);
    if (v !== null) return [{ column: c, value: v }];
  }
  return [];
}

/** Order tables so small ones (by row estimate) come first — quick results early. */
export function orderForSearch<T extends { rowCountEstimate: number | null }>(
  tables: readonly T[],
): T[] {
  return [...tables].sort(
    (a, b) =>
      (a.rowCountEstimate ?? Number.MAX_SAFE_INTEGER) -
      (b.rowCountEstimate ?? Number.MAX_SAFE_INTEGER),
  );
}
