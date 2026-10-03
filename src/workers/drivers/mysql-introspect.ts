import type { IntrospectOpts, SchemaInfo } from '@shared/protocol';

/**
 * MySQL / MariaDB introspection from information_schema. The SQL lives in
 * `mysqlIntrospectQueries`; `buildMysqlSchema` turns the raw rows into a
 * `SchemaInfo` and is pure, so the parsing is unit-tested on fixtures.
 * MySQL's "schemas" are databases; the system ones are hidden.
 */

export const MYSQL_SYSTEM_SCHEMAS = ['information_schema', 'mysql', 'performance_schema', 'sys'];

export interface MysqlRawSchema {
  /** [schema] */
  schemas: unknown[][];
  /** [schema, table, table_type, table_rows] */
  tables: unknown[][];
  /** [schema, table, column, column_type, ordinal, column_key, is_nullable, default, extra] */
  columns: unknown[][];
  /** [schema, table, column, ref_schema, ref_table, ref_column, constraint, update_rule, delete_rule] */
  foreignKeys: unknown[][];
  /** [schema, table, index, non_unique, seq, column, sub_part] */
  indexes: unknown[][];
  /** [schema, table, trigger] */
  triggers: unknown[][];
}

const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

type FkAction = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT';
function fkAction(raw: unknown): FkAction {
  const v = s(raw).toUpperCase();
  return v === 'RESTRICT' || v === 'CASCADE' || v === 'SET NULL' || v === 'SET DEFAULT'
    ? v
    : 'NO ACTION';
}

export function buildMysqlSchema(raw: MysqlRawSchema, opts?: IntrospectOpts): SchemaInfo {
  const wantObjects = opts?.objects !== false;
  const wantColumns = opts?.columns !== false;

  const tables: SchemaInfo['tables'] = wantObjects
    ? raw.tables.map((r) => {
        const est = r[3] === null || r[3] === undefined ? null : Number(r[3]);
        return {
          schema: s(r[0]),
          name: s(r[1]),
          kind: s(r[2]).toUpperCase() === 'VIEW' ? ('view' as const) : ('table' as const),
          rowCountEstimate: est !== null && Number.isFinite(est) ? est : null,
        };
      })
    : [];

  const columns: SchemaInfo['columns'] = wantColumns
    ? raw.columns.map((r) => {
        const extra = s(r[8]).toLowerCase();
        const auto = extra.includes('auto_increment');
        const generated = extra.includes('generated');
        const def = r[7] === null || r[7] === undefined ? null : s(r[7]);
        return {
          schema: s(r[0]),
          table: s(r[1]),
          name: s(r[2]),
          dataType: s(r[3]),
          ordinal: Number(r[4]),
          isPrimaryKey: s(r[5]).toUpperCase() === 'PRI',
          isNullable: s(r[6]).toUpperCase() === 'YES',
          hasDefault: def !== null || auto || generated,
          defaultExpr: def,
          identity: auto ? ('by default' as const) : null,
        };
      })
    : [];

  const foreignKeys: SchemaInfo['foreignKeys'] = wantColumns
    ? raw.foreignKeys.map((r) => ({
        schema: s(r[0]),
        table: s(r[1]),
        column: s(r[2]),
        refSchema: s(r[3]),
        refTable: s(r[4]),
        refColumn: s(r[5]),
        constraint: s(r[6]),
        onUpdate: fkAction(r[7]),
        onDelete: fkAction(r[8]),
      }))
    : [];

  // One statistics row per index column; fold them back into indexes.
  const byIndex = new Map<
    string,
    { schema: string; table: string; name: string; unique: boolean; cols: string[] }
  >();
  for (const r of raw.indexes) {
    const key = `${s(r[0])}\u0000${s(r[1])}\u0000${s(r[2])}`;
    let ix = byIndex.get(key);
    if (!ix) {
      ix = { schema: s(r[0]), table: s(r[1]), name: s(r[2]), unique: Number(r[3]) === 0, cols: [] };
      byIndex.set(key, ix);
    }
    const col = r[5] === null ? '<expr>' : quoteIdent(s(r[5]));
    ix.cols.push(r[6] ? `${col}(${s(r[6])})` : col);
  }
  const indexes: NonNullable<SchemaInfo['indexes']> = wantColumns
    ? [...byIndex.values()].map((ix) => ({
        schema: ix.schema,
        table: ix.table,
        name: ix.name,
        definition: `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(ix.name)} ON ${quoteIdent(ix.table)} (${ix.cols.join(', ')})`,
        unique: ix.unique,
        primary: ix.name === 'PRIMARY',
      }))
    : [];

  return {
    schemas: wantObjects ? raw.schemas.map((r) => ({ name: s(r[0]) })) : [],
    tables,
    columns,
    foreignKeys,
    indexes,
    triggers: raw.triggers.map((r) => ({ schema: s(r[0]), table: s(r[1]), name: s(r[2]) })),
    routines: [],
    sequences: [],
    types: [],
    extensions: [],
  };
}

