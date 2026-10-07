/**
 * SQL compilation for table-browser tabs.
 *
 * Given a structured tab state (schema, table, sort, filters, hidden
 * columns, page, pageSize), produces:
 *   - the paginated data query
 *   - a separate count query for pagination totals
 *
 * All identifiers are properly quote-escaped to resist injection.
 * All filter values are passed as bind parameters ($1, $2, …) so the
 * user's input never gets interpolated into the SQL text.
 *
 * Every builder takes an optional `SqlDialect` (default Postgres): quoting,
 * the text cast / LIKE spelling and the key-less row locator come from it, so
 * the SQLite and MySQL workbenches share these builders. Placeholders stay
 * `$n` for all engines; the SQLite / MySQL drivers translate them.
 */
import { type GuardValue, buildGuardClauses } from '@shared/edit-guard';
import { POSTGRES_DIALECT, type SqlDialect } from '@shared/sql-dialect';

export type FilterOp =
  | '='
  | '!='
  | '>'
  | '<'
  | '>='
  | '<='
  | 'LIKE'
  | 'ILIKE'
  | 'NOT LIKE'
  | 'NOT ILIKE'
  | 'IN'
  | 'NOT IN'
  | 'BETWEEN'
  | 'IS NULL'
  | 'IS NOT NULL';

export interface Filter {
  id: string;
  column: string;
  op: FilterOp;
  /**
   * For LIKE/ILIKE we wrap in %. IN / NOT IN take a comma-separated list;
   * BETWEEN takes `low, high` (or `low and high`). Ignored for IS [NOT] NULL.
   */
  value: string;
  /** Per-filter toggle (F6); `false` keeps the chip but skips the clause. */
  enabled?: boolean;
}

/** Split an IN list / BETWEEN pair: commas (quotes allowed around items). */
export function splitFilterList(value: string): string[] {
  const out: string[] = [];
  const re = /\s*(?:"((?:[^"]|"")*)"|'((?:[^']|'')*)'|([^,]*))\s*(?:,|$)/g;
  for (const m of value.matchAll(re)) {
    if (m[0] === '') break;
    const quoted = m[1] !== undefined || m[2] !== undefined;
    const item =
      m[1] !== undefined
        ? m[1].replace(/""/g, '"')
        : m[2] !== undefined
          ? m[2].replace(/''/g, "'")
          : (m[3] ?? '').trim();
    if (item !== '' || quoted) out.push(item);
    if ((m.index ?? 0) + m[0].length >= value.length) break;
  }
  return out;
}

/** BETWEEN bounds from `a, b` or `a and b`; null when incomplete. */
export function betweenBounds(value: string): [string, string] | null {
  const parts =
    /\band\b/i.test(value) && !value.includes(',')
      ? value.split(/\band\b/i).map((p) => p.trim())
      : splitFilterList(value);
  if (parts.length !== 2 || parts.some((p) => p === '')) return null;
  return [parts[0]!, parts[1]!];
}

export interface TableSort {
  column: string;
  direction: 'asc' | 'desc';
}

export interface BuildInput {
  schema: string;
  table: string;
  allColumns: string[];
  hiddenColumns: Set<string>;
  sort: TableSort[];
  filters: Filter[];
  page: number;
  pageSize: number;
  /**
   * Primary-key columns (B5/F17). Used as the default ORDER BY when no
   * sort is chosen, and as a tie-breaker after the user's sort, so LIMIT/
   * OFFSET pages are deterministic.
   */
  primaryKey?: string[];
  /** Order by `ctid` when there's no primary key (plain tables only). */
  ctidFallback?: boolean;
  /**
   * SQLite rowid tables without a declared key: the implicit row-id column to
   * select (so row edits can address the row) and order by.
   */
  implicitKey?: string;
  /** Engine dialect; Postgres when absent. */
  dialect?: SqlDialect;
  /** Full-result export: no LIMIT/OFFSET. */
  unpaged?: boolean;
}

