import { describe, expect, it } from 'vitest';
import { databaseLabel, fileBaseName, shortServerVersion } from './engine-meta';

describe('capsule text', () => {
  it('shortens versions per engine', () => {
    expect(shortServerVersion('PostgreSQL 16.2 on x86_64', 'postgres')).toBe('PostgreSQL 16.2');
    expect(shortServerVersion('3.46.0', 'sqlite')).toBe('SQLite 3.46');
    expect(shortServerVersion('MySQL 8.4.0', 'mysql')).toBe('MySQL 8.4');
    expect(shortServerVersion('MariaDB 10.11.6-MariaDB-log', 'mysql')).toBe('MariaDB 10.11');
    expect(shortServerVersion('7.2.4', 'redis')).toBe('Redis 7.2.4');
    expect(shortServerVersion(null, 'sqlite')).toBe('SQLite');
    expect(shortServerVersion('ClickHouse 26.10.1.1372', 'clickhouse')).toBe('ClickHouse 26.10');
    expect(shortServerVersion('1.5.6', 'duckdb')).toBe('DuckDB 1.5');
  });

  it('labels a DuckDB session by its file, file count or memory', () => {
    expect(databaseLabel({ engine: 'duckdb', database: '/x/w.duckdb' })).toBe('w.duckdb');
    expect(
      databaseLabel({
        engine: 'duckdb',
        database: ':memory:',
        duckdb: { files: ['/a/sales.csv'] },
      }),
    ).toBe('sales.csv');
    expect(
      databaseLabel({
        engine: 'duckdb',
        database: ':memory:',
        duckdb: { files: ['/a/a.csv', '/b/b.csv'] },
      }),
    ).toBe('2 files');
    expect(databaseLabel({ engine: 'duckdb', database: ':memory:' })).toBe('in-memory');
    expect(databaseLabel({ engine: 'clickhouse', database: 'default' })).toBe('default');
  });

  it('labels a SQLite connection by its file', () => {
    expect(fileBaseName('/home/me/data/app.db')).toBe('app.db');
    expect(fileBaseName('C:\\data\\app.db')).toBe('app.db');
    expect(databaseLabel({ engine: 'sqlite', database: '/x/y/file.db' })).toBe('file.db');
    expect(databaseLabel({ engine: 'mysql', database: 'shop' })).toBe('shop');
  });
});
