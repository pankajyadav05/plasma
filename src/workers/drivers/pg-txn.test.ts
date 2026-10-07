import { describe, expect, it } from 'vitest';
import {
  type SimpleClient,
  buildExplainSql,
  isDuplicateKeyError,
  runEditBatch,
  runExplain,
  txnStateFromStatus,
} from './pg-txn';

/** Fake client: records every statement, answers with scripted rowCounts / errors. */
function fakeClient(
  answers: Record<string, number | Error> = {},
): SimpleClient & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    async query(config) {
      const text = typeof config === 'string' ? config : config.text;
      log.push(text);
      const answer = answers[text];
      if (answer instanceof Error) throw answer;
      return { rowCount: answer ?? 1 };
    },
  };
}

describe('txnStateFromStatus', () => {
  it('maps ReadyForQuery I/T/E to none/active/error', () => {
    expect(txnStateFromStatus('I')).toBe('none');
    expect(txnStateFromStatus('T')).toBe('active');
    expect(txnStateFromStatus('E')).toBe('error');
  });
});

describe('runEditBatch', () => {
  const updates = [
    { sql: 'UPDATE a SET x = $1 WHERE id = $2', params: ['1', '10'], label: 'public.a id=10 → x' },
    { sql: 'UPDATE a SET y = $1 WHERE id = $2', params: [null, '11'], label: 'public.a id=11 → y' },
  ];

  it('wraps an idle session in BEGIN/COMMIT', async () => {
    const client = fakeClient();
    await expect(runEditBatch(client, 'I', updates)).resolves.toEqual({
      applied: 2,
      conflicts: [],
    });
    expect(client.log).toEqual(['BEGIN', updates[0]!.sql, updates[1]!.sql, 'COMMIT']);
  });

  it('uses a savepoint inside the user transaction and never commits it', async () => {
    const client = fakeClient();
    await runEditBatch(client, 'T', updates);
    expect(client.log).toEqual([
      'SAVEPOINT plasma_edit_batch',
      updates[0]!.sql,
      updates[1]!.sql,
      'RELEASE SAVEPOINT plasma_edit_batch',
    ]);
    expect(client.log).not.toContain('COMMIT');
    expect(client.log).not.toContain('BEGIN');
  });

  it('refuses to run inside an aborted transaction', async () => {
    const client = fakeClient();
    await expect(runEditBatch(client, 'E', updates)).rejects.toThrow(/aborted/);
    expect(client.log).toEqual([]);
  });

  it('rolls back and reports a conflict when an UPDATE matches no row', async () => {
    const client = fakeClient({ [updates[1]!.sql]: 0 });
    await expect(runEditBatch(client, 'I', updates)).resolves.toEqual({
      applied: 0,
      conflicts: [{ index: 1, reason: 'no-match' }],
    });
    expect(client.log.at(-1)).toBe('ROLLBACK');
    expect(client.log).not.toContain('COMMIT');
  });

  it('runs every statement so all conflicting rows are reported, then rolls back once', async () => {
    const client = fakeClient({ [updates[0]!.sql]: 0, [updates[1]!.sql]: 0 });
    const out = await runEditBatch(client, 'T', updates);
    expect(out.conflicts.map((c) => c.index)).toEqual([0, 1]);
    expect(client.log.slice(-2)).toEqual([
      'ROLLBACK TO SAVEPOINT plasma_edit_batch',
      'RELEASE SAVEPOINT plasma_edit_batch',
    ]);
    expect(client.log.filter((l) => l.startsWith('RELEASE'))).toHaveLength(1);
  });

  it('never commits a batch that has a conflict, wherever it is', async () => {
    const three = [...updates, { sql: 'DELETE FROM a WHERE id = $1', params: ['5'] }];
    const client = fakeClient({ [updates[0]!.sql]: 0 });
    const out = await runEditBatch(client, 'I', three);
    expect(out.applied).toBe(0);
    expect(client.log).not.toContain('COMMIT');
  });

  it('reports an INSERT that hits an existing key as a duplicate and stops there', async () => {
    const dup = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
    });
    const batch = [
      updates[0]!,
      { sql: 'INSERT INTO a (id) VALUES ($1)', params: ['1'], kind: 'insert' as const },
      updates[1]!,
    ];
    const client = fakeClient({ [batch[1]!.sql]: dup });
    const out = await runEditBatch(client, 'I', batch);
    expect(out).toEqual({ applied: 0, conflicts: [{ index: 1, reason: 'duplicate' }] });
    expect(client.log).toEqual(['BEGIN', batch[0]!.sql, batch[1]!.sql, 'ROLLBACK']);
  });

  it('a unique violation of an UPDATE is an error, not a conflict', async () => {
    const dup = Object.assign(new Error('duplicate key value'), { code: '23505' });
    const client = fakeClient({ [updates[0]!.sql]: dup });
    await expect(runEditBatch(client, 'I', updates)).rejects.toThrow(/Edit 1 of 2.*failed/);
  });

  it('rolls back when an UPDATE matches more than one row', async () => {
    const client = fakeClient({ [updates[0]!.sql]: 3 });
    await expect(runEditBatch(client, 'I', updates)).rejects.toThrow(/Edit 1 of 2.*matched 3 rows/);
    expect(client.log).toEqual(['BEGIN', updates[0]!.sql, 'ROLLBACK']);
  });

  it('reports the Postgres error for the failing edit and rolls back to the savepoint', async () => {
    const pgErr = Object.assign(new Error('invalid input syntax for type integer: "abc"'), {
      detail: 'bad value',
    });
    const client = fakeClient({ [updates[0]!.sql]: pgErr });
    await expect(runEditBatch(client, 'T', updates)).rejects.toThrow(
      /Edit 1 of 2 \(public\.a id=10 → x\) failed: invalid input syntax.*bad value/,
    );
    expect(client.log.slice(-2)).toEqual([
      'ROLLBACK TO SAVEPOINT plasma_edit_batch',
      'RELEASE SAVEPOINT plasma_edit_batch',
    ]);
  });
});

