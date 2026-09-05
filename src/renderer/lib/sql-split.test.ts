import { describe, expect, it } from 'vitest';
import { splitSqlStatements } from './sql-split';

describe('splitSqlStatements', () => {
  it('splits on semicolons and strips the terminator', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('keeps a trailing statement without a terminator', () => {
    expect(splitSqlStatements('SELECT 1;\nSELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('drops empty statements', () => {
    expect(splitSqlStatements(';;\n  ;SELECT 1;;')).toEqual(['SELECT 1']);
    expect(splitSqlStatements('   \n  ')).toEqual([]);
  });

  it('ignores semicolons inside single-quoted literals, including doubled quotes', () => {
    expect(splitSqlStatements("SELECT 'a;b', 'it''s; fine'; SELECT 2")).toEqual([
      "SELECT 'a;b', 'it''s; fine'",
      'SELECT 2',
    ]);
  });

  it('ignores semicolons inside quoted identifiers', () => {
    expect(splitSqlStatements('SELECT "we;ird", "qu""ote;d" FROM t; SELECT 2')).toEqual([
      'SELECT "we;ird", "qu""ote;d" FROM t',
      'SELECT 2',
    ]);
  });

  it('keeps a dollar-quoted function body intact', () => {
    const sql = [
      'CREATE FUNCTION f() RETURNS int AS $$',
      'BEGIN',
      '  PERFORM 1;',
      '  RETURN 2;',
      'END',
      '$$ LANGUAGE plpgsql;',
      'SELECT f()',
    ].join('\n');
    const out = splitSqlStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('RETURN 2;');
    expect(out[0]?.endsWith('LANGUAGE plpgsql')).toBe(true);
    expect(out[1]).toBe('SELECT f()');
  });

  it('matches dollar quotes by tag, not by the bare delimiter', () => {
    const sql = 'DO $body$ SELECT $$inner; text$$; $body$; SELECT 1';
    expect(splitSqlStatements(sql)).toEqual([
      'DO $body$ SELECT $$inner; text$$; $body$',
      'SELECT 1',
    ]);
  });

  it('treats an unterminated dollar quote as a single trailing statement', () => {
    expect(splitSqlStatements('SELECT 1; DO $$ BEGIN; RETURN;')).toEqual([
      'SELECT 1',
      'DO $$ BEGIN; RETURN;',
    ]);
  });

  it('ignores semicolons inside line comments', () => {
    expect(splitSqlStatements('SELECT 1 -- trailing; comment\n; SELECT 2')).toEqual([
      'SELECT 1 -- trailing; comment',
      'SELECT 2',
    ]);
  });

  it('ignores semicolons inside nested block comments', () => {
    expect(splitSqlStatements('SELECT 1 /* outer /* inner; */ still; */; SELECT 2')).toEqual([
      'SELECT 1 /* outer /* inner; */ still; */',
      'SELECT 2',
    ]);
  });
});
