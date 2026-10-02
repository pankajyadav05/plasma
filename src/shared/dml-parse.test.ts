import { describe, expect, it } from 'vitest';
import { buildBeforeSelect, parseDml, targetRef, withReturning } from './dml-parse';

describe('parseDml: UPDATE', () => {
  it('reads target, where and no returning', () => {
    const p = parseDml("UPDATE users SET name = 'x' WHERE id = 5;");
    expect(p.kind).toBe('update');
    expect(p.target).toEqual({ table: 'users', sql: 'users' });
    expect(p.where).toBe('id = 5');
    expect(p.hasReturning).toBe(false);
    expect(p.beforeSnapshot).toBe(true);
    expect(p.multiTable).toBe(false);
  });

  it('handles schema, quoted names, ONLY, star and alias', () => {
    const p = parseDml('update only "My Schema"."Odd ""T""" * as u set a = 1 where u.a > 0');
    expect(p.target).toEqual({
      schema: '"My Schema"',
      table: '"Odd ""T"""',
      sql: '"My Schema"."Odd ""T"""',
    });
    expect(p.only).toBe(true);
    expect(p.alias).toBe('u');
    expect(p.where).toBe('u.a > 0');
  });

  it('reads an alias without AS', () => {
    const p = parseDml('UPDATE public.t x SET a = 1 WHERE x.id = 1');
    expect(p.alias).toBe('x');
    expect(targetRef(p)).toBe('x');
  });

  it('keeps the whole where, including subqueries, strings with keywords and comments', () => {
    const p = parseDml(
      "UPDATE t SET a = 1 -- note\nWHERE id IN (SELECT id FROM o WHERE x = 'returning where') /* c */ AND b = $$returning$$",
    );
    expect(p.where).toBe(
      "id IN (SELECT id FROM o WHERE x = 'returning where') /* c */ AND b = $$returning$$",
    );
    expect(p.hasReturning).toBe(false);
    expect(p.beforeSnapshot).toBe(true);
  });

  it('stops the where at a top-level RETURNING', () => {
    const p = parseDml('UPDATE t SET a = 1 WHERE id = 1 RETURNING id, a');
    expect(p.where).toBe('id = 1');
    expect(p.hasReturning).toBe(true);
  });

  it('has no where when the statement has none', () => {
    const p = parseDml('UPDATE t SET a = 1');
    expect(p.where).toBeUndefined();
    expect(p.beforeSnapshot).toBe(true);
    expect(buildBeforeSelect(p)).toBe('SELECT t.* FROM t FOR UPDATE');
  });

  it('is not fooled by FROM inside SET functions or IS DISTINCT FROM', () => {
    const a = parseDml('UPDATE t SET y = extract(year from d) WHERE a IS DISTINCT FROM b');
    expect(a.multiTable).toBe(false);
    expect(a.beforeSnapshot).toBe(true);
    const b = parseDml('UPDATE t SET (a, b) = (SELECT 1, 2 FROM x) WHERE id = 1');
    expect(b.multiTable).toBe(false);
  });

  it('rejects UPDATE … FROM (multi-table) for the before snapshot', () => {
    const p = parseDml('UPDATE t SET a = o.a FROM other o WHERE o.id = t.id');
    expect(p.multiTable).toBe(true);
    expect(p.beforeSnapshot).toBe(false);
    expect(p.reason).toMatch(/FROM/);
    expect(p.where).toBe('o.id = t.id');
    expect(buildBeforeSelect(p)).toBeNull();
  });

  it('rejects WHERE CURRENT OF', () => {
    const p = parseDml('UPDATE t SET a = 1 WHERE CURRENT OF c');
    expect(p.beforeSnapshot).toBe(false);
    expect(p.reason).toMatch(/CURRENT OF/);
  });
});

describe('parseDml: DELETE', () => {
  it('reads a plain delete', () => {
    const p = parseDml('DELETE FROM public.orders WHERE status = $$old$$');
    expect(p.kind).toBe('delete');
    expect(p.target?.schema).toBe('public');
    expect(p.target?.table).toBe('orders');
    expect(p.where).toBe('status = $$old$$');
    expect(p.beforeSnapshot).toBe(true);
  });

  it('reads alias and rejects USING', () => {
    expect(parseDml('DELETE FROM t AS x WHERE x.a = 1').alias).toBe('x');
    const p = parseDml('DELETE FROM t USING u WHERE t.id = u.id');
    expect(p.multiTable).toBe(true);
    expect(p.beforeSnapshot).toBe(false);
  });

  it('does not take USING for an alias', () => {
    const p = parseDml('DELETE FROM t USING u WHERE t.id = u.id');
    expect(p.alias).toBeUndefined();
  });

  it('detects RETURNING', () => {
    expect(parseDml('DELETE FROM t WHERE a = 1 RETURNING *').hasReturning).toBe(true);
  });
});

