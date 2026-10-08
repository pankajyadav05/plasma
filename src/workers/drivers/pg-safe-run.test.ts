import { SafeRunReport, WorkerRequest } from '@shared/protocol';
import { describe, expect, it } from 'vitest';
import {
  type CappedRead,
  type SafeRunDeps,
  doneSteps,
  scriptReportBody,
  startSafeRunScript,
  undoLastScriptStatement,
} from './pg-safe-run';

function fake(
  opts: { failOn?: string[]; dieAfterFailure?: boolean; status?: 'I' | 'T' | 'E' } = {},
) {
  const log: string[] = [];
  let failed = false;
  const read = (rows: number): CappedRead => ({
    columns: [],
    rows: [],
    total: rows,
    exact: true,
    commandRowCount: rows,
  });
  const deps: SafeRunDeps = {
    status: opts.status ?? 'I',
    async query(text) {
      log.push(text);
      if (failed && opts.dieAfterFailure && /^ROLLBACK TO SAVEPOINT plasma_sr_/.test(text)) {
        throw new Error('Connection terminated');
      }
      return { rows: [] };
    },
    async readCapped(sql) {
      if (opts.failOn?.some((f) => sql.includes(f))) {
        failed = true;
        throw new Error(`boom: ${sql}`);
      }
      return read(2);
    },
  };
  return { deps, log };
}

const script = (...s: string[]) => ({ runId: 'r', sql: s.join(';\n'), explain: false });

describe('startSafeRunScript', () => {
  it('opens one transaction, one savepoint per statement, and holds it open', async () => {
    const { deps, log } = fake();
    const { state, nested } = await startSafeRunScript(
      deps,
      script('INSERT INTO a VALUES (1)', 'DELETE FROM b', 'UPDATE c SET x = 1'),
    );
    expect(nested).toBe(false);
    expect(log[0]).toBe('BEGIN');
    expect(log.filter((q) => q.startsWith('SAVEPOINT plasma_sr_'))).toEqual([
      'SAVEPOINT plasma_sr_1',
      'SAVEPOINT plasma_sr_2',
      'SAVEPOINT plasma_sr_3',
    ]);
    expect(log).not.toContain('COMMIT');
    expect(log).not.toContain('ROLLBACK');
    expect(state.steps.map((s) => s.status)).toEqual(['done', 'done', 'done']);
    expect(state.failedAt).toBeNull();
  });

  it('uses the outer savepoint when the user has a transaction open', async () => {
    const { deps, log } = fake({ status: 'T' });
    const { nested } = await startSafeRunScript(deps, script('DELETE FROM a', 'DELETE FROM b'));
    expect(nested).toBe(true);
    expect(log[0]).toBe('SAVEPOINT plasma_safe_run');
    expect(log).not.toContain('BEGIN');
  });

  it('refuses an aborted transaction and a non-qualifying script before any query', async () => {
    const aborted = fake({ status: 'E' });
    await expect(
      startSafeRunScript(aborted.deps, script('DELETE FROM a', 'DELETE FROM b')),
    ).rejects.toThrow(/aborted/);
    expect(aborted.log).toEqual([]);

    const bad = fake();
    await expect(startSafeRunScript(bad.deps, script('DELETE FROM a', 'SELECT 1'))).rejects.toThrow(
      /Statement 2 is a SELECT/,
    );
    expect(bad.log).toEqual([]);
  });

  it('a failing statement rolls back to its own savepoint, stops, and keeps the earlier ones', async () => {
    const { deps, log } = fake({ failOn: ['UPDATE c'] });
    const { state } = await startSafeRunScript(
      deps,
      script('INSERT INTO a VALUES (1)', 'UPDATE c SET x = 1', 'DELETE FROM d'),
    );
    expect(state.failedAt).toBe(2);
    expect(state.steps.map((s) => s.status)).toEqual(['done', 'failed', 'notRun']);
    expect(state.steps[1]!.error).toMatch(/boom/);
    expect(log).toContain('ROLLBACK TO SAVEPOINT plasma_sr_2');
    expect(log).not.toContain('SAVEPOINT plasma_sr_3');
    expect(log).not.toContain('ROLLBACK');
    expect(log).not.toContain('COMMIT');
    expect(doneSteps(state)).toHaveLength(1);
  });

  it('statement 1 failing ends the run and throws', async () => {
    const { deps, log } = fake({ failOn: ['INSERT INTO a'] });
    await expect(
      startSafeRunScript(deps, script('INSERT INTO a VALUES (1)', 'DELETE FROM d')),
    ).rejects.toThrow(/Statement 1 failed: boom/);
    expect(log.at(-1)).toBe('ROLLBACK');
  });

  it('a dead connection while undoing a failure throws the original error and rolls back', async () => {
    const { deps, log } = fake({ failOn: ['DELETE FROM d'], dieAfterFailure: true });
    await expect(
      startSafeRunScript(deps, script('INSERT INTO a VALUES (1)', 'DELETE FROM d')),
    ).rejects.toThrow(/boom/);
    expect(log.at(-1)).toBe('ROLLBACK');
  });

  it('caps rows across the run: later statements get what is left', async () => {
    const caps: number[] = [];
    const deps: SafeRunDeps = {
      status: 'I',
      async query() {
        return { rows: [] };
      },
      async readCapped(_sql, cap) {
        caps.push(cap);
        const rows = Array.from({ length: Math.min(cap, 900) }, (_, i) => [i]);
        return {
          columns: [{ name: 'id', dataTypeID: 23, dataTypeName: 'int4' }],
          rows,
          total: 900,
          exact: true,
          commandRowCount: 900,
        };
      },
    };
    const { state } = await startSafeRunScript(
      deps,
      script(...Array.from({ length: 6 }, (_, i) => `INSERT INTO t${i} VALUES (1)`)),
    );
    expect(caps).toEqual([500, 500, 500, 500, 0, 0]);
    expect(state.steps.map((s) => s.after.length)).toEqual([500, 500, 500, 500, 0, 0]);
    expect(state.steps.every((s) => s.afterTruncated)).toBe(true);
  });
});

