import { describe, expect, it } from 'vitest';
import { resolveRunTarget, splitSqlStatements, statementAtOffset } from './sql-split';

function texts(sql: string): string[] {
  return splitSqlStatements(sql).map((s) => s.text);
}

describe('splitSqlStatements', () => {
  it('splits on semicolons and strips the terminator', () => {
    expect(texts('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('keeps a trailing statement without a terminator', () => {
    expect(texts('SELECT 1;\nSELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('drops empty statements', () => {
    expect(texts(';;\n  ;SELECT 1;;')).toEqual(['SELECT 1']);
    expect(texts('   \n  ')).toEqual([]);
  });

  it('ignores semicolons inside single-quoted literals, including doubled quotes', () => {
    expect(texts("SELECT 'a;b', 'it''s; fine'; SELECT 2")).toEqual([
      "SELECT 'a;b', 'it''s; fine'",
      'SELECT 2',
    ]);
  });

  it('ignores semicolons inside quoted identifiers', () => {
    expect(texts('SELECT "we;ird", "qu""ote;d" FROM t; SELECT 2')).toEqual([
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
    expect(out[0]?.text).toContain('RETURN 2;');
    expect(out[0]?.text.endsWith('LANGUAGE plpgsql')).toBe(true);
    expect(out[1]?.text).toBe('SELECT f()');
  });

  it('matches dollar quotes by tag, not by the bare delimiter', () => {
    const sql = 'DO $body$ SELECT $$inner; text$$; $body$; SELECT 1';
    expect(texts(sql)).toEqual(['DO $body$ SELECT $$inner; text$$; $body$', 'SELECT 1']);
  });

  it('treats an unterminated dollar quote as a single trailing statement', () => {
    expect(texts('SELECT 1; DO $$ BEGIN; RETURN;')).toEqual(['SELECT 1', 'DO $$ BEGIN; RETURN;']);
  });

  it('ignores semicolons inside line comments', () => {
    expect(texts('SELECT 1 -- trailing; comment\n; SELECT 2')).toEqual([
      'SELECT 1 -- trailing; comment',
      'SELECT 2',
    ]);
  });

  it('ignores semicolons inside nested block comments', () => {
    expect(texts('SELECT 1 /* outer /* inner; */ still; */; SELECT 2')).toEqual([
      'SELECT 1 /* outer /* inner; */ still; */',
      'SELECT 2',
    ]);
  });

  it("does not split inside PostgreSQL E'...' escape strings", () => {
    const sql = "SELECT E'it\\';still text' AS value; SELECT 2;";
    expect(texts(sql)).toEqual(["SELECT E'it\\';still text' AS value", 'SELECT 2']);
  });

  it("handles lowercase e'...' and doubled quotes inside escape strings", () => {
    expect(texts("SELECT e'a\\';b', e'it''s; fine'; SELECT 2")).toEqual([
      "SELECT e'a\\';b', e'it''s; fine'",
      'SELECT 2',
    ]);
  });

  it('does not treat UE as an escape-string prefix', () => {
    // Identifier UE followed by a normal string — not an E' token.
    expect(texts("SELECT UE'tail; still' FROM t; SELECT 2")).toEqual([
      "SELECT UE'tail; still' FROM t",
      'SELECT 2',
    ]);
  });

  it('returns start/end offsets into the original buffer', () => {
    const sql = 'SELECT 1;  SELECT 2';
    const out = splitSqlStatements(sql);
    expect(out).toEqual([
      { text: 'SELECT 1', start: 0, end: 8 },
      { text: 'SELECT 2', start: 11, end: 19 },
    ]);
    for (const s of out) {
      expect(sql.slice(s.start, s.end)).toBe(s.text);
    }
  });

  it('offsets skip leading/trailing whitespace around each statement', () => {
    const sql = '\n  SELECT 1  ;\n\n SELECT 2  ';
    const out = splitSqlStatements(sql);
    expect(out.map((s) => s.text)).toEqual(['SELECT 1', 'SELECT 2']);
    for (const s of out) {
      expect(sql.slice(s.start, s.end)).toBe(s.text);
    }
  });
});

describe('statementAtOffset', () => {
  it('returns the statement containing the cursor', () => {
    const sql = 'SELECT 1;  SELECT 2';
    expect(statementAtOffset(sql, 0)?.text).toBe('SELECT 1');
    expect(statementAtOffset(sql, 7)?.text).toBe('SELECT 1');
    expect(statementAtOffset(sql, 11)?.text).toBe('SELECT 2');
    expect(statementAtOffset(sql, 18)?.text).toBe('SELECT 2');
  });

  it('picks the following statement when the cursor is in a gap', () => {
    const sql = 'SELECT 1;  SELECT 2';
    // offset 9 is the space after `;`
    expect(statementAtOffset(sql, 9)?.text).toBe('SELECT 2');
  });

  it('returns undefined for an empty buffer', () => {
    expect(statementAtOffset('   \n', 0)).toBeUndefined();
  });
});

describe('resolveRunTarget', () => {
  const buffer = 'SELECT 1;  SELECT 2;  SELECT 3';

  it('smart mode uses a non-empty selection', () => {
    const target = resolveRunTarget(buffer, 'smart', {
      cursorOffset: 0,
      selectionStart: 11,
      selectionEnd: 19,
    });
    expect(target).toEqual({ sql: 'SELECT 2', base: 11 });
  });

  it('smart mode falls back to statement under cursor', () => {
    const target = resolveRunTarget(buffer, 'smart', {
      cursorOffset: 12,
      selectionStart: 12,
      selectionEnd: 12,
    });
    expect(target).toEqual({ sql: 'SELECT 2', base: 11 });
  });

  it('buffer mode always returns the whole buffer', () => {
    const target = resolveRunTarget(buffer, 'buffer', {
      cursorOffset: 12,
      selectionStart: 11,
      selectionEnd: 19,
    });
    expect(target).toEqual({ sql: buffer, base: 0 });
  });

  it('smart mode without caret falls back to whole buffer', () => {
    expect(resolveRunTarget(buffer, 'smart', null)).toEqual({ sql: buffer, base: 0 });
  });

  it('returns null for an empty buffer', () => {
    expect(resolveRunTarget('  \n', 'buffer', null)).toBeNull();
  });
});