/** Queries behind {@link MysqlRawSchema}; `schemas` limits the per-column ones. */
export function mysqlIntrospectQueries(
  opts: IntrospectOpts | undefined,
  allSchemas: readonly string[],
): Array<{ key: keyof MysqlRawSchema; sql: string; params: unknown[] }> {
  const wantObjects = opts?.objects !== false;
  const wantColumns = opts?.columns !== false;
  const scope = (opts?.columnSchemas ?? allSchemas).filter((n) => allSchemas.includes(n));
  const marks = scope.map(() => '?').join(', ');
  const out: Array<{ key: keyof MysqlRawSchema; sql: string; params: unknown[] }> = [];
  const sys = MYSQL_SYSTEM_SCHEMAS.map(() => '?').join(', ');
  if (wantObjects) {
    out.push({
      key: 'schemas',
      sql: `SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN (${sys}) ORDER BY schema_name`,
      params: [...MYSQL_SYSTEM_SCHEMAS],
    });
    out.push({
      key: 'tables',
      sql: `SELECT table_schema, table_name, table_type, table_rows FROM information_schema.tables
            WHERE table_schema NOT IN (${sys}) ORDER BY table_schema, table_name`,
      params: [...MYSQL_SYSTEM_SCHEMAS],
    });
  }
  if (scope.length > 0) {
    if (wantColumns) {
      out.push({
        key: 'columns',
        sql: `SELECT table_schema, table_name, column_name, column_type, ordinal_position, column_key,
                     is_nullable, column_default, extra
              FROM information_schema.columns WHERE table_schema IN (${marks})
              ORDER BY table_schema, table_name, ordinal_position`,
        params: scope,
      });
      out.push({
        key: 'foreignKeys',
        sql: `SELECT k.table_schema, k.table_name, k.column_name, k.referenced_table_schema,
                     k.referenced_table_name, k.referenced_column_name, k.constraint_name,
                     r.update_rule, r.delete_rule
              FROM information_schema.key_column_usage k
              JOIN information_schema.referential_constraints r
                ON r.constraint_schema = k.constraint_schema
               AND r.constraint_name = k.constraint_name AND r.table_name = k.table_name
              WHERE k.referenced_table_name IS NOT NULL AND k.table_schema IN (${marks})
              ORDER BY k.table_schema, k.table_name, k.constraint_name, k.ordinal_position`,
        params: scope,
      });
      out.push({
        key: 'indexes',
        sql: `SELECT table_schema, table_name, index_name, non_unique, seq_in_index, column_name, sub_part
              FROM information_schema.statistics WHERE table_schema IN (${marks})
              ORDER BY table_schema, table_name, index_name, seq_in_index`,
        params: scope,
      });
    }
    if (wantObjects || wantColumns) {
      out.push({
        key: 'triggers',
        sql: `SELECT trigger_schema, event_object_table, trigger_name FROM information_schema.triggers
              WHERE trigger_schema IN (${marks}) ORDER BY trigger_schema, event_object_table, trigger_name`,
        params: scope,
      });
    }
  }
  return out;
}
