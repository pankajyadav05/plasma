import type { ConnectionConfig } from '@shared/protocol';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDriver } from './postgres';

/**
 * Opt-in live checks (F21) that need a real database of their own: edit
 * batches with and without an open user transaction, savepoint rollback,
 * txnState from ReadyForQuery, aiQuery staying read-only, and server-side
 * read-only enforcement.
 *
 *   PLASMA_LIVE_PG=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm vitest run \
 *     src/workers/drivers/postgres.scratch.live.test.ts
 *
 * Skipped when PLASMA_LIVE_PG is unset. Creates a scratch database
 * (plasma_live_<random>) and drops it afterwards.
 */
const url = process.env.PLASMA_LIVE_PG;
const suite = url ? describe : describe.skip;

const scratch = `plasma_live_${Math.random().toString(36).slice(2, 10)}`;

function configFor(raw: string, database: string, readOnly: boolean): ConnectionConfig {
  const u = new URL(raw);
  return {
    id: `live-${database}-${readOnly}`,
    name: 'live',
    engine: 'postgres',
    host: u.hostname,
    port: Number(u.port || 5432),
    database,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl: false,
    readOnly,
  } as ConnectionConfig;
}

const UPDATE = 'UPDATE items SET v = $1 WHERE id = $2';

async function value(driver: PostgresDriver, id: number): Promise<unknown> {
  const r = await driver.query(`SELECT v FROM items WHERE id = ${id}`);
  return r.rows[0]?.[0];
}

suite('postgres driver (live, scratch database)', () => {
  const rw = new PostgresDriver();
  const ro = new PostgresDriver();

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${scratch}`);
    } finally {
      await admin.end();
    }
    await rw.connect(configFor(url as string, scratch, false), 0);
    rw.setConnectionGen(1);
    await rw.query('CREATE TABLE items (id int PRIMARY KEY, v text)');
    await rw.query("INSERT INTO items VALUES (1, 'a'), (2, 'b')");
    await ro.connect(configFor(url as string, scratch, true), 0);
    ro.setConnectionGen(1);
  });

  afterAll(async () => {
    await ro.disconnect().catch(() => {});
    await rw.disconnect().catch(() => {});
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  it('commitEditBatch commits atomically when every UPDATE hits one row', async () => {
    const res = await rw.commitEditBatch(1, [
      { sql: UPDATE, params: ['a2', '1'] },
      { sql: UPDATE, params: ['b2', '2'] },
    ]);
    expect(res).toEqual({ state: 'none', applied: 2, conflicts: [] });
    expect(await value(rw, 1)).toBe('a2');
    expect(await value(rw, 2)).toBe('b2');
  });

  it('rolls the whole batch back when an UPDATE matches no row', async () => {
    const res = await rw.commitEditBatch(1, [
      { sql: UPDATE, params: ['x', '1'] },
      { sql: UPDATE, params: ['x', '99'], label: 'id=99' },
    ]);
    expect(res.applied).toBe(0);
    expect(res.conflicts).toEqual([{ index: 1, reason: 'no-match' }]);
    expect(await value(rw, 1)).toBe('a2');
    expect(rw.getTxnState()).toBe('none');
  });

  it('rolls back when an UPDATE matches several rows', async () => {
    await expect(
      rw.commitEditBatch(1, [{ sql: 'UPDATE items SET v = $1', params: ['all'] }]),
    ).rejects.toThrow(/matched 2 rows/);
    expect(await value(rw, 1)).toBe('a2');
  });

  it('uses a savepoint inside the user transaction: failure keeps earlier work, success stays open', async () => {
    await rw.query('BEGIN');
    await rw.query("UPDATE items SET v = 'mine' WHERE id = 1");
    const conflicted = await rw.commitEditBatch(1, [
      { sql: UPDATE, params: ['batch', '2'] },
      { sql: UPDATE, params: ['nope', '99'] },
    ]);
    expect(conflicted.conflicts).toHaveLength(1);
    // The user's transaction is still open and healthy, with its own change,
    // and the failed batch left no trace.
    expect(rw.getTxnState()).toBe('active');
    expect(await value(rw, 1)).toBe('mine');
    expect(await value(rw, 2)).toBe('b2');

    const ok = await rw.commitEditBatch(1, [{ sql: UPDATE, params: ['batch', '2'] }]);
    expect(ok).toEqual({ state: 'active', applied: 1 });
    await rw.query('ROLLBACK');
    expect(rw.getTxnState()).toBe('none');
    expect(await value(rw, 1)).toBe('a2');
    expect(await value(rw, 2)).toBe('b2');
  });

  it('refuses an edit batch while the transaction is aborted', async () => {
    await rw.query('BEGIN');
    await rw.query('SELECT 1/0').catch(() => {});
    expect(rw.getTxnState()).toBe('error');
    await expect(rw.commitEditBatch(1, [{ sql: UPDATE, params: ['z', '1'] }])).rejects.toThrow();
    await rw.query('ROLLBACK');
    expect(rw.getTxnState()).toBe('none');
  });

  it('txnState follows ROLLBACK TO SAVEPOINT back to active', async () => {
    await rw.query('BEGIN');
    await rw.query('SAVEPOINT s1');
    await rw.query('SELECT 1/0').catch(() => {});
    expect(rw.getTxnState()).toBe('error');
    await rw.query('ROLLBACK TO SAVEPOINT s1');
    expect(rw.getTxnState()).toBe('active');
    await rw.query('COMMIT');
    expect(rw.getTxnState()).toBe('none');
  });

  it('aiQuery reads but never writes, and leaves the aux session usable', async () => {
    const ok = await rw.aiQuery('SELECT count(*) FROM items');
    expect(ok.rows[0]?.[0]).toBe('2');
    await expect(rw.aiQuery("UPDATE items SET v = 'ai' WHERE id = 1")).rejects.toThrow(
      /read-only/i,
    );
    await expect(rw.aiQuery('DELETE FROM items')).rejects.toThrow(/read-only/i);
    await expect(rw.aiQuery('DROP TABLE items')).rejects.toThrow(/read-only/i);
    // Multi-statement smuggling is refused before it reaches the server.
    await expect(rw.aiQuery('SELECT 1; DELETE FROM items')).rejects.toThrow(/single/i);
    expect(await value(rw, 1)).toBe('a2');
    const again = await rw.aiQuery('SELECT 1');
    expect(again.rows[0]?.[0]).toBe(1);
  });

  it('a read-only connection is enforced by the server', async () => {
    const rows = await ro.query('SELECT count(*) FROM items');
    expect(rows.rows[0]?.[0]).toBe('2');
    await expect(ro.query("UPDATE items SET v = 'ro' WHERE id = 1")).rejects.toThrow(/read-only/i);
    await expect(ro.query("INSERT INTO items VALUES (3, 'c')")).rejects.toThrow(/read-only/i);
    expect(await value(rw, 1)).toBe('a2');
  });
});
