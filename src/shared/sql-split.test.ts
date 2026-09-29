import { describe, expect, it } from 'vitest';
import { splitSqlStatementRanges, unsupportedStatementReason } from './sql-split';
import { splitSqlStatements as workerSplit } from './sql-statements';

const texts = (sql: string) => splitSqlStatementRanges(sql).map((s) => s.text);

describe('shared SQL splitter (F18 / E4)', () => {
  it('keeps a BEGIN ATOMIC function body in one statement', () => {
    const fn = `CREATE FUNCTION add(a int, b int) RETURNS int
LANGUAGE sql
BEGIN ATOMIC
  SELECT 1;
  SELECT a + b;
END`;
    expect(texts(`${fn};\nSELECT 2;`)).toEqual([fn, 'SELECT 2']);
  });

  it('tracks CASE … END inside BEGIN ATOMIC and CREATE OR REPLACE PROCEDURE', () => {
    const proc = `CREATE OR REPLACE PROCEDURE p(x int)
BEGIN ATOMIC
  INSERT INTO t VALUES (CASE WHEN x > 0 THEN 1 ELSE 0 END);
  DELETE FROM t WHERE false;
END`;
    expect(texts(`${proc}; SELECT 3`)).toEqual([proc, 'SELECT 3']);
  });

  it('does not treat a transaction BEGIN as a block', () => {
    expect(texts('BEGIN; UPDATE t SET a = 1; END;')).toEqual([
      'BEGIN',
      'UPDATE t SET a = 1',
      'END',
    ]);
  });

  it('does not read a $ inside an identifier as a dollar quote', () => {
    expect(texts('SELECT a$b$c FROM t; SELECT 2')).toEqual(['SELECT a$b$c FROM t', 'SELECT 2']);
    expect(texts('SELECT $1; SELECT $2')).toEqual(['SELECT $1', 'SELECT $2']);
  });

  it('handles E strings and dollar-quoted bodies', () => {
    expect(texts("SELECT E'a\\';b'; SELECT $x$ ; $x$; SELECT 3")).toEqual([
      "SELECT E'a\\';b'",
      'SELECT $x$ ; $x$',
      'SELECT 3',
    ]);
  });

  it('drops comment-only chunks', () => {
    expect(texts('SELECT 1; -- done\n/* trailing */')).toEqual(['SELECT 1']);
    expect(texts('-- only a comment')).toEqual([]);
  });

  it('keeps offsets into the original buffer', () => {
    const sql = '  SELECT 1 ;\n\nSELECT 2';
    const [a, b] = splitSqlStatementRanges(sql);
    expect(sql.slice(a!.start, a!.end)).toBe('SELECT 1');
    expect(sql.slice(b!.start, b!.end)).toBe('SELECT 2');
  });

  it('stays linear on large inputs with many $ signs', () => {
    const big = 'SELECT $1, a$b;'.repeat(20_000);
    const t0 = Date.now();
    expect(splitSqlStatementRanges(big)).toHaveLength(20_000);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('is the same splitter the worker uses', () => {
    const sql =
      "SELECT E'x;'; CREATE FUNCTION f() RETURNS int BEGIN ATOMIC SELECT 1; END; SELECT 2";
    expect(workerSplit(sql)).toEqual(texts(sql));
  });

  it('names statements the query path cannot run', () => {
    expect(unsupportedStatementReason('\\dt')).toMatch(/meta-command/);
    expect(unsupportedStatementReason('COPY t FROM STDIN')).toMatch(/STDIN/);
    expect(unsupportedStatementReason('-- x\ncopy t (a) to stdout')).toMatch(/STDOUT/);
    expect(unsupportedStatementReason("COPY t FROM '/tmp/x.csv'")).toBeNull();
    expect(unsupportedStatementReason('SELECT 1')).toBeNull();
  });
});
