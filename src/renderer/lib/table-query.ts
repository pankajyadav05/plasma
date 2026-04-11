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

function buildFilterClauses(
  filters: Filter[],
  addParam: (value: unknown) => string,
): string[] {
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

  const visibleColumns = input.allColumns.filter(
    (c) => !input.hiddenColumns.has(c),
  );
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
 * Build the count query. Shares the same WHERE clause as the data query
 * so filtered totals are accurate. No SELECT/ORDER BY/LIMIT — just the
 * row count.
 */
export function buildCountSql(
  input: Pick<BuildInput, 'schema' | 'table' | 'filters'>,
): BuiltSql {
  const params: unknown[] = [];
  const addParam = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const fromClause = `${quoteIdent(input.schema)}.${quoteIdent(input.table)}`;
  const whereClauses = buildFilterClauses(input.filters, addParam);
  const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const sql = [`SELECT COUNT(*) FROM ${fromClause}`, whereClause]
    .filter(Boolean)
    .join('\n');
  return { sql, params };
}
