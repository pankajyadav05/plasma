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
  });

  it('labels a SQLite connection by its file', () => {
    expect(fileBaseName('/home/me/data/app.db')).toBe('app.db');
    expect(fileBaseName('C:\\data\\app.db')).toBe('app.db');
    expect(databaseLabel({ engine: 'sqlite', database: '/x/y/file.db' })).toBe('file.db');
    expect(databaseLabel({ engine: 'mysql', database: 'shop' })).toBe('shop');
  });
});