describe('isDuplicateKeyError', () => {
  it('recognises each engine’s unique violation', () => {
    expect(isDuplicateKeyError({ code: '23505' })).toBe(true);
    expect(isDuplicateKeyError({ code: 'ER_DUP_ENTRY' })).toBe(true);
    expect(isDuplicateKeyError({ errno: 1062 })).toBe(true);
    expect(isDuplicateKeyError({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' })).toBe(true);
    expect(isDuplicateKeyError(new Error('UNIQUE constraint failed: users.id'))).toBe(true);
    expect(isDuplicateKeyError({ code: '23503' })).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
  });
});

describe('explain', () => {
  it('plain EXPLAIN does not ANALYZE and runs without a transaction', async () => {
    const client = fakeClient();
    const ran: string[] = [];
    await runExplain(client, 'I', 'DELETE FROM t;', false, async (text) => {
      ran.push(text);
    });
    expect(ran).toEqual(['EXPLAIN (VERBOSE, FORMAT JSON) DELETE FROM t']);
    expect(client.log).toEqual([]);
  });

  it('ANALYZE always runs inside BEGIN … ROLLBACK', async () => {
    const client = fakeClient();
    await runExplain(client, 'I', 'DELETE FROM t', true, async (text) => {
      client.log.push(text);
    });
    expect(client.log).toEqual([
      'BEGIN',
      'EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) DELETE FROM t',
      'ROLLBACK',
    ]);
  });

  it('ANALYZE inside a user transaction uses a savepoint and still rolls back on error', async () => {
    const client = fakeClient();
    await expect(
      runExplain(client, 'T', 'UPDATE t SET x = 1', true, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(client.log).toEqual([
      'SAVEPOINT plasma_explain',
      'ROLLBACK TO SAVEPOINT plasma_explain',
      'RELEASE SAVEPOINT plasma_explain',
    ]);
  });

  it('refuses ANALYZE in an aborted transaction and multi-statement input', async () => {
    const client = fakeClient();
    await expect(runExplain(client, 'E', 'SELECT 1', true, async () => 1)).rejects.toThrow(
      /aborted/,
    );
    expect(() => buildExplainSql('SELECT 1; DELETE FROM t', false)).toThrow(/exactly one/);
  });
});
