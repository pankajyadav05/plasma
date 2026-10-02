import type { ConnectionConfig, SafeRunReport } from '@shared/protocol';
import { buildSafeRunDiff } from '@shared/safe-run-diff';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDriver } from './postgres';

/**
 * Safe Run opt-in live checks (dry run for writes):
 *
 *   PLASMA_LIVE_PG=postgres://postgres@127.0.0.1:5501/postgres pnpm vitest run \
 *     src/workers/drivers/postgres.safe-run.live.test.ts
 */
const url = process.env.PLASMA_LIVE_PG;
const suite = url ? describe : describe.skip;

function configFrom(raw: string, readOnly: boolean): ConnectionConfig {
  const u = new URL(raw);
  return {
    id: 'live-safe-run',
    name: 'live-safe-run',
    engine: 'postgres',
    host: u.hostname,
    port: Number(u.port || 5432),
    database: u.pathname.slice(1) || 'postgres',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl: false,
    readOnly,
  } as ConnectionConfig;
}

suite('postgres driver (live): Safe Run', () => {
  const d = new PostgresDriver();
  const observer = new PostgresDriver();
  let n = 0;
  const run = (
    sql: string,
    opts?: { timeoutSec?: number; explain?: boolean },
  ): Promise<SafeRunReport> =>
    d.safeRunStart(`run-${++n}`, sql, {
      connectionGen: 1,
      timeoutSec: opts?.timeoutSec ?? 60,
      explain: opts?.explain ?? true,
    });
  const seen = async (sql: string) => (await observer.query(sql)).rows;

  beforeAll(async () => {
    await d.connect(configFrom(url as string, false), 0);
    d.setConnectionGen(1);
    await observer.connect(configFrom(url as string, false), 0);
    observer.setConnectionGen(1);
    await d.query('DROP TABLE IF EXISTS sr_pk, sr_nopk, sr_uq, sr_child CASCADE');
    await d.query('CREATE TABLE sr_pk (id int PRIMARY KEY, name text, qty int)');
    await d.query("INSERT INTO sr_pk VALUES (1,'a',10),(2,'b',20),(3,'c',30)");
    await d.query('CREATE TABLE sr_nopk (name text, qty int)');
    await d.query("INSERT INTO sr_nopk VALUES ('x',1),('y',2),('z',3)");
    await d.query('CREATE TABLE sr_uq (code text NOT NULL UNIQUE, v int)');
    await d.query("INSERT INTO sr_uq VALUES ('k1',1),('k2',2)");
  });

  afterAll(async () => {
    await d.query('DROP TABLE IF EXISTS sr_pk, sr_nopk, sr_uq, sr_child CASCADE');
    await d.disconnect();
    await observer.disconnect();
  });

  it('UPDATE: captures before/after by PK, holds the write, then commits', async () => {
    const rep = await run('UPDATE sr_pk SET name = upper(name), qty = qty + 1 WHERE id <= 2');
    expect(rep.kind).toBe('update');
    expect(rep.nested).toBe(false);
    expect(rep.affected).toBe(2);
    expect(rep.mode).toBe('diff');
    expect(rep.keyKind).toBe('pk');
    expect(rep.keyColumns).toEqual(['id']);
    expect(rep.estimateRows).toBeGreaterThan(0);
    expect(rep.before).toHaveLength(2);
    expect(rep.after).toHaveLength(2);
    expect(rep.expiresAt).toBeGreaterThan(Date.now());
    expect(d.getTxnState()).toBe('active');

    const diff = buildSafeRunDiff(rep);
    expect(diff.pairing).toBe('key');
    expect(diff.rows.filter((r) => r.status === 'changed')).toHaveLength(2);
    const nameIx = diff.columns.findIndex((c) => c.name === 'name');
    const row = diff.rows.find((r) => r.before?.[0] === 1)!;
    expect(row.before?.[nameIx]).toBe('a');
    expect(row.after?.[nameIx]).toBe('A');
    expect(row.changed[nameIx]).toBe(true);

    // Nothing is visible to other sessions until Commit.
    expect(await seen('SELECT name FROM sr_pk WHERE id = 1')).toEqual([['a']]);
    // And the primary refuses everything else, with a clear message.
    await expect(d.query('SELECT 1')).rejects.toThrow(/Safe Run is waiting/);
    await expect(d.beginTransaction()).rejects.toThrow(/Safe Run is waiting/);
    await expect(run('DELETE FROM sr_pk')).rejects.toThrow(/Safe Run is waiting/);

    const out = await d.safeRunFinish(rep.runId, 'commit');
    expect(out).toMatchObject({ outcome: 'committed', txnState: 'none' });
    expect(await seen('SELECT name, qty FROM sr_pk WHERE id <= 2 ORDER BY id')).toEqual([
      ['A', 11],
      ['B', 21],
    ]);
    await expect(d.query('SELECT 1')).resolves.toBeTruthy();
  });

  it('DELETE: shows the rows going away, then rolls back', async () => {
    const rep = await run('DELETE FROM sr_pk WHERE id >= 2');
    expect(rep.kind).toBe('delete');
    expect(rep.affected).toBe(2);
    expect(rep.before).toHaveLength(2);
    const diff = buildSafeRunDiff(rep);
    expect(diff.rows.map((r) => r.status)).toEqual(['deleted', 'deleted']);
    const out = await d.safeRunFinish(rep.runId, 'rollback');
    expect(out).toMatchObject({ outcome: 'rolledBack', reason: 'user', txnState: 'none' });
    expect(await seen('SELECT count(*)::int FROM sr_pk')).toEqual([[3]]);
  });

  it('INSERT returns the new rows; a failing statement leaves nothing pending', async () => {
    const rep = await run("INSERT INTO sr_pk VALUES (10,'n',1),(11,'m',2)");
    expect(rep.kind).toBe('insert');
    expect(rep.affected).toBe(2);
    expect(rep.mode).toBe('after-only');
    expect(buildSafeRunDiff(rep).rows.map((r) => r.status)).toEqual(['inserted', 'inserted']);
    await d.safeRunFinish(rep.runId, 'rollback');

    await expect(run("INSERT INTO sr_pk VALUES (1,'dup',1)")).rejects.toThrow(/duplicate key/);
    expect(d.getTxnState()).toBe('none');
    await expect(d.query('SELECT 1')).resolves.toBeTruthy();
    expect(await seen('SELECT count(*)::int FROM sr_pk')).toEqual([[3]]);
  });

  it('inside a user transaction it uses a savepoint and leaves the transaction open', async () => {
    await d.beginTransaction();
    await d.query("INSERT INTO sr_pk VALUES (20,'mine',5)");
    const rep = await run('UPDATE sr_pk SET qty = 0 WHERE id = 20');
    expect(rep.nested).toBe(true);
    expect(rep.affected).toBe(1);
    expect(d.getTxnState()).toBe('active');

    const out = await d.safeRunFinish(rep.runId, 'rollback');
    expect(out.txnState).toBe('active');
    expect((await d.query('SELECT qty FROM sr_pk WHERE id = 20')).rows).toEqual([[5]]);

    const rep2 = await run('UPDATE sr_pk SET qty = 7 WHERE id = 20');
    expect(rep2.nested).toBe(true);
    const out2 = await d.safeRunFinish(rep2.runId, 'commit');
    // "Commit" releases the savepoint only; the user's transaction is still theirs.
    expect(out2).toMatchObject({ outcome: 'committed', txnState: 'active' });
    expect(await seen('SELECT count(*)::int FROM sr_pk WHERE id = 20')).toEqual([[0]]);
    await d.rollbackTransaction();
    expect(await seen('SELECT count(*)::int FROM sr_pk WHERE id = 20')).toEqual([[0]]);
  });

  it('an error inside a user transaction rolls back to the savepoint only', async () => {
    await d.beginTransaction();
    await d.query("INSERT INTO sr_pk VALUES (21,'keep',1)");
    await expect(run("INSERT INTO sr_pk VALUES (1,'dup',1)")).rejects.toThrow(/duplicate key/);
    expect(d.getTxnState()).toBe('active');
    expect((await d.query('SELECT count(*)::int FROM sr_pk WHERE id = 21')).rows).toEqual([[1]]);
    await d.rollbackTransaction();
  });

  it('rolls back by itself after the timeout and says so', async () => {
    const rep = await run('UPDATE sr_pk SET qty = 999 WHERE id = 1', { timeoutSec: 0.3 });
    expect(d.getTxnState()).toBe('active');
    await new Promise((r) => setTimeout(r, 800));
    expect(d.getTxnState()).toBe('none');
    expect(await seen('SELECT qty FROM sr_pk WHERE id = 1')).toEqual([[11]]);
    await expect(d.query('SELECT 1')).resolves.toBeTruthy();
    const out = await d.safeRunFinish(rep.runId, 'commit');
    expect(out).toMatchObject({ outcome: 'rolledBack', reason: 'timeout' });
    await expect(d.safeRunFinish('nope', 'commit')).rejects.toThrow(/No Safe Run is pending/);
  });

  it('the timeout inside a user transaction rolls back to the savepoint', async () => {
    await d.beginTransaction();
    await run('UPDATE sr_pk SET qty = 5 WHERE id = 3', { timeoutSec: 0.3 });
    await new Promise((r) => setTimeout(r, 800));
    expect(d.getTxnState()).toBe('active');
    expect((await d.query('SELECT qty FROM sr_pk WHERE id = 3')).rows).toEqual([[30]]);
    await d.rollbackTransaction();
  });

  it('matches a PK-less table by ctid order', async () => {
    const rep = await run("UPDATE sr_nopk SET qty = qty * 10 WHERE name <> 'z'");
    expect(rep.keyKind).toBe('ctid');
    expect(rep.beforeCtids).toHaveLength(2);
    expect(rep.afterCtids).toHaveLength(2);
    const diff = buildSafeRunDiff(rep);
    expect(diff.pairing).toBe('ctid-order');
    expect(diff.rows.every((r) => r.status === 'changed')).toBe(true);
    const nameIx = diff.columns.findIndex((c) => c.name === 'name');
    const qtyIx = diff.columns.findIndex((c) => c.name === 'qty');
    for (const r of diff.rows) {
      expect(r.after?.[nameIx]).toBe(r.before?.[nameIx]);
      expect(r.after?.[qtyIx]).toBe((r.before?.[qtyIx] as number) * 10);
    }
    // The ctid helper columns never leak into the visible columns.
    expect(rep.beforeColumns.map((c) => c.name)).toEqual(['name', 'qty']);
    expect(rep.afterColumns.map((c) => c.name)).toEqual(['name', 'qty']);
    await d.safeRunFinish(rep.runId, 'rollback');
  });

  it('uses a NOT NULL unique index when there is no primary key', async () => {
    const rep = await run('UPDATE sr_uq SET v = v + 1');
    expect(rep.keyKind).toBe('unique');
    expect(rep.keyColumns).toEqual(['code']);
    expect(buildSafeRunDiff(rep).pairing).toBe('key');
    await d.safeRunFinish(rep.runId, 'rollback');
  });

  it('falls back to after-only for UPDATE ... FROM and CTE forms', async () => {
    const rep = await run(
      'UPDATE sr_pk t SET qty = o.qty FROM sr_uq o2, (SELECT 1 AS qty) o WHERE t.id = 1 AND o2.v = 1',
    );
    expect(rep.mode).toBe('after-only');
    expect(rep.note).toMatch(/FROM/);
    expect(rep.affected).toBe(1);
    // RETURNING was limited to the target's columns.
    expect(rep.afterColumns.map((c) => c.name)).toEqual(['id', 'name', 'qty']);
    await d.safeRunFinish(rep.runId, 'rollback');

    const cte = await run('WITH x AS (SELECT 1) UPDATE sr_pk SET qty = qty WHERE id = 1');
    expect(cte.kind).toBe('cte');
    expect(cte.mode).toBe('after-only');
    expect(cte.affected).toBe(1);
    await d.safeRunFinish(cte.runId, 'rollback');
  });

  it('keeps a statement that already has RETURNING', async () => {
    const rep = await run('DELETE FROM sr_pk WHERE id = 1 RETURNING id');
    expect(rep.afterColumns.map((c) => c.name)).toEqual(['id']);
    expect(rep.affected).toBe(1);
    expect(rep.before).toHaveLength(1);
    await d.safeRunFinish(rep.runId, 'rollback');
  });

  it('caps the rows it returns but counts them all', async () => {
    await d.query('CREATE TABLE sr_child (id int PRIMARY KEY, v int)');
    await d.query('INSERT INTO sr_child SELECT g, 0 FROM generate_series(1, 1200) g');
    const rep = await run('UPDATE sr_child SET v = 1');
    expect(rep.affected).toBe(1200);
    expect(rep.affectedExact).toBe(true);
    expect(rep.before).toHaveLength(500);
    expect(rep.after).toHaveLength(500);
    expect(rep.beforeTotal).toBe(1200);
    expect(rep.afterTotal).toBe(1200);
    await d.safeRunFinish(rep.runId, 'rollback');
  });

  it('refuses anything that is not a single write', async () => {
    await expect(run('SELECT 1')).rejects.toThrow(/INSERT, UPDATE, DELETE or MERGE/);
    await expect(run('DELETE FROM sr_pk; DELETE FROM sr_uq')).rejects.toThrow(/exactly one/);
    await expect(run('WITH x AS (SELECT 1) SELECT * FROM x')).rejects.toThrow(/only reads/);
    expect(d.getTxnState()).toBe('none');
  });

  it('refuses a stale connection generation', async () => {
    await expect(
      d.safeRunStart('stale', 'DELETE FROM sr_pk', {
        connectionGen: 99,
        timeoutSec: 60,
        explain: false,
      }),
    ).rejects.toThrow(/generation mismatch/);
    await expect(d.query('SELECT 1')).resolves.toBeTruthy();
  });

  it('drops the pending run when the connection goes away', async () => {
    const other = new PostgresDriver();
    await other.connect(configFrom(url as string, false), 0);
    other.setConnectionGen(1);
    const rep = await other.safeRunStart('gone', 'UPDATE sr_pk SET qty = 0 WHERE id = 1', {
      connectionGen: 1,
      timeoutSec: 60,
      explain: false,
    });
    expect(rep.affected).toBe(1);
    await other.disconnect();
    expect(await seen('SELECT qty FROM sr_pk WHERE id = 1')).toEqual([[11]]);
    await other.connect(configFrom(url as string, false), 0);
    await expect(other.safeRunFinish('gone', 'commit')).resolves.toMatchObject({
      outcome: 'rolledBack',
      reason: 'disconnect',
    });
    await other.disconnect();
  });

  it('is refused on a read-only connection', async () => {
    const ro = new PostgresDriver();
    await ro.connect(configFrom(url as string, true), 0);
    ro.setConnectionGen(1);
    await expect(
      ro.safeRunStart('ro', 'DELETE FROM sr_pk', {
        connectionGen: 1,
        timeoutSec: 60,
        explain: false,
      }),
    ).rejects.toThrow(/read-only/i);
    expect(await seen('SELECT count(*)::int FROM sr_pk')).toEqual([[3]]);
    await ro.disconnect();
  });
});
