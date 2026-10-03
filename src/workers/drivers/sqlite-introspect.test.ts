import { describe, expect, it } from 'vitest';
import { buildSqliteSchema, implicitRowidName } from './sqlite-introspect';

const col = (tbl: string, name: string, over: Record<string, unknown> = {}) => ({
  tbl,
  name,
  type: 'TEXT',
  notnull: 0,
  dflt_value: null,
  pk: 0,
  hidden: 0,
  ...over,
});

describe('buildSqliteSchema', () => {
  const raw = {
    tables: [
      { name: 'a', type: 'table', wr: 0 },
      { name: 'v', type: 'view', wr: 0 },
      { name: 'w', type: 'table', wr: 1 },
      { name: 'fts', type: 'virtual', wr: 0 },
    ],
    columns: [
      col('a', 'id', { type: 'INTEGER', pk: 1 }),
      col('a', 'b_id', { type: 'INTEGER', notnull: 1 }),
      col('v', 'id'),
      col('w', 'k', { pk: 1 }),
      col('fts', 'body'),
      col('fts', 'fts', { hidden: 1 }),
    ],
    foreignKeys: [
      {
        tbl: 'a',
        id: 0,
        seq: 0,
        table: 'w',
        from: 'b_id',
        to: null,
        on_update: 'NO ACTION',
        on_delete: 'SET NULL',
      },
    ],
    indexes: [
      { tbl: 'a', name: 'sqlite_autoindex_a_1', unique: 1, origin: 'u', sql: null },
      { tbl: 'a', name: 'a_b', unique: 0, origin: 'c', sql: 'CREATE INDEX a_b ON a(b_id)' },
    ],
    indexColumns: [{ idx: 'sqlite_autoindex_a_1', seqno: 0, name: 'b_id' }],
    triggers: [{ name: 't1', tbl_name: 'a', sql: 'CREATE TRIGGER t1 …' }],
  };

  it('maps tables, rowid aliases, hidden columns and keys', () => {
    const s = buildSqliteSchema(raw);
    expect(s.tables.map((t) => [t.name, t.kind, t.implicitRowid])).toEqual([
      ['a', 'table', undefined],
      ['v', 'view', undefined],
      ['w', 'table', undefined],
      ['fts', 'table', undefined],
    ]);
    expect(s.columns.find((c) => c.name === 'fts')).toBeUndefined();
    expect(s.columns.find((c) => c.table === 'a' && c.name === 'id')).toMatchObject({
      isPrimaryKey: true,
      isNullable: false,
      hasDefault: true,
      identity: 'by default',
    });
    // WITHOUT ROWID primary keys are plain keys, not rowid aliases.
    expect(s.columns.find((c) => c.table === 'w')).toMatchObject({ identity: null });
  });

  it('resolves a FK that omits the parent column to the parent key', () => {
    const s = buildSqliteSchema(raw);
    expect(s.foreignKeys[0]).toMatchObject({ refTable: 'w', refColumn: 'k', onDelete: 'SET NULL' });
  });

  it('synthesises definitions for automatic indexes and lists triggers', () => {
    const s = buildSqliteSchema(raw);
    expect(s.indexes?.[0]?.definition).toBe(
      'CREATE UNIQUE INDEX "sqlite_autoindex_a_1" ON "a" ("b_id")',
    );
    expect(s.triggers).toEqual([
      { schema: 'main', table: 'a', name: 't1', definition: 'CREATE TRIGGER t1 …' },
    ]);
  });

  it('honours the scope options', () => {
    expect(buildSqliteSchema(raw, { columns: false }).columns).toEqual([]);
    expect(buildSqliteSchema(raw, { objects: false }).tables).toEqual([]);
    expect(buildSqliteSchema(raw, { columnSchemas: ['other'] }).columns).toEqual([]);
  });

  it('picks a rowid alias that no column shadows', () => {
    expect(implicitRowidName(['x'])).toBe('rowid');
    expect(implicitRowidName(['rowid'])).toBe('_rowid_');
    expect(implicitRowidName(['RowId', '_rowid_', 'oid'])).toBeUndefined();
  });
});