export interface BuiltSql {
  sql: string;
  params: unknown[];
}

/** Escape a Postgres identifier with double quotes. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function buildFilterClauses(
  filters: Filter[],
  addParam: (value: unknown) => string,
  d: SqlDialect = POSTGRES_DIALECT,
): string[] {
  const clauses: string[] = [];
  for (const f of filters) {
    if (f.enabled === false) continue;
    // Skip filters with empty values unless the op is IS NULL / IS NOT NULL
    const needsValue = f.op !== 'IS NULL' && f.op !== 'IS NOT NULL';
    if (needsValue && f.value.trim() === '') continue;
    const col = d.quoteIdent(f.column);
    switch (f.op) {
      case '=':
      case '!=':
      case '>':
      case '<':
      case '>=':
      case '<=':
        // Keep exact user strings — JS Number/boolean coercion rounds
        // bigints, drops numeric precision, and strips leading zeros.
        // PostgreSQL infers the parameter type from the column.
        clauses.push(`${col} ${f.op} ${addParam(f.value)}`);
        break;
      case 'LIKE':
      case 'ILIKE':
      case 'NOT LIKE':
      case 'NOT ILIKE':
        // R-28: "contains": the user's %, _ and backslash are literal text.
        clauses.push(d.likePredicate(col, f.op, addParam(`%${escapeLikePattern(f.value)}%`)));
        break;
      case 'IN':
      case 'NOT IN': {
        const items = splitFilterList(f.value);
        if (items.length === 0) break;
        clauses.push(`${col} ${f.op} (${items.map((v) => addParam(v)).join(', ')})`);
        break;
      }
      case 'BETWEEN': {
        const b = betweenBounds(f.value);
        if (!b) break;
        clauses.push(`${col} BETWEEN ${addParam(b[0])} AND ${addParam(b[1])}`);
        break;
      }
      case 'IS NULL':
        clauses.push(`${col} IS NULL`);
        break;
      case 'IS NOT NULL':
        clauses.push(`${col} IS NOT NULL`);
        break;
    }
  }
  return clauses;
}

/**
 * ORDER BY for a table page: the user's sort, then the primary key as a
 * tie-breaker (or alone when nothing is sorted), else `ctid` for plain
 * tables without a key. Without it Postgres may return rows in any order
 * and pages repeat or skip rows.
 */
function buildOrderBy(input: BuildInput): string {
  const d = input.dialect ?? POSTGRES_DIALECT;
  const terms = input.sort.map(
    (s) => `${d.quoteIdent(s.column)} ${s.direction === 'asc' ? 'ASC' : 'DESC'}`,
  );
  const sorted = new Set(input.sort.map((s) => s.column));
  const pk = input.primaryKey ?? [];
  if (pk.length > 0) {
    for (const c of pk) if (!sorted.has(c)) terms.push(`${d.quoteIdent(c)} ASC`);
  } else if (input.ctidFallback && d.rowLocator === 'ctid') {
    terms.push('ctid');
  }
  return terms.length > 0 ? `ORDER BY ${terms.join(', ')}` : '';
}

/**
 * Build the paginated data query.
 *
 * Examples:
 *
 *   SELECT * FROM "public"."users"
 *   ORDER BY "created_at" DESC
 *   LIMIT 50 OFFSET 100
 *
 *   SELECT "id", "email", "plan" FROM "public"."users"
 *   WHERE "plan"::text ILIKE $1 AND "created_at" > $2
 *   ORDER BY "id" ASC
 *   LIMIT 100 OFFSET 0
 */
