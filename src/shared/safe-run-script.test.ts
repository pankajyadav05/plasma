import { describe, expect, it } from 'vitest';
import { SAFE_RUN_MAX_STATEMENTS, SafeRunFinishRequest, SafeRunUndoRequest } from './protocol';
import { firstLine, planSafeRunScript } from './safe-run-script';

const refused = (sql: string) => {
  const p = planSafeRunScript(sql);
  if (p.ok) throw new Error('expected a refusal');
  return p.message;
};

describe('planSafeRunScript', () => {
  it('leaves one statement exactly as before', () => {
    expect(planSafeRunScript('DELETE FROM t WHERE id = 1')).toEqual({
      ok: true,
      statements: ['DELETE FROM t WHERE id = 1'],
    });
    expect(planSafeRunScript('DELETE FROM t WHERE id = 1;;  ')).toMatchObject({ ok: true });
    expect(refused('SELECT 1')).toBe(
      'Safe Run is for INSERT, UPDATE, DELETE and MERGE statements. Use Run for anything else.',
    );
    expect(refused('WITH x AS (SELECT 1) SELECT * FROM x')).toMatch(
      /INSERT, UPDATE, DELETE and MERGE/,
    );
  });

  it('splits several statements with quotes, dollar quoting and comments', () => {
    const p = planSafeRunScript(
      `-- first\nINSERT INTO t VALUES ('a;b'); /* x; */ UPDATE t SET v = $$;$$ WHERE id = 1;\nWITH d AS (DELETE FROM t RETURNING *) INSERT INTO log SELECT * FROM d;`,
    );
    expect(p.ok && p.statements).toHaveLength(3);
  });

  it('drops empty statements', () => {
    const p = planSafeRunScript(
      ';; INSERT INTO t VALUES (1); ;\n-- done\n; INSERT INTO t VALUES (2);;',
    );
    expect(p.ok && p.statements).toEqual(['INSERT INTO t VALUES (1)', 'INSERT INTO t VALUES (2)']);
    expect(refused(' ; -- nothing\n')).toMatch(/nothing to run/);
  });

  it('refuses the whole script naming the first statement that does not qualify', () => {
    expect(refused('INSERT INTO t VALUES (1); SELECT 1; DELETE FROM t')).toMatch(
      /^Statement 2 is a SELECT statement\./,
    );
    expect(refused('INSERT INTO t VALUES (1); CREATE TABLE x (a int)')).toMatch(
      /^Statement 2 is a CREATE/,
    );
    expect(refused('INSERT INTO t VALUES (1); COMMIT')).toMatch(/^Statement 2 is a COMMIT/);
    expect(refused('BEGIN; DELETE FROM t')).toMatch(/^Statement 1 is a BEGIN/);
    expect(refused('DELETE FROM t; SAVEPOINT a')).toMatch(/^Statement 2 is a SAVEPOINT/);
    expect(refused('DELETE FROM t; SET search_path = x')).toMatch(/^Statement 2 is a SET/);
    expect(refused('DELETE FROM t; VACUUM t')).toMatch(/^Statement 2 is a VACUUM/);
    expect(refused('DELETE FROM t; CALL p()')).toMatch(/^Statement 2 is a CALL/);
    expect(refused('DELETE FROM t; DO $$ BEGIN PERFORM 1; END $$')).toMatch(/^Statement 2 is a DO/);
    expect(refused('DELETE FROM t; WITH x AS (SELECT 1) SELECT * FROM x')).toMatch(
      /^Statement 2 only reads/,
    );
    expect(refused('DELETE FROM t; SELECT 1')).toMatch(/Nothing was run/);
  });

  it('allows up to the limit and refuses more, with the limit in the message', () => {
    const one = (i: number) => `INSERT INTO t VALUES (${i});`;
    const at = Array.from({ length: SAFE_RUN_MAX_STATEMENTS }, (_, i) => one(i)).join('\n');
    expect(planSafeRunScript(at)).toMatchObject({ ok: true });
    const over = Array.from({ length: SAFE_RUN_MAX_STATEMENTS + 1 }, (_, i) => one(i)).join('\n');
    expect(refused(over)).toMatch(/at most 20 statements; this script has 21/);
  });
});

describe('firstLine', () => {
  it('skips blank and comment lines and truncates', () => {
    expect(firstLine('\n-- c\n  UPDATE t\nSET a = 1')).toBe('UPDATE t');
    expect(firstLine(`UPDATE ${'x'.repeat(200)}`, 20)).toHaveLength(21);
  });
});

describe('Safe Run protocol schemas', () => {
  it('finish takes commit, commitPartial and rollback only', () => {
    for (const action of ['commit', 'commitPartial', 'rollback']) {
      expect(SafeRunFinishRequest.safeParse({ runId: 'r', action }).success).toBe(true);
    }
    expect(SafeRunFinishRequest.safeParse({ runId: 'r', action: 'commit-all' }).success).toBe(
      false,
    );
  });
  it('undo needs a run id', () => {
    expect(SafeRunUndoRequest.safeParse({ runId: 'r' }).success).toBe(true);
    expect(SafeRunUndoRequest.safeParse({ runId: '' }).success).toBe(false);
    expect(SafeRunUndoRequest.safeParse({}).success).toBe(false);
  });
});
