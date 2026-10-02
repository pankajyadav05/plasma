import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isConnectionLostError } from '@shared/connection-loss';
import type { ConnectionConfig } from '@shared/protocol';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDriver } from './postgres';

/**
 * Opt-in live checks for the runtime-robustness fixes (SC-03, P1-1, P1-3,
 * P2-1, P2-3, P2-5). Needs a real server:
 *
 *   PLASMA_LIVE_PG=postgres://postgres@127.0.0.1:5502/postgres pnpm vitest run \
 *     src/workers/drivers/postgres.robustness.live.test.ts
 *
 * Creates a scratch database and drops it afterwards.
 */
const url = process.env.PLASMA_LIVE_PG;
const suite = url ? describe : describe.skip;
const scratch = `plasma_rob_${Math.random().toString(36).slice(2, 10)}`;

function configFor(database: string): ConnectionConfig {
  const u = new URL(url as string);
  return {
    id: `rob-${database}`,
    name: 'live',
    engine: 'postgres',
    host: u.hostname,
    port: Number(u.port || 5432),
    database,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl: false,
    readOnly: false,
  } as ConnectionConfig;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

suite('postgres driver robustness (live)', () => {
  let admin: pg.Client;
  const drivers: PostgresDriver[] = [];
  const fresh = async (opts?: ConstructorParameters<typeof PostgresDriver>[0]) => {
    const d = new PostgresDriver(opts);
    drivers.push(d);
    await d.connect(configFor(scratch), 0);
    d.setConnectionGen(1);
    return d;
  };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${scratch}`);
  });

  afterAll(async () => {
    await Promise.allSettled(drivers.map((d) => d.disconnect()));
    await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    await admin.end();
  });

  it('SC-03: ROLLBACK after an aborted transaction idles past the probe window keeps the session', async () => {
    const d = await fresh({ idleProbeAfterMs: 40, probeTimeoutMs: 1000 });
    await d.query('CREATE TEMP TABLE keepme (n int)');
    await d.beginTransaction();
    await expect(d.query('SELECT 1/0')).rejects.toThrow(/division by zero/);
    expect(d.getTxnState()).toBe('error');
    await sleep(120);
    const state = await d.rollbackTransaction();
    expect(state).toBe('none');
    expect(d.isConnected()).toBe(true);
    expect(d.lostDuringTransaction()).toBe(false);
    // Session state (the temp table) survived: nothing was torn down.
    await expect(d.query('SELECT count(*) FROM keepme')).resolves.toBeDefined();
  });

  it('SC-03: a plain statement error then idle then another statement is not a lost connection', async () => {
    const d = await fresh({ idleProbeAfterMs: 40, probeTimeoutMs: 1000 });
    await expect(d.query('SELECT * FROM no_such_table')).rejects.toThrow(/does not exist/);
    await sleep(120);
    const r = await d.query('SELECT 7');
    expect(r.rows[0]?.[0]).toBe(7);
  });

  it('P1-1: a backend killed mid-read settles the query as connection-lost instead of hanging', async () => {
    const d = await fresh({ closeTimeoutMs: 1500 });
    const marker = `rob_kill_${Date.now()}`;
    const running = d.query(`SELECT pg_sleep(30), '${marker}'`);
    const settled = running.then(
      () => 'resolved',
      (e: unknown) => e,
    );
    await sleep(300);
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%${marker}%' AND pid <> pg_backend_pid()`,
    );
    const out = await Promise.race([settled, sleep(8000).then(() => 'hung')]);
    expect(out).not.toBe('hung');
    expect(out).not.toBe('resolved');
    expect(isConnectionLostError(out)).toBe(true);
    expect(d.isConnected()).toBe(false);
  }, 15_000);

  it('P2-1: cancelQuery reports delivery and is a no-op when nothing runs', async () => {
    const d = await fresh();
    expect(await d.cancelQuery()).toBe(false);
    const running = d.query('SELECT pg_sleep(30)').catch((e: unknown) => e);
    await sleep(300);
    expect(await d.cancelQuery()).toBe(true);
    const err = await running;
    expect(String(err)).toMatch(/canceling statement/);
    // Session is still usable afterwards.
    expect((await d.query('SELECT 1')).rows[0]?.[0]).toBe(1);
  });

  it('P1-3: abandoning an export stream after its first batch leaves the connection usable', async () => {
    const d = await fresh();
    const stream = d.streamQueryForExport('SELECT g FROM generate_series(1, 5000) g');
    const first = await stream.next();
    expect(first.done).toBe(false);
    await stream.return(undefined);
    const r = await Promise.race([d.query('SELECT 2'), sleep(5000).then(() => 'hung' as const)]);
    expect(r).not.toBe('hung');
  });

  it('P2-3: the byte cap trips on wide rows and marks the result truncated', async () => {
    const d = await fresh();
    const r = await d.query("SELECT repeat('x', 200000) AS big FROM generate_series(1, 200)", [], {
      maxBytes: 4 * 1024 * 1024,
    });
    expect(r.truncated).toBe(true);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.length).toBeLessThan(200);
  });

  it('P2-5: a statement_timeout change mid-transaction lands once the transaction ends', async () => {
    const d = await fresh();
    await d.beginTransaction();
    await d.setStatementTimeout(4321);
    await d.rollbackTransaction();
    const r = await d.query('SHOW statement_timeout');
    expect(r.rows[0]?.[0]).toBe('4321ms');
  });

  it('P2-5: changing statement_timeout during an aborted transaction does not throw', async () => {
    const d = await fresh();
    await d.beginTransaction();
    await expect(d.query('SELECT 1/0')).rejects.toThrow();
    await expect(d.setStatementTimeout(777)).resolves.toBeUndefined();
    await d.rollbackTransaction();
    expect((await d.query('SHOW statement_timeout')).rows[0]?.[0]).toBe('777ms');
  });

  it('P2-6: notices raised before an error travel with the error', async () => {
    const d = await fresh();
    const err = (await d
      .query("DO $$ BEGIN RAISE NOTICE 'before boom'; PERFORM 1/0; END $$")
      .catch((e: unknown) => e)) as Error & { notices?: { message: string }[] };
    expect(err.notices?.some((n) => n.message === 'before boom')).toBe(true);
  });

  it('P2-4: bytea stays hex even when the server default is escape', async () => {
    await admin.query(`ALTER DATABASE ${scratch} SET bytea_output = 'escape'`);
    try {
      const d = await fresh();
      const r = await d.query("SELECT '\\xdeadbeef'::bytea AS b");
      expect(r.rows[0]?.[0]).toBe('\\xdeadbeef');
    } finally {
      await admin.query(`ALTER DATABASE ${scratch} RESET bytea_output`);
    }
  });

  it('P2-4: json integers beyond 2^53 arrive exact', async () => {
    const d = await fresh();
    const r = await d.query('SELECT \'{"id": 12345678901234567890}\'::jsonb AS j');
    expect(r.rows[0]?.[0]).toEqual({ id: '12345678901234567890' });
  });

  it('P1-9: a pg_dump style SQL import leaves search_path and statement_timeout alone', async () => {
    const d = await fresh();
    await d.setStatementTimeout(4000);
    const before = (await d.query('SHOW search_path')).rows[0]?.[0];
    const file = join(tmpdir(), `plasma-dump-${Date.now()}.sql`);
    await writeFile(
      file,
      // BOM + a typical pg_dump header
      "\uFEFFSET statement_timeout = 0;\nSET lock_timeout = 0;\nSELECT pg_catalog.set_config('search_path', '', false);\nCREATE TABLE public.dumped (a int);\nINSERT INTO public.dumped VALUES (1), (2);\n",
    );
    try {
      const res = await d.runImport(
        {
          jobId: 'j',
          connectionGen: 1,
          filePath: file,
          format: 'sql',
          schema: 'public',
          table: 'dumped',
          columns: [],
          preStatements: [],
        } as never,
        { isCancelled: () => false, onProgress: () => undefined },
      );
      expect(res).toMatchObject({ ok: true });
      expect((await d.query('SHOW search_path')).rows[0]?.[0]).toBe(before);
      expect((await d.query('SHOW statement_timeout')).rows[0]?.[0]).toBe('4s');
      expect((await d.query('SELECT count(*) FROM dumped')).rows[0]?.[0]).toBe('2');
    } finally {
      await rm(file, { force: true });
    }
  });

  it('P2-17: cancelling an import interrupts the running statement', async () => {
    const d = await fresh();
    const file = join(tmpdir(), `plasma-slow-${Date.now()}.sql`);
    await writeFile(file, 'SELECT pg_sleep(30);\n');
    let cancelled = false;
    try {
      const running = d.runImport(
        {
          jobId: 'slow',
          connectionGen: 1,
          filePath: file,
          format: 'sql',
          schema: 'public',
          table: 't',
          columns: [],
          preStatements: [],
        } as never,
        { isCancelled: () => cancelled, onProgress: () => undefined },
      );
      await sleep(400);
      cancelled = true;
      expect(await d.cancelQuery()).toBe(true);
      const res = await Promise.race([running, sleep(5000).then(() => 'hung' as const)]);
      expect(res).not.toBe('hung');
      expect(res).toMatchObject({ ok: false, cancelled: true });
    } finally {
      await rm(file, { force: true });
    }
  }, 15_000);
});