export function buildDataSql(input: BuildInput): BuiltSql {
  const d = input.dialect ?? POSTGRES_DIALECT;
  const params: unknown[] = [];
  const addParam = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const visibleColumns = input.allColumns.filter((c) => !input.hiddenColumns.has(c));
  const columnList =
    input.hiddenColumns.size === 0 || visibleColumns.length === input.allColumns.length
      ? '*'
      : visibleColumns.length === 0
        ? '*' // fallback — never let the user hide everything
        : visibleColumns.map((c) => d.quoteIdent(c)).join(', ');
  // A key-less SQLite table is addressed by its implicit rowid: fetch it too.
  const selectClause = input.implicitKey
    ? `${d.quoteIdent(input.implicitKey)}, ${columnList}`
    : columnList;

  const fromClause = d.qualify(input.schema, input.table);

  const whereClauses = buildFilterClauses(input.filters, addParam, d);
  const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const orderByClause = buildOrderBy(input);

  const limit = Math.max(1, input.pageSize);
  const offset = Math.max(0, input.page * input.pageSize);

  const parts = [
    `SELECT ${selectClause} FROM ${fromClause}`,
    whereClause,
    orderByClause,
    input.unpaged ? '' : `LIMIT ${limit} OFFSET ${offset}`,
  ].filter(Boolean);

  return { sql: parts.join('\n'), params };
}

/**
 * Build an UPDATE for a single row identified by its primary-key columns.
 *
 *   UPDATE "schema"."table" SET "col" = $1 WHERE "pk1" = $2 AND "pk2" = $3
 *
 * `set` is the map of column → new raw value (string or native). `pkValues`
 * is the map of PK column → its current value from the row being edited.
 */
export function buildUpdateSql(input: {
  schema: string;
  table: string;
  set: Record<string, unknown>;
  pkValues: Record<string, unknown>;
  /** Original values the row must still hold (concurrent-edit guard, see edit-guard.ts). */
  guards?: readonly GuardValue[];
  dialect?: SqlDialect;
}): BuiltSql {
  const d = input.dialect ?? POSTGRES_DIALECT;
  const setCols = Object.keys(input.set);
  const pkCols = Object.keys(input.pkValues);
  if (setCols.length === 0) throw new Error('nothing to update');
  if (pkCols.length === 0) {
    throw new Error('cannot update a row without primary-key columns');
  }

  const params: unknown[] = [];
  const addParam = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const setClause = setCols.map((c) => `${d.quoteIdent(c)} = ${addParam(input.set[c])}`).join(', ');
  const whereClause = [
    ...pkCols.map((c) => `${d.quoteIdent(c)} = ${addParam(input.pkValues[c])}`),
    ...buildGuardClauses(d, input.guards, addParam),
  ].join(' AND ');

  const from = d.qualify(input.schema, input.table);
  const sql = `UPDATE ${from} SET ${setClause} WHERE ${whereClause}`;
  return { sql, params };
}

/**
 * Build an INSERT. Columns omitted from `values` keep their table default
 * (so auto-increment / serial / generated columns can be left blank).
 */
export function buildInsertSql(input: {
  schema: string;
  table: string;
  values: Record<string, unknown>;
  dialect?: SqlDialect;
}): BuiltSql {
  const d = input.dialect ?? POSTGRES_DIALECT;
  const cols = Object.keys(input.values);
  if (cols.length === 0) throw new Error('nothing to insert');

  const params: unknown[] = [];
  const addParam = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const colList = cols.map((c) => d.quoteIdent(c)).join(', ');
  const valList = cols.map((c) => addParam(input.values[c])).join(', ');
  const from = d.qualify(input.schema, input.table);
  const sql = `INSERT INTO ${from} (${colList}) VALUES (${valList})`;
  return { sql, params };
}

/**
 * Build a DELETE for a single row identified by its primary-key columns.
 */
