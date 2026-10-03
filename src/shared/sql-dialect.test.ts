import { describe, expect, it } from 'vitest';
import {
  MYSQL_DIALECT,
  POSTGRES_DIALECT,
  SQLITE_DIALECT,
  dialectFor,
  engineCaps,
  isSqlEngine,
  translatePlaceholders,
} from './sql-dialect';

describe('quoting', () => {
  it('quotes identifiers per engine and escapes the quote char', () => {
    expect(POSTGRES_DIALECT.quoteIdent('we"ird')).toBe('"we""ird"');
    expect(SQLITE_DIALECT.quoteIdent('a b')).toBe('"a b"');
    expect(MYSQL_DIALECT.quoteIdent('we`ird')).toBe('`we``ird`');
    expect(MYSQL_DIALECT.qualify('shop', 'orders')).toBe('`shop`.`orders`');
    expect(SQLITE_DIALECT.qualify(undefined, 't')).toBe('"t"');
  });

  it('renders literals', () => {
    expect(POSTGRES_DIALECT.literal("it's")).toBe("'it''s'");
    expect(POSTGRES_DIALECT.literal(true)).toBe('TRUE');
    expect(SQLITE_DIALECT.literal(true)).toBe('1');
    expect(SQLITE_DIALECT.literal(null)).toBe('NULL');
    expect(SQLITE_DIALECT.literal(Number.NaN)).toBe("'NaN'");
    expect(MYSQL_DIALECT.literal("a\\b'c\n")).toBe("'a\\\\b''c\\n'");
    expect(MYSQL_DIALECT.literal({ a: 1 })).toBe('\'{"a":1}\'');
    expect(MYSQL_DIALECT.literal(12n)).toBe('12');
  });
});

describe('SQL spelling', () => {
  it('LIKE, casts, defaults, locators and estimates differ per engine', () => {
    expect(POSTGRES_DIALECT.likePredicate('"c"', 'ILIKE', '$1')).toBe('"c"::text ILIKE $1');
    expect(SQLITE_DIALECT.likePredicate('"c"', 'NOT ILIKE', '$1')).toBe(
      `CAST("c" AS TEXT) NOT LIKE $1 ESCAPE '\\'`,
    );
    expect(MYSQL_DIALECT.likePredicate('`c`', 'LIKE', '$1')).toBe('CAST(`c` AS CHAR) LIKE $1');
    expect(MYSQL_DIALECT.insertDefaults('`t`')).toBe('INSERT INTO `t` () VALUES ()');
    expect(SQLITE_DIALECT.insertDefaults('"t"')).toBe('INSERT INTO "t" DEFAULT VALUES');
    expect([POSTGRES_DIALECT, SQLITE_DIALECT, MYSQL_DIALECT].map((d) => d.rowLocator)).toEqual([
      'ctid',
      'rowid',
      null,
    ]);
    expect(SQLITE_DIALECT.estimatedCount('main', 't')).toBeNull();
    expect(MYSQL_DIALECT.estimatedCount('db', 't')?.params).toEqual(['db', 't']);
    expect(SQLITE_DIALECT.explain('select 1;', false)).toBe('EXPLAIN QUERY PLAN select 1');
    expect(MYSQL_DIALECT.explain('select 1', false)).toBe('EXPLAIN FORMAT=JSON select 1');
  });
});

describe('capabilities', () => {
  it('disables the Postgres-only features cleanly', () => {
    const sqlite = engineCaps('sqlite');
    expect(sqlite).toMatchObject({
      sql: true,
      roles: false,
      pgBackup: false,
      fileBackup: true,
      health: false,
      safeRun: false,
      er: true,
    });
    expect(engineCaps('mysql')).toMatchObject({
      sql: true,
      roles: false,
      pgBackup: false,
      ssh: true,
    });
    expect(engineCaps('postgres')).toMatchObject({
      roles: true,
      pgBackup: true,
      health: true,
      safeRun: true,
    });
    expect(engineCaps('redis').sql).toBe(false);
    expect(engineCaps(undefined).sql).toBe(true);
  });

  it('knows SQL engines', () => {
    expect(isSqlEngine('mysql')).toBe(true);
    expect(isSqlEngine('redis')).toBe(false);
    expect(dialectFor('sqlite')).toBe(SQLITE_DIALECT);
    expect(dialectFor(undefined)).toBe(POSTGRES_DIALECT);
  });
});

describe('translatePlaceholders', () => {
  it('maps $n to ? in marker order, repeating reused values', () => {
    expect(translatePlaceholders('a = $2 AND b = $1 OR c = $2', ['x', 'y'])).toEqual({
      sql: 'a = ? AND b = ? OR c = ?',
      params: ['y', 'x', 'y'],
    });
  });

  it('leaves quoted text, identifiers and comments alone', () => {
    const sql = `SELECT '$1', "$1", \`$1\`, 'it''s $1' -- $1\n, /* $1 */ $1`;
    expect(translatePlaceholders(sql, ['v'])).toEqual({
      sql: `SELECT '$1', "$1", \`$1\`, 'it''s $1' -- $1\n, /* $1 */ ?`,
      params: ['v'],
    });
  });

  it('honours backslash escapes only when asked (MySQL)', () => {
    const sql = `SELECT 'a\\' $1 b', $1`;
    expect(translatePlaceholders(sql, ['v'], { backslashEscapes: true }).params).toEqual(['v']);
    expect(translatePlaceholders(sql, ['v'], { backslashEscapes: true }).sql).toBe(
      `SELECT 'a\\' $1 b', ?`,
    );
  });

  it('refuses a placeholder without a value and ignores a$1 identifiers', () => {
    expect(() => translatePlaceholders('select $2', ['x'])).toThrow(/\$2/);
    expect(translatePlaceholders('select a$1', []).sql).toBe('select a$1');
  });
});
