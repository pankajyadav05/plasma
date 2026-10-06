/**
 * A "view" of one table in the grid: which columns show, how they sort,
 * which filters apply and how many rows a page holds. Pure: the model's
 * proposal is validated here against the table's real columns before the
 * UI shows it, and described here for the cards and chips. Applying it to a
 * tab lives in the renderer (`features/ai/table-view-apply.ts`).
 */
import { NL_FILTER_OPS, type NlFilterOp } from './ai-tasks';

export interface TableViewColumn {
  name: string;
  dataType: string;
}

export interface TableViewSort {
  column: string;
  direction: 'asc' | 'desc';
}

export interface TableViewFilter {
  column: string;
  op: NlFilterOp;
  value: string;
}

/** A part left out (or null) means "unchanged"; `[]` for sort / filters means "none". */
export interface TableViewSpec {
  columns?: string[] | null;
  sort?: TableViewSort[];
  filters?: TableViewFilter[];
  limit?: number | null;
}

export const TABLE_VIEW_MAX_FILTERS = 20;
export const TABLE_VIEW_MAX_SORT = 10;
export const TABLE_VIEW_MAX_LIMIT = 1000;

export type TableViewResult = { ok: true; view: TableViewSpec } | { ok: false; error: string };

const fail = (error: string): TableViewResult => ({ ok: false, error });

/** Up to 5 real names that look like `name`, for an error the model can retry from. */
export function closeColumnNames(name: string, names: readonly string[]): string[] {
  const needle = name.toLowerCase();
  const scored: Array<{ n: string; score: number }> = [];
  for (const n of names) {
    const lower = n.toLowerCase();
    let score = Number.POSITIVE_INFINITY;
    if (lower === needle) score = 0;
    else if (lower.includes(needle) || (needle.length >= 3 && needle.includes(lower))) score = 1;
    else {
      const d = editDistance(lower, needle);
      if (d <= Math.max(2, Math.floor(needle.length / 3))) score = 1 + d;
    }
    if (score !== Number.POSITIVE_INFINITY) scored.push({ n, score });
  }
  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, 5)
    .map((s) => s.n);
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 4) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length] ?? 99;
}

/** Stands in for a filter value the model may not see (row data is not shared). */
export const HIDDEN_FILTER_VALUE = '<hidden>';

function unknownColumn(
  name: string,
  names: readonly string[],
  where: string,
  listNames = true,
): string {
  if (!listNames) return `Unknown column "${name}" in ${where}.`;
  const close = closeColumnNames(name, names);
  return `Unknown column "${name}" in ${where}.${
    close.length > 0 ? ` Close names: ${close.join(', ')}.` : ''
  } Available columns: ${names.slice(0, 40).join(', ')}${names.length > 40 ? ', …' : ''}.`;
}

/**
 * Validate a model-proposed view. Every column must exist exactly: nothing
 * is auto-corrected, the error names the bad column and lists close names so
 * the model can retry. `null` / missing parts mean "unchanged".
 */
export function validateTableView(
  raw: unknown,
  columns: readonly TableViewColumn[],
  opts: { listNames?: boolean } = {},
): TableViewResult {
  const listNames = opts.listNames !== false;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('The view must be an object.');
  }
  const obj = raw as Record<string, unknown>;
  const names = columns.map((c) => c.name);
  const known = new Set(names);
  const view: TableViewSpec = {};

  if (obj.columns !== undefined && obj.columns !== null) {
    if (!Array.isArray(obj.columns)) return fail('"columns" must be an array of column names.');
    const picked: string[] = [];
    for (const c of obj.columns) {
      if (typeof c !== 'string') return fail('"columns" must contain only column names (strings).');
      if (!known.has(c)) return fail(unknownColumn(c, names, '"columns"', listNames));
      if (!picked.includes(c)) picked.push(c);
    }
    if (picked.length === 0) return fail('"columns" must keep at least one column.');
    view.columns = picked;
  }

  if (obj.sort !== undefined && obj.sort !== null) {
    if (!Array.isArray(obj.sort)) return fail('"sort" must be an array.');
    if (obj.sort.length > TABLE_VIEW_MAX_SORT) {
      return fail(`At most ${TABLE_VIEW_MAX_SORT} sort keys are allowed.`);
    }
    const sort: TableViewSort[] = [];
    for (const s of obj.sort) {
      const row = (s ?? {}) as Record<string, unknown>;
      const column = typeof row.column === 'string' ? row.column : '';
      if (!known.has(column)) return fail(unknownColumn(column, names, '"sort"', listNames));
      const dir = typeof row.direction === 'string' ? row.direction.trim().toLowerCase() : 'asc';
      if (dir !== 'asc' && dir !== 'desc') {
        return fail(`Sort direction for "${column}" must be "asc" or "desc".`);
      }
      if (sort.some((x) => x.column === column)) continue;
      sort.push({ column, direction: dir });
    }
    view.sort = sort;
  }

  if (obj.filters !== undefined && obj.filters !== null) {
    if (!Array.isArray(obj.filters)) return fail('"filters" must be an array.');
    if (obj.filters.length > TABLE_VIEW_MAX_FILTERS) {
      return fail(`At most ${TABLE_VIEW_MAX_FILTERS} filters are allowed.`);
    }
    const filters: TableViewFilter[] = [];
    for (const f of obj.filters) {
      const row = (f ?? {}) as Record<string, unknown>;
      const column = typeof row.column === 'string' ? row.column : '';
      if (!known.has(column)) return fail(unknownColumn(column, names, '"filters"', listNames));
      const op = typeof row.op === 'string' ? row.op.trim().toUpperCase() : '';
      if (!(NL_FILTER_OPS as readonly string[]).includes(op)) {
        return fail(
          `Unsupported filter operator "${String(row.op)}" on "${column}". Allowed: ${NL_FILTER_OPS.join(', ')}.`,
        );
      }
      const nullary = op === 'IS NULL' || op === 'IS NOT NULL';
      const rawValue = row.value;
      const value =
        typeof rawValue === 'string'
          ? rawValue
          : typeof rawValue === 'number' || typeof rawValue === 'boolean'
            ? String(rawValue)
            : '';
      if (!nullary && value.trim() === '') {
        return fail(`Filter on "${column}" with ${op} needs a value.`);
      }
      filters.push({ column, op: op as NlFilterOp, value: nullary ? '' : value });
    }
    view.filters = filters;
  }

  if (obj.limit !== undefined && obj.limit !== null) {
    const n = obj.limit;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > TABLE_VIEW_MAX_LIMIT) {
      return fail(`"limit" must be a whole number from 1 to ${TABLE_VIEW_MAX_LIMIT}.`);
    }
    view.limit = n;
  }

  return { ok: true, view };
}

