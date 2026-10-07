import type { ConnectionConfig } from '@shared/protocol';
import { type QueryLifecycle, reduceLifecycle } from '@shared/query-lifecycle';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDriver } from './postgres';

/**
 * Opt-in live check (C1): the REAL errors a Postgres session produces for a
 * cancel, a statement timeout and a killed backend land in the right
 * lifecycle phase.
 *
 *   PLASMA_LIVE_PG=postgres://postgres@127.0.0.1:5495/postgres pnpm vitest run \
 *     src/workers/drivers/postgres.lifecycle.live.test.ts
 */
const url = process.env.PLASMA_LIVE_PG;
const suite = url ? describe : describe.skip;
const scratch = `plasma_life_${Math.random().toString(36).slice(2, 10)}`;

function configFor(database: string): ConnectionConfig {
  const u = new URL(url as string);
  return {
    id: `life-${database}`,
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
const running = (): QueryLifecycle => ({ phase: 'running', since: 1, startedAt: 1 });
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

suite('postgres query lifecycle (live)', () => {
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

  it('a user cancel ends as cancelled and the session stays usable', async () => {
    const d = await fresh();
    const run = d.query('SELECT pg_sleep(30)').catch((e: unknown) => e);
    await sleep(300);
    let life = reduceLifecycle(running(), { type: 'cancel', now: 2 });
    expect(await d.cancelQuery()).toBe(true);
    life = reduceLifecycle(life, { type: 'fail', now: 3, message: messageOf(await run) });
    expect(life.phase).toBe('cancelled');
    expect((await d.query('SELECT 1')).rows[0]?.[0]).toBe(1);
  });

  it('cancel with nothing running is reported as not delivered', async () => {
    const d = await fresh();
    expect(await d.cancelQuery()).toBe(false);
  });

  it('a server-side statement timeout is a failure, not a cancel', async () => {
    const d = await fresh();
    await d.query("SET statement_timeout = '200ms'");
    const err = await d.query('SELECT pg_sleep(5)').catch((e: unknown) => e);
    const life = reduceLifecycle(running(), { type: 'fail', now: 3, message: messageOf(err) });
    expect(life.phase).toBe('failed');
  }, 10_000);

  it('a backend killed during a write is outcome unknown; during a read, disconnected', async () => {
    for (const [sql, isWrite, phase] of [
      ['SELECT pg_sleep(30) /* life_w */', true, 'unknown'],
      ['SELECT pg_sleep(30) /* life_r */', false, 'disconnected'],
    ] as const) {
      const d = await fresh({ closeTimeoutMs: 1500 });
      const marker = isWrite ? 'life_w' : 'life_r';
      const run = d.query(sql).catch((e: unknown) => e);
      await sleep(300);
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%${marker}%' AND pid <> pg_backend_pid()`,
      );
      const err = await Promise.race([run, sleep(8000).then(() => 'hung')]);
      expect(err).not.toBe('hung');
      const life = reduceLifecycle(running(), {
        type: 'fail',
        now: 3,
        message: messageOf(err),
        isWrite,
        sql,
      });
      expect(life.phase).toBe(phase);
    }
  }, 30_000);
});
