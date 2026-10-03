import { describe, expect, it } from 'vitest';
import { type DuckdbRawSchema, buildDuckdbSchema } from './duckdb-introspect';

const raw: DuckdbRawSchema = {
  mainCatalog: 'memory',
  tables: [
    ['memory', 'main', 'sales', 'view', null],
    ['memory', 'main', 'scratch', 'table', 12],
    ['pg_prod', 'public', 'users', 'table', 400],
    ['pg_prod', 'information_schema', 'tables', 'view', null],
  ],
  columns: [
    ['memory', 'main', 'sales', 'id', 1, 'BIGINT', true, null],
    ['memory', 'main', 'sales', 'region', 2, 'VARCHAR', true, null],
    ['pg_prod', 'public', 'users', 'id', 1, 'INTEGER', false, "nextval('seq')"],
    ['pg_prod', 'information_schema', 'tables', 'x', 1, 'VARCHAR', true, null],
  ],
  primaryKeys: [['pg_prod', 'public', 'users', '["id"]']],
  indexes: [['pg_prod', 'public', 'users', 'users_pkey', 'CREATE UNIQUE INDEX users_pkey', true]],
};

describe('buildDuckdbSchema', () => {
  const sources = [{ view: 'sales', path: '/data/sales.csv', kind: 'csv' as const, bytes: 2048 }];
  const schema = buildDuckdbSchema(raw, sources);

  it('keeps the session catalog plain and prefixes attached catalogs', () => {
    expect(schema.tables.map((t) => [t.schema, t.name, t.kind])).toEqual([
      ['main', 'sales', 'view'],
      ['main', 'scratch', 'table'],
      ['pg_prod.public', 'users', 'table'],
    ]);
    expect(schema.schemas.map((s) => s.name)).toEqual(['main', 'pg_prod.public']);
  });

  it('describes the source file of a view', () => {
    expect(schema.tables[0]?.details).toEqual([
      { label: 'Source file', value: '/data/sales.csv' },
      { label: 'Format', value: 'CSV' },
      { label: 'File size', value: '2.0 KB' },
    ]);
    expect(schema.tables[1]?.details).toBeUndefined();
  });

  it('reads columns, keys and indexes and hides system schemas', () => {
    expect(schema.columns.map((c) => `${c.schema}.${c.table}.${c.name}`)).toEqual([
      'main.sales.id',
      'main.sales.region',
      'pg_prod.public.users.id',
    ]);
    const id = schema.columns[2];
    expect(id).toMatchObject({
      dataType: 'integer',
      isPrimaryKey: true,
      isNullable: false,
      hasDefault: true,
    });
    expect(schema.indexes?.[0]).toMatchObject({
      name: 'users_pkey',
      unique: true,
      schema: 'pg_prod.public',
    });
  });

  it('scopes columns to the requested schemas', () => {
    const s = buildDuckdbSchema(raw, sources, { columnSchemas: ['main'] });
    expect(s.columns.every((c) => c.schema === 'main')).toBe(true);
  });

  it('always offers the main schema', () => {
    const s = buildDuckdbSchema({ ...raw, tables: [], columns: [] });
    expect(s.schemas).toEqual([{ name: 'main' }]);
  });
});
