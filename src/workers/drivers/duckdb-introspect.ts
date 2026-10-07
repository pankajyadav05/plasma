import { DATA_FILE_KIND_LABEL, type DataFileKind } from '@shared/data-files';
import type { IntrospectOpts, SchemaInfo } from '@shared/protocol';

/**
 * DuckDB introspection from the `duckdb_*()` catalog functions. The SQL lives
 * in `DUCKDB_INTROSPECT_SQL`; `buildDuckdbSchema` turns the raw rows into a
 * `SchemaInfo` and is pure, so the parsing is unit-tested on fixtures.
 *
 * The session's own catalog keeps plain schema names (`main`); an attached
 * catalog (a Postgres connection, an attached .duckdb) shows up as
 * `catalog.schema` so the table tabs can address it.
 */

export interface DuckdbRawSchema {
  /** The catalog the session opened (`memory`, or the .duckdb file's name). */
  mainCatalog: string;
  /** [catalog, schema, name, 'table' | 'view', estimated_size] */
  tables: unknown[][];
  /** [catalog, schema, table, column, index, data_type, is_nullable, default] */
  columns: unknown[][];
  /** [catalog, schema, table, column names (JSON array)] — primary keys */
  primaryKeys: unknown[][];
  /** [catalog, schema, table, index name, sql, unique] */
  indexes: unknown[][];
  /**
   * [catalog, schema, table, constraint name, columns (JSON array),
   *  referenced table, referenced columns (JSON array)]. Optional: older
   * snapshots and test fixtures predate it.
   */
  foreignKeys?: unknown[][];
}

/** A data file that backs a view, for the structure view's details. */
export interface DuckdbViewSource {
  view: string;
  path: string;
  kind: DataFileKind;
  bytes: number | null;
  /** Workbook sheet the view reads (Excel files). */
  sheet?: string;
}

const HIDDEN_SCHEMAS = new Set(['information_schema', 'pg_catalog']);

const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export function duckdbSchemaName(raw: DuckdbRawSchema, catalog: string, schema: string): string {
  return catalog === raw.mainCatalog ? schema : `${catalog}.${schema}`;
}

