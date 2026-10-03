import type { IntrospectOpts, SchemaInfo } from '@shared/protocol';

/**
 * SQLite introspection: tables, views, indexes, triggers, columns (type,
 * nullability, default, PK from `pragma table_xinfo`) and foreign keys (from
 * `pragma foreign_key_list`). The pragma rows are read by `introspectSqlite`;
 * `buildSqliteSchema` turns them into a `SchemaInfo` and is pure, so the
 * parsing is unit-tested on fixtures.
 */

export const SQLITE_SCHEMA = 'main';

export interface SqliteTableRow {
  name: string;
  /** `table`, `view` or `virtual` (shadow tables are filtered out). */
  type: string;
  /** WITHOUT ROWID */
  wr: number;
}

export interface SqliteColumnRow {
  tbl: string;
  name: string;
  type: string | null;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  /** 0 normal, 1 hidden (virtual table), 2 generated virtual, 3 generated stored */
  hidden: number;
}

export interface SqliteFkRow {
  tbl: string;
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
}

export interface SqliteIndexRow {
  tbl: string;
  name: string;
  unique: number;
  origin: string;
  /** `CREATE INDEX` text from sqlite_schema; null for automatic indexes. */
  sql: string | null;
}

export interface SqliteIndexColumnRow {
  idx: string;
  seqno: number;
  name: string | null;
}

export interface SqliteTriggerRow {
  name: string;
  tbl_name: string;
  sql: string | null;
}

export interface SqliteRawSchema {
  tables: SqliteTableRow[];
  columns: SqliteColumnRow[];
  foreignKeys: SqliteFkRow[];
  indexes: SqliteIndexRow[];
  indexColumns: SqliteIndexColumnRow[];
  triggers: SqliteTriggerRow[];
}

type FkAction = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT';

function fkAction(raw: string | null | undefined): FkAction {
  const v = (raw ?? '').toUpperCase();
  return v === 'RESTRICT' || v === 'CASCADE' || v === 'SET NULL' || v === 'SET DEFAULT'
    ? v
    : 'NO ACTION';
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const ROWID_NAMES = ['rowid', '_rowid_', 'oid'];

/** Name usable as the implicit row id of a rowid table, or undefined when all are shadowed. */
export function implicitRowidName(columnNames: readonly string[]): string | undefined {
  const taken = new Set(columnNames.map((c) => c.toLowerCase()));
  return ROWID_NAMES.find((n) => !taken.has(n));
}

export function buildSqliteSchema(raw: SqliteRawSchema, opts?: IntrospectOpts): SchemaInfo {
  const wantObjects = opts?.objects !== false;
  const wantColumns = opts?.columns !== false;
  const wantSchema = !opts?.columnSchemas || opts.columnSchemas.includes(SQLITE_SCHEMA);

  const colsByTable = new Map<string, SqliteColumnRow[]>();
  for (const c of raw.columns) {
    if (c.hidden === 1) continue; // virtual-table plumbing, not a column
    const list = colsByTable.get(c.tbl);
    if (list) list.push(c);
    else colsByTable.set(c.tbl, [c]);
  }
  const tableByName = new Map(raw.tables.map((t) => [t.name, t]));

  const tables: SchemaInfo['tables'] = wantObjects
    ? raw.tables.map((t) => {
        const cols = colsByTable.get(t.name) ?? [];
        const rowidTable = t.type === 'table' && t.wr === 0;
        const hasPk = cols.some((c) => c.pk > 0);
        const implicit =
          rowidTable && !hasPk ? implicitRowidName(cols.map((c) => c.name)) : undefined;
        return {
          schema: SQLITE_SCHEMA,
          name: t.name,
          kind: t.type === 'view' ? ('view' as const) : ('table' as const),
          rowCountEstimate: null,
          ...(implicit ? { implicitRowid: implicit } : {}),
        };
      })
    : [];

  const columns: SchemaInfo['columns'] = [];
  const foreignKeys: SchemaInfo['foreignKeys'] = [];
  if (wantColumns && wantSchema) {
    for (const [tbl, cols] of colsByTable) {
      const meta = tableByName.get(tbl);
      const pkCount = cols.filter((c) => c.pk > 0).length;
      cols.forEach((c, i) => {
        const type = (c.type ?? '').trim();
        // `INTEGER PRIMARY KEY` is the rowid alias: it fills itself in on INSERT.
        const rowidAlias =
          pkCount === 1 &&
          c.pk > 0 &&
          /^integer$/i.test(type) &&
          meta?.type === 'table' &&
          meta.wr === 0;
        columns.push({
          schema: SQLITE_SCHEMA,
          table: tbl,
          name: c.name,
          dataType: type || 'any',
          ordinal: i + 1,
          isPrimaryKey: c.pk > 0,
          isNullable: c.notnull === 0 && !rowidAlias,
          hasDefault: c.dflt_value !== null || rowidAlias || c.hidden >= 2,
          defaultExpr: c.dflt_value,
          identity: rowidAlias ? 'by default' : null,
        });
      });
    }
    const pkOf = (tbl: string): string[] =>
      (colsByTable.get(tbl) ?? [])
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);

    for (const fk of raw.foreignKeys) {
      // `REFERENCES parent` without a column list means the parent's primary key.
      const refCol = fk.to ?? pkOf(fk.table)[fk.seq] ?? '';
      foreignKeys.push({
        schema: SQLITE_SCHEMA,
        table: fk.tbl,
        column: fk.from,
        refSchema: SQLITE_SCHEMA,
        refTable: fk.table,
        refColumn: refCol,
        constraint: `fk_${fk.tbl}_${fk.id}`,
        onDelete: fkAction(fk.on_delete),
        onUpdate: fkAction(fk.on_update),
      });
    }
  }

  const indexColsByName = new Map<string, string[]>();
  for (const ic of [...raw.indexColumns].sort((a, b) => a.seqno - b.seqno)) {
    const list = indexColsByName.get(ic.idx);
    const name = ic.name ?? '<expr>';
    if (list) list.push(name);
    else indexColsByName.set(ic.idx, [name]);
  }
  const indexes: NonNullable<SchemaInfo['indexes']> = raw.indexes.map((ix) => {
    const cols = indexColsByName.get(ix.name) ?? [];
    return {
      schema: SQLITE_SCHEMA,
      table: ix.tbl,
      name: ix.name,
      // Automatic indexes (PRIMARY KEY / UNIQUE constraints) have no stored SQL.
      definition:
        ix.sql ??
        `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(ix.name)} ON ${quoteIdent(ix.tbl)} (${cols
          .map(quoteIdent)
          .join(', ')})`,
      unique: ix.unique !== 0,
      primary: ix.origin === 'pk',
    };
  });

  return {
    schemas: wantObjects ? [{ name: SQLITE_SCHEMA }] : [],
    tables,
    columns,
    foreignKeys,
    indexes,
    triggers: raw.triggers.map((t) => ({
      schema: SQLITE_SCHEMA,
      table: t.tbl_name,
      name: t.name,
      ...(t.sql ? { definition: t.sql } : {}),
    })),
    routines: [],
    sequences: [],
    types: [],
    extensions: [],
  };
}

