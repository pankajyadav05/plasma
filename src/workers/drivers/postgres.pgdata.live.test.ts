import type { ConnectionConfig } from '@shared/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDriver } from './postgres';

/**
 * Opt-in live checks for transaction tracking, edit batches, EXPLAIN
 * safety and value parsing against a real server:
 *
 *   PLASMA_LIVE_PG=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm vitest run \
 *     src/workers/drivers/postgres.pgdata.live.test.ts
 *
 * Skipped when PLASMA_LIVE_PG is unset. Uses a temp table only.
 */
const url = process.env.PLASMA_LIVE_PG;
const suite = url ? describe : describe.skip;

function configFrom(raw: string): ConnectionConfig {
  const u = new URL(raw);
  return {
    id: 'live',
    name: 'live',
    engine: 'postgres',
    host: u.hostname,
    port: Number(u.port || 5432),
    database: u.pathname.slice(1) || 'postgres',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl: false,
    readOnly: false,
  } as ConnectionConfig;
}

suite('postgres driver (live): txn state, edits, explain, types', () => {
  const driver = new PostgresDriver();

  beforeAll(async () => {
    await driver.connect(configFrom(url as string), 0);
    driver.setConnectionGen(1);
    await driver.query('CREATE TEMP TABLE plasma_live_t (id int PRIMARY KEY, v text)');
    await driver.query("INSERT INTO plasma_live_t VALUES (1, 'a'), (2, 'b')");
  });

  afterAll(async () => {
    await driver.disconnect();
  });

  it('reports the affected row count for INSERT / UPDATE / DELETE', async () => {
    let r = await driver.query("INSERT INTO plasma_live_t VALUES (10, 'x'), (11, 'y'), (12, 'z')");
    expect([r.command, r.rowCount]).toEqual(['INSERT', 3]);
    r = await driver.query("UPDATE plasma_live_t SET v = 'q' WHERE id >= 10");
    expect([r.command, r.rowCount]).toEqual(['UPDATE', 3]);
    r = await driver.query('DELETE FROM plasma_live_t WHERE id >= 11');
    expect([r.command, r.rowCount]).toEqual(['DELETE', 2]);
    r = await driver.query('DELETE FROM plasma_live_t WHERE id = 10');
    expect(r.rowCount).toBe(1);
  });

  it('tracks a comment-prefixed BEGIN, END and aborted transactions from the server', async () => {
    let r = await driver.query('-- note\nBEGIN');
    expect(r.txnState).toBe('active');
    await driver.query('SELECT 1/0').catch(() => {});
    expect(driver.getTxnState()).toBe('error');
    r = await driver.query('END');
    expect(r.txnState).toBe('none');
  });

  it('edit batch inside a user transaction leaves that transaction open', async () => {
    await driver.query('/* c */ BEGIN');
    const res = await driver.commitEditBatch(1, [
      { sql: 'UPDATE plasma_live_t SET v = $1 WHERE id = $2', params: ['z', '1'] },
    ]);
    expect(res).toEqual({ state: 'active', applied: 1 });
    await driver.query('ROLLBACK');
    const after = await driver.query('SELECT v FROM plasma_live_t WHERE id = 1');
    expect(after.rows[0]?.[0]).toBe('a');
  });

  it('edit batch with a 0-row UPDATE rolls back everything', async () => {
    await expect(
      driver.commitEditBatch(1, [
        { sql: 'UPDATE plasma_live_t SET v = $1 WHERE id = $2', params: ['x', '2'] },
        {
          sql: 'UPDATE plasma_live_t SET v = $1 WHERE id = $2',
          params: ['x', '99'],
          label: 'id=99',
        },
      ]),
    ).rejects.toThrow(/Edit 2 of 2 \(id=99\) matched no row/);
    const after = await driver.query('SELECT v FROM plasma_live_t WHERE id = 2');
    expect(after.rows[0]?.[0]).toBe('b');
    expect(driver.getTxnState()).toBe('none');
  });

  it('EXPLAIN ANALYZE of a DELETE changes nothing', async () => {
    await driver.explain('DELETE FROM plasma_live_t', true);
    const plain = await driver.explain('DELETE FROM plasma_live_t', false);
    expect(plain.rows.length).toBe(1);
    const count = await driver.query('SELECT count(*) FROM plasma_live_t');
    expect(count.rows[0]?.[0]).toBe('2');
  });

  it('returns dates, timestamps, intervals and bytea as Postgres text', async () => {
    const r = await driver.query(
      "SELECT date '2024-01-05', timestamp '2024-01-05 10:11:12.123456', interval '3 days', '\\xdeadbeef'::bytea, ARRAY[1,2]::int4[], 'ab'::char(3)",
    );
    expect(r.rows[0]).toEqual([
      '2024-01-05',
      '2024-01-05 10:11:12.123456',
      '3 days',
      '\\xdeadbeef',
      '{1,2}',
      'ab ',
    ]);
    expect(r.columns.map((c) => c.dataTypeName)).toEqual([
      'date',
      'timestamp',
      'interval',
      'bytea',
      'int4[]',
      'bpchar',
    ]);
  });

  it('Transaction mode BEGINs before the first statement only', async () => {
    const r = await driver.query('SELECT 1', undefined, { autoBegin: true });
    expect(r.txnState).toBe('active');
    const v = await driver
      .query('VACUUM plasma_live_t', undefined, { autoBegin: true })
      .catch((e) => e);
    // VACUUM is exempt from auto-BEGIN, but we're already inside one now.
    expect(String(v)).toMatch(/cannot run inside a transaction block/);
    await driver.query('ROLLBACK');
    await driver.query('VACUUM plasma_live_t', undefined, { autoBegin: true });
    expect(driver.getTxnState()).toBe('none');
  });
});
