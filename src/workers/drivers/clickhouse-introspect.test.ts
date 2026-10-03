import { describe, expect, it } from 'vitest';
import {
  type ClickhouseRawSchema,
  buildClickhouseSchema,
  clickhouseIntrospectQueries,
  innerType,
  isNullableType,
  tableKindOf,
  ttlOf,
} from './clickhouse-introspect';

const raw: ClickhouseRawSchema = {
  schemas: [['analytics'], ['default']],
  tables: [
    [
      'analytics',
      'events',
      'MergeTree',
      '1200',
      '2048',
      'id, ts',
      'toYYYYMM(ts)',
      'id',
      'CREATE TABLE analytics.events (`id` UInt64, `ts` DateTime TTL ts + toIntervalDay(1)) ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (id, ts) PRIMARY KEY id TTL ts + toIntervalYear(1) SETTINGS index_granularity = 8192',
    ],
    [
      'analytics',
      'recent',
      'View',
      null,
      null,
      '',
      '',
      '',
      'CREATE VIEW analytics.recent AS SELECT 1',
    ],
    ['analytics', 'rollup', 'MaterializedView', '5', '100', '', '', '', ''],
  ],
  columns: [
    ['analytics', 'events', 'id', 'UInt64', 1, 1, '', ''],
    ['analytics', 'events', 'ts', 'LowCardinality(Nullable(String))', 2, 0, 'DEFAULT', 'now()'],
    ['analytics', 'events', 'host', 'String', 3, 0, 'MATERIALIZED', 'hostName()'],
  ],
  indexes: [['analytics', 'events', 'idx_host', 'bloom_filter', 'host', 4]],
};

describe('buildClickhouseSchema', () => {
  const schema = buildClickhouseSchema(raw);

  it('lists databases as schemas and classifies views', () => {
    expect(schema.schemas).toEqual([{ name: 'analytics' }, { name: 'default' }]);
    expect(schema.tables.map((t) => [t.name, t.kind])).toEqual([
      ['events', 'table'],
      ['recent', 'view'],
      ['rollup', 'matview'],
    ]);
    expect(schema.tables[0]?.rowCountEstimate).toBe(1200);
    expect(schema.tables[1]?.rowCountEstimate).toBeNull();
  });

  it('puts engine, sorting key, partition key, TTL and size in the details', () => {
    expect(schema.tables[0]?.details).toEqual([
      { label: 'Engine', value: 'MergeTree' },
      { label: 'Sorting key', value: 'id, ts' },
      { label: 'Partition key', value: 'toYYYYMM(ts)' },
      { label: 'Primary key', value: 'id' },
      { label: 'TTL', value: 'ts + toIntervalYear(1)' },
      { label: 'Size on disk', value: '2.0 KB' },
    ]);
  });

  it('reads nullability, primary key and defaults from the column rows', () => {
    const [id, ts, host] = schema.columns;
    expect(id).toMatchObject({
      name: 'id',
      isPrimaryKey: true,
      isNullable: false,
      hasDefault: false,
    });
    expect(ts).toMatchObject({ isNullable: true, hasDefault: true, defaultExpr: 'now()' });
    expect(host?.hasDefault).toBe(true);
  });

  it('writes skipping indexes as definitions', () => {
    expect(schema.indexes?.[0]?.definition).toBe(
      'INDEX `idx_host` host TYPE bloom_filter GRANULARITY 4',
    );
  });

  it('honours objects / columns options', () => {
    expect(buildClickhouseSchema(raw, { objects: false }).tables).toEqual([]);
    expect(buildClickhouseSchema(raw, { columns: false }).columns).toEqual([]);
  });
});

describe('helpers', () => {
  it('finds the table TTL, not a column TTL, in single- and multi-line DDL', () => {
    expect(
      ttlOf('CREATE TABLE t (`a` DateTime TTL a + 1) ENGINE = MergeTree ORDER BY a SETTINGS x = 1'),
    ).toBeNull();
    expect(
      ttlOf(
        'CREATE TABLE t (a Int8)\nENGINE = MergeTree\nORDER BY a\nTTL a + toIntervalDay(7)\nSETTINGS x = 1',
      ),
    ).toBe('a + toIntervalDay(7)');
    expect(ttlOf('CREATE TABLE t (a Int8) ENGINE = Memory')).toBeNull();
  });

  it('unwraps Nullable and LowCardinality', () => {
    expect(innerType('LowCardinality(Nullable(String))')).toBe('String');
    expect(innerType('Array(Nullable(Int8))')).toBe('Array(Nullable(Int8))');
    expect(isNullableType('Nullable(Int8)')).toBe(true);
    expect(isNullableType('LowCardinality(Nullable(String))')).toBe(true);
    expect(isNullableType('Array(Nullable(Int8))')).toBe(false);
    expect(tableKindOf('LiveView')).toBe('view');
    expect(tableKindOf('Distributed')).toBe('table');
  });

  it('scopes the per-column queries to the requested databases', () => {
    const all = clickhouseIntrospectQueries(undefined, ['a', 'b']);
    expect(all.map((q) => q.key)).toEqual(['schemas', 'tables', 'columns', 'indexes']);
    const scoped = clickhouseIntrospectQueries({ columnSchemas: ['b', 'zzz'] }, ['a', 'b']);
    expect(scoped.find((q) => q.key === 'columns')?.params).toEqual([['b']]);
    expect(clickhouseIntrospectQueries({ columns: false }, ['a']).map((q) => q.key)).toEqual([
      'schemas',
      'tables',
    ]);
  });
});