/** Minimal slice of better-sqlite3 the introspection needs (lets tests fake it). */
export interface SqliteReader {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

const USER_TABLE = `t.schema = 'main' AND t.type IN ('table', 'view', 'virtual') AND t.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`;

export function readSqliteSchema(db: SqliteReader): SqliteRawSchema {
  const all = <T>(sql: string): T[] => db.prepare(sql).all() as T[];
  return {
    tables: all<SqliteTableRow>(
      `SELECT t.name AS name, t.type AS type, t.wr AS wr FROM pragma_table_list t WHERE ${USER_TABLE} ORDER BY t.name`,
    ),
    columns: all<SqliteColumnRow>(
      `SELECT t.name AS tbl, c.name AS name, c.type AS type, c."notnull" AS "notnull",
              c.dflt_value AS dflt_value, c.pk AS pk, c.hidden AS hidden
       FROM pragma_table_list t, pragma_table_xinfo(t.name) c
       WHERE ${USER_TABLE} ORDER BY t.name, c.cid`,
    ),
    foreignKeys: all<SqliteFkRow>(
      `SELECT t.name AS tbl, f.id AS id, f.seq AS seq, f."table" AS "table", f."from" AS "from",
              f."to" AS "to", f.on_update AS on_update, f.on_delete AS on_delete
       FROM pragma_table_list t, pragma_foreign_key_list(t.name) f
       WHERE ${USER_TABLE} AND t.type = 'table' ORDER BY t.name, f.id, f.seq`,
    ),
    indexes: all<SqliteIndexRow>(
      `SELECT t.name AS tbl, i.name AS name, i."unique" AS "unique", i.origin AS origin, m.sql AS sql
       FROM pragma_table_list t, pragma_index_list(t.name) i
       LEFT JOIN sqlite_schema m ON m.type = 'index' AND m.name = i.name
       WHERE ${USER_TABLE} AND t.type = 'table' ORDER BY t.name, i.name`,
    ),
    indexColumns: all<SqliteIndexColumnRow>(
      `SELECT i.name AS idx, x.seqno AS seqno, x.name AS name
       FROM pragma_table_list t, pragma_index_list(t.name) i, pragma_index_info(i.name) x
       WHERE ${USER_TABLE} AND t.type = 'table'`,
    ),
    triggers: all<SqliteTriggerRow>(
      `SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY tbl_name, name`,
    ),
  };
}

export function introspectSqlite(db: SqliteReader, opts?: IntrospectOpts): SchemaInfo {
  return buildSqliteSchema(readSqliteSchema(db), opts);
}