export function buildDeleteSql(input: {
  schema: string;
  table: string;
  pkValues: Record<string, unknown>;
  /** Original values the row must still hold (concurrent-edit guard, see edit-guard.ts). */
  guards?: readonly GuardValue[];
  dialect?: SqlDialect;
}): BuiltSql {
  const d = input.dialect ?? POSTGRES_DIALECT;
  const pkCols = Object.keys(input.pkValues);
  if (pkCols.length === 0) {
    throw new Error('cannot delete a row without primary-key columns');
  }

  const params: unknown[] = [];
  const addParam = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const whereClause = [
    ...pkCols.map((c) => `${d.quoteIdent(c)} = ${addParam(input.pkValues[c])}`),
    ...buildGuardClauses(d, input.guards, addParam),
  ].join(' AND ');
  const from = d.qualify(input.schema, input.table);
  const sql = `DELETE FROM ${from} WHERE ${whereClause}`;
  return { sql, params };
}

/** The row with this primary key as it is now (conflict review: "theirs"). */
export function buildRowLookupSql(input: {
  schema: string;
  table: string;
  pkValues: Record<string, unknown>;
  dialect?: SqlDialect;
}): BuiltSql {
  const d = input.dialect ?? POSTGRES_DIALECT;
  const pkCols = Object.keys(input.pkValues);
  if (pkCols.length === 0) throw new Error('cannot look up a row without primary-key columns');
  const params: unknown[] = [];
  const where = pkCols
    .map((c) => {
      params.push(input.pkValues[c]);
      return `${d.quoteIdent(c)} = $${params.length}`;
    })
    .join(' AND ');
  return {
    sql: `SELECT * FROM ${d.qualify(input.schema, input.table)} WHERE ${where} LIMIT 2`,
    params,
  };
}

/**
 * Estimated count from `pg_class.reltuples` — no scan, returns instantly.
 * Only valid when there are zero filters (it counts the whole relation).
 * Caller is responsible for that check.
 */
export function buildEstimatedCountSql(
  schema: string,
  table: string,
  dialect: SqlDialect = POSTGRES_DIALECT,
): BuiltSql {
  const est = dialect.estimatedCount(schema, table);
  if (!est) throw new Error(`${dialect.engine} has no cheap row-count estimate`);
  return est as BuiltSql;
}

/**
 * Build the SQL bundle for a table's "Definition" view: column shape,
 * constraints, and indexes. The renderer composes the DDL from these.
 */
export function buildDefinitionQuerySql(schema: string, table: string): BuiltSql {
  // Single round-trip: three result sets via a UNION over a tagged shape.
  // Cheaper than three separate IPC calls; all columns coerced to text.
  const sql = `
    SELECT 'col' AS kind, a.attnum AS ord,
           a.attname AS c1,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS c2,
           CASE WHEN a.attnotnull THEN 'NOT NULL' ELSE '' END AS c3,
           COALESCE(pg_get_expr(d.adbin, d.adrelid), '') AS c4
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = $1::regclass
      AND a.attnum > 0 AND NOT a.attisdropped
    UNION ALL
    SELECT 'con' AS kind, 1000 + ROW_NUMBER() OVER (ORDER BY conname) AS ord,
           conname AS c1,
           pg_get_constraintdef(oid) AS c2,
           '' AS c3,
           '' AS c4
    FROM pg_constraint
    WHERE conrelid = $1::regclass
    UNION ALL
    SELECT 'idx' AS kind, 2000 + ROW_NUMBER() OVER (ORDER BY indexname) AS ord,
           indexname AS c1,
           indexdef AS c2,
           '' AS c3,
           '' AS c4
    FROM pg_indexes
    WHERE schemaname || '.' || tablename = $2
    ORDER BY ord
  `;
  return {
    sql,
    params: [`${quoteIdent(schema)}.${quoteIdent(table)}`, `${schema}.${table}`],
  };
}

/**
 * Count active RLS policies on a table. Returns 0 for tables without RLS.
 */
export function buildRlsCountSql(schema: string, table: string): BuiltSql {
  return {
    sql: `SELECT COUNT(*)::int AS n
          FROM pg_policies
          WHERE schemaname = $1 AND tablename = $2`,
    params: [schema, table],
  };
}

/**
 * List all RLS policies on a table — surfaced in the RLS badge popover.
 */
