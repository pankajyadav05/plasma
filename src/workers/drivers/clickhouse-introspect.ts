import type { IntrospectOpts, SchemaInfo } from '@shared/protocol';

/**
 * ClickHouse introspection from `system.databases`, `system.tables`,
 * `system.columns` and `system.data_skipping_indices`. The SQL lives in
 * `clickhouseIntrospectQueries`; `buildClickhouseSchema` turns the raw rows
 * into a `SchemaInfo` and is pure, so the parsing is unit-tested on fixtures.
 * ClickHouse "schemas" are databases; the system ones are hidden.
 */

export const CLICKHOUSE_SYSTEM_DATABASES = ['system', 'INFORMATION_SCHEMA', 'information_schema'];

export interface ClickhouseRawSchema {
  /** [name] */
  schemas: unknown[][];
  /**
   * [database, name, engine, total_rows, total_bytes, sorting_key, partition_key,
   *  primary_key, create_table_query]
   */
  tables: unknown[][];
  /** [database, table, name, type, position, is_in_primary_key, default_kind, default_expression] */
  columns: unknown[][];
  /** [database, table, name, type, expr, granularity] */
  indexes: unknown[][];
}

const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function quoteIdent(name: string): string {
  return `\`${name.replace(/[\\`]/g, (c) => `\\${c}`)}\``;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = n;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/**
 * The table-level `TTL …` clause of a `CREATE TABLE` statement, or null.
 * Column TTLs sit before `ENGINE`, so only the part after it is searched.
 */
export function ttlOf(createQuery: string): string | null {
  const engineAt = createQuery.search(/\bENGINE\s*=/);
  const tail = engineAt >= 0 ? createQuery.slice(engineAt) : createQuery;
  const m = /\sTTL\s+([\s\S]*?)(?=\s+(?:SETTINGS|COMMENT)\b|\s*$)/.exec(tail);
  return m ? (m[1] as string).trim() : null;
}

/** Table kind for a ClickHouse engine name. */
export function tableKindOf(engine: string): 'table' | 'view' | 'matview' {
  if (engine === 'MaterializedView') return 'matview';
  if (engine === 'View' || engine === 'LiveView' || engine === 'WindowView') return 'view';
  return 'table';
}

/** `Nullable(UInt8)` / `LowCardinality(Nullable(String))` → the inner type; `String` unchanged. */
export function innerType(type: string): string {
  let t = type;
  for (;;) {
    const m = /^(?:Nullable|LowCardinality)\((.*)\)$/.exec(t);
    if (!m) return t;
    t = m[1] as string;
  }
}

export function isNullableType(type: string): boolean {
  return /^(?:LowCardinality\()?Nullable\(/.test(type);
}

export function buildClickhouseSchema(raw: ClickhouseRawSchema, opts?: IntrospectOpts): SchemaInfo {
  const wantObjects = opts?.objects !== false;
  const wantColumns = opts?.columns !== false;

  const tables: SchemaInfo['tables'] = wantObjects
    ? raw.tables.map((r) => {
        const engine = s(r[2]);
        const kind = tableKindOf(engine);
        const rows = num(r[3]);
        const bytes = num(r[4]);
        const sorting = s(r[5]);
        const partition = s(r[6]);
        const primary = s(r[7]);
        const ttl = ttlOf(s(r[8]));
        const details = [
          { label: 'Engine', value: engine },
          ...(sorting ? [{ label: 'Sorting key', value: sorting }] : []),
          ...(partition ? [{ label: 'Partition key', value: partition }] : []),
          ...(primary && primary !== sorting ? [{ label: 'Primary key', value: primary }] : []),
          ...(ttl ? [{ label: 'TTL', value: ttl }] : []),
          ...(bytes !== null ? [{ label: 'Size on disk', value: formatBytes(bytes) }] : []),
        ];
        return {
          schema: s(r[0]),
          name: s(r[1]),
          kind,
          rowCountEstimate: rows,
          details,
        };
      })
    : [];

  const columns: SchemaInfo['columns'] = wantColumns
    ? raw.columns.map((r) => {
        const kind = s(r[6]);
        const expr = s(r[7]);
        return {
          schema: s(r[0]),
          table: s(r[1]),
          name: s(r[2]),
          dataType: s(r[3]),
          ordinal: Number(r[4]),
          isPrimaryKey: Number(r[5]) === 1,
          isNullable: isNullableType(s(r[3])),
          hasDefault: kind !== '',
          defaultExpr: kind !== '' && expr !== '' ? expr : null,
          identity: null,
        };
      })
    : [];

  const indexes: NonNullable<SchemaInfo['indexes']> = wantColumns
    ? raw.indexes.map((r) => ({
        schema: s(r[0]),
        table: s(r[1]),
        name: s(r[2]),
        definition: `INDEX ${quoteIdent(s(r[2]))} ${s(r[4])} TYPE ${s(r[3])} GRANULARITY ${s(r[5])}`,
        unique: false,
        primary: false,
      }))
    : [];

  return {
    schemas: wantObjects ? raw.schemas.map((r) => ({ name: s(r[0]) })) : [],
    tables,
    columns,
    foreignKeys: [],
    indexes,
    triggers: [],
    routines: [],
    sequences: [],
    types: [],
    extensions: [],
  };
}

/** Queries behind {@link ClickhouseRawSchema}; `allSchemas` limits the per-column ones. */
export function clickhouseIntrospectQueries(
  opts: IntrospectOpts | undefined,
  allSchemas: readonly string[],
): Array<{ key: keyof ClickhouseRawSchema; sql: string; params: unknown[] }> {
  const wantObjects = opts?.objects !== false;
  const wantColumns = opts?.columns !== false;
  const scope = (opts?.columnSchemas ?? allSchemas).filter((n) => allSchemas.includes(n));
  const out: Array<{ key: keyof ClickhouseRawSchema; sql: string; params: unknown[] }> = [];
  if (wantObjects) {
    out.push({
      key: 'schemas',
      sql: 'SELECT name FROM system.databases WHERE name NOT IN $1 ORDER BY name',
      params: [CLICKHOUSE_SYSTEM_DATABASES],
    });
    out.push({
      key: 'tables',
      sql: `SELECT database, name, engine, total_rows, total_bytes, sorting_key, partition_key,
                   primary_key, create_table_query
            FROM system.tables
            WHERE database NOT IN $1 AND NOT is_temporary
            ORDER BY database, name`,
      params: [CLICKHOUSE_SYSTEM_DATABASES],
    });
  }
  if (scope.length > 0 && wantColumns) {
    out.push({
      key: 'columns',
      sql: `SELECT database, table, name, type, position, is_in_primary_key, default_kind, default_expression
            FROM system.columns WHERE database IN $1
            ORDER BY database, table, position`,
      params: [scope],
    });
    out.push({
      key: 'indexes',
      sql: `SELECT database, table, name, type, expr, granularity
            FROM system.data_skipping_indices WHERE database IN $1
            ORDER BY database, table, name`,
      params: [scope],
    });
  }
  return out;
}