describe('parseDml: INSERT and MERGE', () => {
  it('reads INSERT target and alias, with or without columns', () => {
    const a = parseDml("INSERT INTO s.t (a, b) VALUES (1, 'x')");
    expect(a.kind).toBe('insert');
    expect(a.target?.sql).toBe('s.t');
    expect(a.alias).toBeUndefined();
    expect(a.beforeSnapshot).toBe(false);
    const b = parseDml('INSERT INTO t AS x VALUES (1) ON CONFLICT (id) DO UPDATE SET a = x.a + 1');
    expect(b.alias).toBe('x');
    expect(parseDml('INSERT INTO t VALUES (1)').alias).toBeUndefined();
    expect(parseDml('INSERT INTO t DEFAULT VALUES').alias).toBeUndefined();
    expect(parseDml('INSERT INTO t SELECT * FROM u').alias).toBeUndefined();
  });

  it('detects INSERT … RETURNING but not RETURNING in a string', () => {
    expect(parseDml('INSERT INTO t VALUES (1) RETURNING id').hasReturning).toBe(true);
    expect(parseDml("INSERT INTO t VALUES ('returning')").hasReturning).toBe(false);
  });

  it('reads MERGE as multi-table', () => {
    const p = parseDml(
      'MERGE INTO tgt t USING src s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = s.a',
    );
    expect(p.kind).toBe('merge');
    expect(p.target?.sql).toBe('tgt');
    expect(p.alias).toBe('t');
    expect(p.multiTable).toBe(true);
    expect(p.beforeSnapshot).toBe(false);
  });
});

describe('parseDml: refusals', () => {
  it('flags a leading WITH as cte with no target', () => {
    const p = parseDml('WITH x AS (SELECT 1) UPDATE t SET a = 1');
    expect(p.kind).toBe('cte');
    expect(p.target).toBeUndefined();
    expect(p.beforeSnapshot).toBe(false);
  });

  it('refuses several statements, empty input, SELECTs and DDL', () => {
    expect(parseDml('UPDATE t SET a = 1; DELETE FROM t').reason).toMatch(/more than one/);
    expect(parseDml('   ').kind).toBe('other');
    expect(parseDml('SELECT 1').kind).toBe('other');
    expect(parseDml('DROP TABLE t').kind).toBe('other');
  });

  it('refuses unterminated quotes and unbalanced parens', () => {
    expect(parseDml("UPDATE t SET a = 'x WHERE id = 1").beforeSnapshot).toBe(false);
    expect(parseDml('UPDATE t SET a = (1 WHERE id = 1').beforeSnapshot).toBe(false);
  });

  it('refuses a cross-database name and a missing SET', () => {
    expect(parseDml('UPDATE db.s.t SET a = 1').beforeSnapshot).toBe(false);
    expect(parseDml('UPDATE t WHERE a = 1').beforeSnapshot).toBe(false);
  });

  it('ignores leading comments', () => {
    const p = parseDml('-- fix\n/* x */ UPDATE t SET a = 1 WHERE id = 2');
    expect(p.kind).toBe('update');
    expect(p.where).toBe('id = 2');
  });
});

describe('buildBeforeSelect', () => {
  it('rebuilds the target, alias, ONLY and where', () => {
    const p = parseDml('UPDATE ONLY s.t AS x SET a = 1 WHERE x.id > 3 RETURNING id');
    expect(buildBeforeSelect(p)).toBe('SELECT x.* FROM ONLY s.t AS x WHERE x.id > 3 FOR UPDATE');
  });

  it('adds ctid on request', () => {
    const p = parseDml('DELETE FROM t WHERE a = 1');
    expect(buildBeforeSelect(p, { ctid: true })).toBe(
      'SELECT t.ctid AS "__plasma_ctid", t.* FROM t WHERE a = 1 FOR UPDATE',
    );
  });

  it('is null for INSERT, MERGE and CTE', () => {
    expect(buildBeforeSelect(parseDml('INSERT INTO t VALUES (1)'))).toBeNull();
    expect(buildBeforeSelect(parseDml('WITH a AS (SELECT 1) DELETE FROM t'))).toBeNull();
  });
});

describe('withReturning', () => {
  it('appends RETURNING * to single-table statements', () => {
    expect(withReturning(parseDml('UPDATE t SET a = 1 WHERE id = 1;'))).toBe(
      'UPDATE t SET a = 1 WHERE id = 1 RETURNING *',
    );
    expect(withReturning(parseDml('INSERT INTO t VALUES (1)'), { ctid: true })).toBe(
      'INSERT INTO t VALUES (1) RETURNING *, ctid AS "__plasma_ctid"',
    );
  });

  it('qualifies the target for joined forms', () => {
    expect(withReturning(parseDml('DELETE FROM t USING u WHERE t.id = u.id'), { ctid: true })).toBe(
      'DELETE FROM t USING u WHERE t.id = u.id RETURNING t.*, t.ctid AS "__plasma_ctid"',
    );
  });

  it('leaves a statement with its own RETURNING, and CTEs, alone', () => {
    expect(withReturning(parseDml('DELETE FROM t RETURNING id'))).toBeNull();
    expect(withReturning(parseDml('WITH a AS (SELECT 1) DELETE FROM t'))).toBeNull();
  });

  it('allows MERGE only from PG 17', () => {
    const p = parseDml('MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE');
    expect(withReturning(p, { serverVersionNum: 160002 })).toBeNull();
    expect(withReturning(p, { serverVersionNum: 170000 })).toBe(
      'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE RETURNING t.*',
    );
  });
});