export function buildRlsPoliciesSql(schema: string, table: string): BuiltSql {
  return {
    sql: `SELECT policyname,
                 cmd,
                 COALESCE(array_to_string(roles, ', '), 'public') AS roles,
                 COALESCE(qual::text, '') AS qual,
                 COALESCE(with_check::text, '') AS with_check,
                 permissive
          FROM pg_policies
          WHERE schemaname = $1 AND tablename = $2
          ORDER BY policyname`,
    params: [schema, table],
  };
}

/** Escape `%`, `_` and `\\` so user text matches literally in LIKE/ILIKE. */
export function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Rows scanned (at most) for filter-value suggestions. */
export const DISTINCT_SAMPLE_ROWS = 5000;
/** Distinct values kept from that sample. */
export const DISTINCT_SAMPLE_VALUES = 500;

/**
 * Distinct values from a single column for the filter-value autocomplete
 * (A7/F12). Always bounded: it reads at most DISTINCT_SAMPLE_ROWS rows
 * (never a full-table DISTINCT) and returns up to DISTINCT_SAMPLE_VALUES
 * values. The UI loads this sample once per column and filters it
 * locally as the user types, so keystrokes never hit the database. An
 * optional `prefix` narrows the sample (escaped, prefix-only match).
 */
export function buildDistinctValuesSql(
  schema: string,
  table: string,
  column: string,
  prefix = '',
  d: SqlDialect = POSTGRES_DIALECT,
): BuiltSql {
  const from = d.qualify(schema, table);
  const col = d.quoteIdent(column);
  const trimmed = prefix.trim();
  const params: unknown[] = [];
  let match = '';
  if (trimmed.length > 0) {
    params.push(`${escapeLikePattern(trimmed)}%`);
    match = ` AND ${d.likePredicate(col, 'ILIKE', '$1')}`;
  }
  return {
    sql: `SELECT DISTINCT v FROM (
            SELECT ${d.textCast(col)} AS v
            FROM ${from}
            WHERE ${col} IS NOT NULL${match}
            LIMIT ${DISTINCT_SAMPLE_ROWS}
          ) s
          ORDER BY v
          LIMIT ${DISTINCT_SAMPLE_VALUES}`,
    params,
  };
}

/**
 * Filter a loaded suggestion sample by what the user typed: prefix
 * matches first, then substring matches, case-insensitive.
 */
export function filterSuggestions(values: readonly string[], typed: string, limit = 20): string[] {
  const needle = typed.trim().toLowerCase();
  if (!needle) return values.slice(0, limit);
  const prefix: string[] = [];
  const inner: string[] = [];
  for (const v of values) {
    const lower = v.toLowerCase();
    if (lower.startsWith(needle)) prefix.push(v);
    else if (lower.includes(needle)) inner.push(v);
    if (prefix.length >= limit) break;
  }
  return [...prefix, ...inner].slice(0, limit);
}

/** List role names (excluding pg_* internals), ordered. */
export function buildRolesSql(): BuiltSql {
  return {
    sql: `SELECT rolname FROM pg_roles
          WHERE rolname NOT LIKE 'pg\\_%' ESCAPE '\\'
          ORDER BY rolname`,
    params: [],
  };
}

/**
 * Build the count query. Shares the same WHERE clause as the data query
 * so filtered totals are accurate. No SELECT/ORDER BY/LIMIT — just the
 * row count.
 */
export function buildCountSql(
  input: Pick<BuildInput, 'schema' | 'table' | 'filters' | 'dialect'>,
): BuiltSql {
  const d = input.dialect ?? POSTGRES_DIALECT;
  const params: unknown[] = [];
  const addParam = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const fromClause = d.qualify(input.schema, input.table);
  const whereClauses = buildFilterClauses(input.filters, addParam, d);
  const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const sql = [`SELECT COUNT(*) FROM ${fromClause}`, whereClause].filter(Boolean).join('\n');
  return { sql, params };
}