describe('undoLastScriptStatement and the report', () => {
  it('rolls back to the last statement that ran and drops it', async () => {
    const { deps, log } = fake({ failOn: ['DELETE FROM d'] });
    const { state } = await startSafeRunScript(
      deps,
      script(
        'INSERT INTO a VALUES (1)',
        'INSERT INTO b VALUES (1)',
        'DELETE FROM d',
        'DELETE FROM e',
      ),
    );
    expect(state.failedAt).toBe(3);
    log.length = 0;
    await undoLastScriptStatement(deps, state);
    expect(log).toEqual(['ROLLBACK TO SAVEPOINT plasma_sr_2', 'RELEASE SAVEPOINT plasma_sr_2']);
    expect(state.steps.map((s) => `${s.index}:${s.status}`)).toEqual([
      '1:done',
      '3:failed',
      '4:notRun',
    ]);
  });

  it('aggregates totals over the statements that ran', async () => {
    const { deps } = fake({ failOn: ['DELETE FROM d'] });
    const { state } = await startSafeRunScript(
      deps,
      script('INSERT INTO a VALUES (1)', 'INSERT INTO b VALUES (1)', 'DELETE FROM d'),
    );
    const body = scriptReportBody('r', false, state);
    expect(body.affected).toBe(4);
    expect(body.failedAt).toBe(3);
    expect(body.steps).toHaveLength(3);
    expect(body.statement).toContain('DELETE FROM d');
    state.steps[0]!.affectedExact = false;
    expect(scriptReportBody('r', false, state).affectedExact).toBe(false);
    // It is a valid report on the wire.
    expect(
      SafeRunReport.safeParse({ ...body, expiresAt: 1, timeoutSec: 5, txnState: 'active' }).success,
    ).toBe(true);
  });
});

describe('worker protocol', () => {
  it('accepts safeRunUndoLast and commitPartial', () => {
    expect(WorkerRequest.safeParse({ kind: 'safeRunUndoLast', id: '1', runId: 'r' }).success).toBe(
      true,
    );
    expect(WorkerRequest.safeParse({ kind: 'safeRunUndoLast', id: '1', runId: '' }).success).toBe(
      false,
    );
    expect(
      WorkerRequest.safeParse({
        kind: 'safeRunFinish',
        id: '1',
        runId: 'r',
        action: 'commitPartial',
      }).success,
    ).toBe(true);
  });
});
