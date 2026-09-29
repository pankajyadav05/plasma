import { describe, expect, it } from 'vitest';
import {
  isTxnExemptSql,
  looksDestructiveSql,
  looksLikeWriteSql,
  sqlSkeleton,
} from './sql-statements';

describe('sqlSkeleton', () => {
  it('drops comments and literal contents', () => {
    expect(sqlSkeleton("UPDATE t SET a = 'where' -- where\n")).toBe("update t set a = ''");
    expect(sqlSkeleton('SELECT "drop" FROM $x$ delete $x$')).toBe(`select "_" from ''`);
    expect(sqlSkeleton("SELECT E'it\\'s where'")).toBe("select e''");
    expect(sqlSkeleton('SELECT a$b$c FROM t')).toBe('select a$b$c from t');
  });
});

describe('looksDestructiveSql (prod gate, F8)', () => {
  it.each([
    'DELETE FROM t',
    'drop table x',
    'TRUNCATE t',
    'UPDATE t SET a = 1',
    'UPDATE t SET a = 1 -- where',
    "UPDATE t SET a = 'where'",
    'ALTER TABLE x\n  DROP COLUMN y',
    'ALTER TABLE x RENAME TO y',
    'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d',
    'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE',
    'INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET a = 2',
    'DO $$ BEGIN DELETE FROM t; END $$',
    'CALL purge()',
    "COPY t FROM '/tmp/x.csv'",
    '/* hi */ -- x\n delete from t where id = 1',
    'EXPLAIN ANALYZE DELETE FROM t',
  ])('flags %s', (sql) => {
    expect(looksDestructiveSql(sql)).toBe(true);
  });

  it.each([
    'SELECT * FROM t',
    'UPDATE t SET a = 1 WHERE id = 2',
    "SELECT 'drop table x'",
    'INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING',
    'EXPLAIN DELETE FROM t',
    "COPY t TO '/tmp/x.csv'",
  ])('allows %s', (sql) => {
    expect(looksDestructiveSql(sql)).toBe(false);
  });
});

describe('looksLikeWriteSql', () => {
  it('treats reads as reads', () => {
    expect(looksLikeWriteSql('SELECT 1')).toBe(false);
    expect(looksLikeWriteSql('WITH a AS (SELECT 1) SELECT * FROM a')).toBe(false);
    expect(looksLikeWriteSql('EXPLAIN DELETE FROM t')).toBe(false);
    expect(looksLikeWriteSql("SELECT 'insert'")).toBe(false);
  });
  it('treats writes as writes', () => {
    expect(looksLikeWriteSql('INSERT INTO t VALUES (1)')).toBe(true);
    expect(looksLikeWriteSql('WITH d AS (DELETE FROM t RETURNING 1) SELECT 1')).toBe(true);
    expect(looksLikeWriteSql('SELECT * INTO t2 FROM t')).toBe(true);
    expect(looksLikeWriteSql('SELECT * FROM t FOR UPDATE')).toBe(true);
    expect(looksLikeWriteSql('EXPLAIN (ANALYZE) UPDATE t SET a = 1')).toBe(true);
  });
});

describe('isTxnExemptSql (Transaction mode)', () => {
  it('exempts transaction control and non-transactional statements', () => {
    for (const sql of [
      'BEGIN',
      '-- c\ncommit',
      'END',
      'ROLLBACK',
      'SAVEPOINT a',
      'VACUUM t',
      'CREATE INDEX CONCURRENTLY i ON t (a)',
      'CREATE DATABASE x',
      "PREPARE TRANSACTION 'x'",
    ]) {
      expect(isTxnExemptSql(sql)).toBe(true);
    }
  });
  it('auto-begins ordinary statements', () => {
    for (const sql of [
      'SELECT 1',
      'UPDATE t SET a = 1',
      'CREATE TABLE x (a int)',
      'PREPARE p AS SELECT 1',
    ]) {
      expect(isTxnExemptSql(sql)).toBe(false);
    }
  });
});
