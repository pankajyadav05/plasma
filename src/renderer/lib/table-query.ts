/**
 * SQL compilation for table-browser tabs.
 *
 * Given a structured tab state (schema, table, sort, filters, hidden
 * columns, page, pageSize), produces:
 *   - the paginated data query
 *   - a separate count query for pagination totals
 *
 * All identifiers are properly double-quote-escaped to resist injection.
 * All filter values are passed as bind parameters ($1, $2, …) so the
 * user's input never gets interpolated into the SQL text.
 */

export type FilterOp =
  | '='
  | '!='
  | '>'
  | '<'
  | '>='
  | '<='
  | 'LIKE'
  | 'ILIKE'
  | 'IS NULL'
  | 'IS NOT NULL';

export interface Filter {
  id: string;
  column: string;
  op: FilterOp;
  /** For LIKE/ILIKE we wrap in %. For IS NULL/IS NOT NULL this is ignored. */
  value: string;
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
}

export interface BuiltSql {
  sql: string;
  params: unknown[];
}

/** Escape a Postgres identifier with double quotes. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function buildFilterClauses(filters: Filter[], addParam: (value: unknown) => string): string[] {
  const clauses: string[] = [];
  for (const f of filters) {
    // Skip filters with empty values unless the op is IS NULL / IS NOT NULL
    const needsValue = f.op !== 'IS NULL' && f.op !== 'IS NOT NULL';
    if (needsValue && f.value.trim() === '') continue;
    const col = quoteIdent(f.column);
    switch (f.op) {
      case '=':
      case '!=':
      case '>':
      case '<':
      case '>=':
      case '<=':
        clauses.push(`${col} ${f.op} ${addParam(coerceValue(f.value))}`);
        break;
      case 'LIKE':
      case 'ILIKE':
        clauses.push(`${col}::text ${f.op} ${addParam(`%${f.value}%`)}`);
        break;
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
 * Try to coerce the string value to its intended Postgres type. Numbers
 * become numbers; 'true'/'false' become booleans; anything else stays
 * as a string and relies on pg's implicit conversion.
 */
function coerceValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);
  return raw;
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
  const params: unknown[] = [];
  const addParam = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const visibleColumns = input.allColumns.filter((c) => !input.hiddenColumns.has(c));
  const selectClause =
    input.hiddenColumns.size === 0 || visibleColumns.length === input.allColumns.length
      ? '*'
      : visibleColumns.length === 0
        ? '*' // fallback — never let the user hide everything
        : visibleColumns.map(quoteIdent).join(', ');

  const fromClause = `${quoteIdent(input.schema)}.${quoteIdent(input.table)}`;

  const whereClauses = buildFilterClauses(input.filters, addParam);
  const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const orderByClause =
    input.sort.length > 0
      ? `ORDER BY ${input.sort
          .map((s) => `${quoteIdent(s.column)} ${s.direction === 'asc' ? 'ASC' : 'DESC'}`)
          .join(', ')}`
      : '';

  const limit = Math.max(1, input.pageSize);
  const offset = Math.max(0, input.page * input.pageSize);

  const parts = [
    `SELECT ${selectClause} FROM ${fromClause}`,
    whereClause,
    orderByClause,
    `LIMIT ${limit} OFFSET ${offset}`,
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
}): BuiltSql {
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

  const setClause = setCols.map((c) => `${quoteIdent(c)} = ${addParam(input.set[c])}`).join(', ');
  const whereClause = pkCols
    .map((c) => `${quoteIdent(c)} = ${addParam(input.pkValues[c])}`)
    .join(' AND ');

  const from = `${quoteIdent(input.schema)}.${quoteIdent(input.table)}`;
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
}): BuiltSql {
  const cols = Object.keys(input.values);
  if (cols.length === 0) throw new Error('nothing to insert');

  const params: unknown[] = [];
  const addParam = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const colList = cols.map(quoteIdent).join(', ');
  const valList = cols.map((c) => addParam(input.values[c])).join(', ');
  const from = `${quoteIdent(input.schema)}.${quoteIdent(input.table)}`;
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
}): BuiltSql {
  const pkCols = Object.keys(input.pkValues);
  if (pkCols.length === 0) {
    throw new Error('cannot delete a row without primary-key columns');
  }

  const params: unknown[] = [];
  const addParam = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const whereClause = pkCols
    .map((c) => `${quoteIdent(c)} = ${addParam(input.pkValues[c])}`)
    .join(' AND ');
  const from = `${quoteIdent(input.schema)}.${quoteIdent(input.table)}`;
  const sql = `DELETE FROM ${from} WHERE ${whereClause}`;
  return { sql, params };
}

/**
 * Estimated count from `pg_class.reltuples` — no scan, returns instantly.
 * Only valid when there are zero filters (it counts the whole relation).
 * Caller is responsible for that check.
 */
export function buildEstimatedCountSql(schema: string, table: string): BuiltSql {
  return {
    sql: `SELECT reltuples::bigint AS estimate
          FROM pg_class
          WHERE oid = $1::regclass`,
    params: [`${quoteIdent(schema)}.${quoteIdent(table)}`],
  };
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

/**
 * Distinct values from a single column for the filter-value autocomplete.
 *
 * Cast to text so it works for any column type. Prefix-matches case
 * insensitively when `prefix` is non-empty; otherwise returns the most
 * common values. We cap aggressively (LIMIT 20) and add a STATEMENT
 * TIMEOUT-friendly subquery cap so wide tables don't pay a full-scan
 * cost on every keystroke — the worker's own query-cancel handles the
 * extreme case if a key gets held down.
 */
export function buildDistinctValuesSql(
  schema: string,
  table: string,
  column: string,
  prefix: string,
): BuiltSql {
  const from = `${quoteIdent(schema)}.${quoteIdent(table)}`;
  const col = quoteIdent(column);
  const trimmed = prefix.trim();
  if (trimmed.length > 0) {
    return {
      sql: `SELECT DISTINCT ${col}::text AS v
            FROM ${from}
            WHERE ${col}::text ILIKE $1
              AND ${col} IS NOT NULL
            ORDER BY v
            LIMIT 20`,
      params: [`${trimmed}%`],
    };
  }
  // No prefix → sample first N rows and return distinct values from
  // that window. Avoids a full-table DISTINCT on huge tables. Trade-off
  // is incompleteness, which is fine — autocomplete is a hint, not a
  // contract.
  return {
    sql: `SELECT DISTINCT v FROM (
            SELECT ${col}::text AS v
            FROM ${from}
            WHERE ${col} IS NOT NULL
            LIMIT 5000
          ) s
          ORDER BY v
          LIMIT 20`,
    params: [],
  };
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
export function buildCountSql(input: Pick<BuildInput, 'schema' | 'table' | 'filters'>): BuiltSql {
  const params: unknown[] = [];
  const addParam = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const fromClause = `${quoteIdent(input.schema)}.${quoteIdent(input.table)}`;
  const whereClauses = buildFilterClauses(input.filters, addParam);
  const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const sql = [`SELECT COUNT(*) FROM ${fromClause}`, whereClause].filter(Boolean).join('\n');
  return { sql, params };
}