/** True when the view changes nothing. */
export function isEmptyTableView(view: TableViewSpec): boolean {
  return (
    view.columns == null &&
    view.sort === undefined &&
    view.filters === undefined &&
    view.limit == null
  );
}

const TEMPORAL = /^(date|timestamp|timestamptz|datetime|time\b)/i;

function sortPhrase(s: TableViewSort, columns: readonly TableViewColumn[]): string {
  const type = columns.find((c) => c.name === s.column)?.dataType ?? '';
  const temporal = TEMPORAL.test(type.trim());
  if (temporal) return `${s.column} ${s.direction === 'desc' ? 'newest first' : 'oldest first'}`;
  return `${s.column} ${s.direction === 'desc' ? 'descending' : 'ascending'}`;
}

/** Short chip texts for the parts a view changes, e.g. `Columns: a, b`, `Limit: 10 rows`. */
export function describeTableView(
  view: TableViewSpec,
  columns: readonly TableViewColumn[] = [],
): string[] {
  const chips: string[] = [];
  if (view.columns != null) {
    const shown = view.columns.slice(0, 8).join(', ');
    const more = view.columns.length > 8 ? ` +${view.columns.length - 8} more` : '';
    chips.push(`Columns: ${shown}${more}`);
  }
  if (view.sort !== undefined) {
    chips.push(
      view.sort.length === 0
        ? 'Sort: none'
        : `Sort: ${view.sort.map((s) => sortPhrase(s, columns)).join(', ')}`,
    );
  }
  if (view.filters !== undefined) {
    if (view.filters.length === 0) chips.push('Filters: none');
    for (const f of view.filters) {
      const nullary = f.op === 'IS NULL' || f.op === 'IS NOT NULL';
      chips.push(`Filter: ${f.column} ${f.op === '=' ? '=' : f.op}${nullary ? '' : ` ${f.value}`}`);
    }
  }
  if (view.limit != null) chips.push(`Limit: ${view.limit} ${view.limit === 1 ? 'row' : 'rows'}`);
  return chips;
}

/** The view a table tab shows right now, for comparing against a proposal. */
export interface CurrentTableView {
  /** Visible columns, in order. */
  columns: string[];
  sort: TableViewSort[];
  filters: Array<{ column: string; op: string; value: string }>;
  pageSize: number;
}

/** Drop the parts of `view` that already hold, so the proposal shows only what changes. */
export function trimViewToChanges(view: TableViewSpec, current: CurrentTableView): TableViewSpec {
  const out: TableViewSpec = {};
  if (view.columns != null && view.columns.join('\u0000') !== current.columns.join('\u0000')) {
    out.columns = view.columns;
  }
  if (
    view.sort !== undefined &&
    JSON.stringify(view.sort.map((s) => [s.column, s.direction])) !==
      JSON.stringify(current.sort.map((s) => [s.column, s.direction]))
  ) {
    out.sort = view.sort;
  }
  if (
    view.filters !== undefined &&
    JSON.stringify(view.filters.map((f) => [f.column, f.op, f.value])) !==
      JSON.stringify(current.filters.map((f) => [f.column, f.op, f.value]))
  ) {
    out.filters = view.filters;
  }
  if (view.limit != null && view.limit !== current.pageSize) out.limit = view.limit;
  return out;
}

/**
 * Filters the model echoed back with the placeholder instead of a value take
 * the value of the current filter on the same column and operator (each current
 * filter is used once). A placeholder with no match is an error: the model
 * cannot be allowed to invent a value it never saw.
 */
export function mergeHiddenFilterValues(
  filters: TableViewFilter[],
  current: ReadonlyArray<{ column: string; op: string; value: string }>,
): { ok: true; filters: TableViewFilter[] } | { ok: false; error: string } {
  const used = new Set<number>();
  const out: TableViewFilter[] = [];
  for (const f of filters) {
    if (f.value.trim() !== HIDDEN_FILTER_VALUE) {
      out.push(f);
      continue;
    }
    const idx = current.findIndex((c, i) => !used.has(i) && c.column === f.column && c.op === f.op);
    if (idx === -1) {
      return {
        ok: false,
        error: `The filter on "${f.column}" used the hidden-value placeholder, but no current filter on that column and operator exists.`,
      };
    }
    used.add(idx);
    out.push({ ...f, value: current[idx]?.value ?? '' });
  }
  return { ok: true, filters: out };
}