function parseNames(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // not JSON
    }
  }
  return [];
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function buildDuckdbSchema(
  raw: DuckdbRawSchema,
  sources: readonly DuckdbViewSource[] = [],
  opts?: IntrospectOpts,
): SchemaInfo {
  const wantObjects = opts?.objects !== false;
  const wantColumns = opts?.columns !== false;
  const visible = <T extends unknown[]>(rows: T[]): T[] =>
    rows.filter((r) => !HIDDEN_SCHEMAS.has(s(r[1]).toLowerCase()));
  const scope = opts?.columnSchemas ? new Set(opts.columnSchemas) : null;

  const sourceByView = new Map(sources.map((src) => [src.view, src]));
  const tableRows = visible(raw.tables);

  const tables: SchemaInfo['tables'] = wantObjects
    ? tableRows.map((r) => {
        const schema = duckdbSchemaName(raw, s(r[0]), s(r[1]));
        const name = s(r[2]);
        const kind = s(r[3]) === 'view' ? ('view' as const) : ('table' as const);
        const src =
          schema === 'main' && r[0] === raw.mainCatalog ? sourceByView.get(name) : undefined;
        const est = r[4] === null || r[4] === undefined ? null : Number(r[4]);
        const details = src
          ? [
              { label: 'Source file', value: src.path },
              { label: 'Format', value: DATA_FILE_KIND_LABEL[src.kind] },
              ...(src.sheet !== undefined ? [{ label: 'Sheet', value: src.sheet }] : []),
              ...(src.bytes !== null
                ? [{ label: 'File size', value: formatBytes(src.bytes) }]
                : []),
            ]
          : undefined;
        return {
          schema,
          name,
          kind,
          rowCountEstimate: kind === 'table' && est !== null && Number.isFinite(est) ? est : null,
          ...(details ? { details } : {}),
        };
      })
    : [];

  const pk = new Set<string>();
  for (const r of visible(raw.primaryKeys)) {
    const schema = duckdbSchemaName(raw, s(r[0]), s(r[1]));
    for (const c of parseNames(r[3])) pk.add(`${schema}\u0000${s(r[2])}\u0000${c}`);
  }

  const columns: SchemaInfo['columns'] = wantColumns
    ? visible(raw.columns)
        .map((r) => ({ r, schema: duckdbSchemaName(raw, s(r[0]), s(r[1])) }))
        .filter(({ schema }) => !scope || scope.has(schema))
        .map(({ r, schema }) => {
          const table = s(r[2]);
          const name = s(r[3]);
          const def = r[7] === null || r[7] === undefined ? null : s(r[7]);
          return {
            schema,
            table,
            name,
            dataType: s(r[5]).toLowerCase(),
            // duckdb_columns() numbers columns from 1.
            ordinal: Number(r[4]),
            isPrimaryKey: pk.has(`${schema}\u0000${table}\u0000${name}`),
            isNullable: r[6] === true || s(r[6]).toLowerCase() === 'true',
            hasDefault: def !== null,
            defaultExpr: def,
            identity: null,
          };
        })
    : [];

  // duckdb_constraints() names the referenced table but not its schema; DuckDB
  // resolves it in the referencing table's own schema, so that is what we report.
  const foreignKeys: SchemaInfo['foreignKeys'] = [];
  if (wantColumns) {
    for (const r of visible(raw.foreignKeys ?? [])) {
      const schema = duckdbSchemaName(raw, s(r[0]), s(r[1]));
      if (scope && !scope.has(schema)) continue;
      const from = parseNames(r[4]);
      const to = parseNames(r[6]);
      from.forEach((column, i) => {
        foreignKeys.push({
          schema,
          table: s(r[2]),
          column,
          refSchema: schema,
          refTable: s(r[5]),
          refColumn: to[i] ?? '',
          constraint: s(r[3]),
        });
      });
    }
  }

  const indexes: NonNullable<SchemaInfo['indexes']> = wantColumns
    ? visible(raw.indexes).map((r) => ({
        schema: duckdbSchemaName(raw, s(r[0]), s(r[1])),
        table: s(r[2]),
        name: s(r[3]),
        definition: s(r[4]),
        unique: r[5] === true || s(r[5]).toLowerCase() === 'true',
        primary: false,
      }))
    : [];

  const schemaNames = new Set<string>();
  for (const t of tables) schemaNames.add(t.schema);
  if (wantObjects && !schemaNames.has('main')) schemaNames.add('main');

  return {
    schemas: wantObjects ? [...schemaNames].sort().map((name) => ({ name })) : [],
    tables,
    columns,
    foreignKeys,
    indexes,
    triggers: [],
    routines: [],
    sequences: [],
    types: [],
    extensions: [],
  };
}

/** Catalog queries behind {@link DuckdbRawSchema}; keys are the raw fields. */
export const DUCKDB_INTROSPECT_SQL = {
  mainCatalog: 'SELECT current_database()',
  tables: `SELECT database_name, schema_name, table_name, 'table', estimated_size
           FROM duckdb_tables() WHERE NOT internal AND schema_name NOT IN ('information_schema', 'pg_catalog')
           UNION ALL
           SELECT database_name, schema_name, view_name, 'view', NULL
           FROM duckdb_views() WHERE NOT internal AND schema_name NOT IN ('information_schema', 'pg_catalog')
           ORDER BY 1, 2, 3`,
  columns: `SELECT database_name, schema_name, table_name, column_name, column_index, data_type,
                   is_nullable, column_default
            FROM duckdb_columns() WHERE NOT internal AND schema_name NOT IN ('information_schema', 'pg_catalog')
            ORDER BY database_name, schema_name, table_name, column_index`,
  primaryKeys: `SELECT database_name, schema_name, table_name, to_json(constraint_column_names)
                FROM duckdb_constraints() WHERE constraint_type = 'PRIMARY KEY'`,
  indexes: `SELECT database_name, schema_name, table_name, index_name, sql, is_unique
            FROM duckdb_indexes()`,
  foreignKeys: `SELECT database_name, schema_name, table_name, constraint_name,
                       to_json(constraint_column_names), referenced_table, to_json(referenced_column_names)
                FROM duckdb_constraints() WHERE constraint_type = 'FOREIGN KEY'`,
} as const;
