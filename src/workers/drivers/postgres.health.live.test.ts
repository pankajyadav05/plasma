import {
  ACTIVITY_SQL,
  activityIsPartial,
  blockingChain,
  buildLockGraph,
  parseActivity,
} from '@shared/health/pg-activity';
import { PG_CHECKS, runPgCheck, runStatementsCheck } from '@shared/health/pg-checks';
import {
  IDLE_IN_TXN_SECONDS,
  LONG_RUNNING_SECONDS,
  LONG_SESSIONS_SQL,
  interpretLongSessions,
} from '@shared/health/pg-overview';
import { type CheckResult, type PgCheck, rowsToObjects } from '@shared/health/types';
import type { ConnectionConfig } from '@shared/protocol';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDriver } from './postgres';

/**
 * Health advisor against a real Postgres: seeds an unused index, a
 * duplicate index, an invalid index, a dead-tuple-heavy table, an FK
 * without an index and an idle-in-transaction session, and asserts the
 * findings. Also runs every check as a role with no monitoring privileges.
 *
 *   PLASMA_LIVE_PG=postgres://postgres@127.0.0.1:5501/postgres pnpm vitest run \
 *     src/workers/drivers/postgres.health.live.test.ts
 */
const url = process.env.PLASMA_LIVE_PG;
const suite = url ? describe : describe.skip;
const SUITE_TIMEOUT = 60_000;
const DROP_ROLE =
  "DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'h_limited') THEN DROP OWNED BY h_limited; DROP ROLE h_limited; END IF; END $$";

const LIMITED_PASSWORD = 'h-limited-pw';

function configFrom(raw: string, user?: string, password?: string): ConnectionConfig {
  const u = new URL(raw);
  return {
    id: 'live-health',
    name: 'live-health',
    engine: 'postgres',
    host: u.hostname,
    port: Number(u.port || 5432),
    database: u.pathname.slice(1) || 'postgres',
    user: user ?? decodeURIComponent(u.username),
    password: password ?? decodeURIComponent(u.password),
    ssl: false,
  } as ConnectionConfig;
}

const byId = (r: CheckResult, id: string) => r.findings.find((f) => f.id === id);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

suite('health advisor (live)', { timeout: SUITE_TIMEOUT }, () => {
  const owner = new PostgresDriver();
  const limited = new PostgresDriver();
  let idler: pg.Client;
  let idlerPid = 0;

  const queryFor =
    (d: PostgresDriver) => async (sql: string, params: unknown[] | undefined, timeoutMs: number) =>
      rowsToObjects(await d.sidebandQuery(sql, params, { timeoutMs }));
  const run = (id: string, d: PostgresDriver = owner) => {
    const check = PG_CHECKS.find((c) => c.id === id) as PgCheck;
    return runPgCheck(check, queryFor(d));
  };

  beforeAll(async () => {
    await owner.connect(configFrom(url as string), 0);
    owner.setConnectionGen(1);
    for (const sql of [
      'DROP TABLE IF EXISTS h_child, h_parent, h_dead, h_dup, h_inv CASCADE',
      DROP_ROLE,
      // unused + duplicate + overlapping indexes
      'CREATE TABLE h_dup (id serial PRIMARY KEY, a int, b int)',
      'INSERT INTO h_dup (a, b) SELECT g, g FROM generate_series(1, 2000) g',
      'CREATE INDEX h_dup_a1 ON h_dup (a)',
      'CREATE INDEX h_dup_a2 ON h_dup (a)',
      'CREATE INDEX h_dup_ab ON h_dup (a, b)',
      // invalid index: a unique build that fails on duplicate values
      'CREATE TABLE h_inv (a int)',
      'INSERT INTO h_inv SELECT 1 FROM generate_series(1, 5)',
      // FK without an index on the child column
      'CREATE TABLE h_parent (id int PRIMARY KEY)',
      'CREATE TABLE h_child (id int PRIMARY KEY, parent_id int REFERENCES h_parent (id))',
      // dead tuples, autovacuum off so they stay
      'CREATE TABLE h_dead (id int, pad text) WITH (autovacuum_enabled = false)',
      "INSERT INTO h_dead SELECT g, repeat('x', 50) FROM generate_series(1, 20000) g",
      'DELETE FROM h_dead WHERE id <= 15000',
      'ANALYZE h_dup, h_child, h_parent',
      `CREATE ROLE h_limited LOGIN PASSWORD '${LIMITED_PASSWORD}'`,
      'GRANT CONNECT ON DATABASE postgres TO h_limited',
    ]) {
      await owner.query(sql);
    }
    // PG15+ delays idle stats flushes by up to 10 s; ask for one now.
    await owner.query('SELECT pg_stat_force_next_flush()').catch(() => {});
    await expect(
      owner.query('CREATE UNIQUE INDEX CONCURRENTLY h_inv_a ON h_inv (a)'),
    ).rejects.toThrow();

    const u = new URL(url as string);
    idler = new pg.Client({
      host: u.hostname,
      port: Number(u.port),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.slice(1),
    });
    await idler.connect();
    await idler.query('BEGIN');
    await idler.query('SELECT txid_current()');
    idlerPid = Number((await idler.query('SELECT pg_backend_pid() AS p')).rows[0].p);
    await sleep(1200);
  }, 60_000);

  afterAll(async () => {
    await idler?.end().catch(() => {});
    await limited.disconnect().catch(() => {});
    for (const sql of [
      'DROP TABLE IF EXISTS h_child, h_parent, h_dead, h_dup, h_inv CASCADE',
      DROP_ROLE,
    ]) {
      await owner.query(sql).catch(() => {});
    }
    await owner.disconnect();
  });

  it('flags an unused index with a DROP INDEX CONCURRENTLY preview', async () => {
    const r = await run('idx-unused');
    const f = byId(r, 'unused:public.h_dup_a1');
    expect(f).toBeDefined();
    expect(f?.action?.sql).toBe('DROP INDEX CONCURRENTLY IF EXISTS "public"."h_dup_a1";');
    // the primary key is never reported
    expect(r.findings.some((x) => x.id.includes('h_dup_pkey'))).toBe(false);
  });

  it('finds the duplicate and the overlapping index but never the primary key', async () => {
    const r = await run('idx-duplicate');
    const dup = r.findings.filter((f) => f.id.startsWith('dup:'));
    expect(dup).toHaveLength(1);
    expect(dup[0]?.id).toBe('dup:public.h_dup_a2');
    expect(byId(r, 'overlap:public.h_dup_a1')).toBeDefined();
    expect(r.findings.some((f) => f.id.includes('pkey'))).toBe(false);
  });

  it('finds the invalid index left by a failed CONCURRENTLY build', async () => {
    const r = await run('idx-invalid');
    expect(r.status).toBe('crit');
    expect(byId(r, 'invalid:public.h_inv_a')).toBeDefined();
  });

  it('finds the foreign key without an index', async () => {
    const r = await run('idx-fk');
    const f = r.findings.find((x) => x.id.startsWith('fk:public.h_child'));
    expect(f?.action?.sql).toMatch(
      /CREATE INDEX CONCURRENTLY .* ON "public"\."h_child" \(parent_id\)/,
    );
  });

  it('finds the dead-tuple-heavy table', async () => {
    let r = await run('maint-vacuum');
    for (let i = 0; i < 20 && !byId(r, 'dead:public.h_dead'); i++) {
      await sleep(500);
      r = await run('maint-vacuum');
    }
    const f = byId(r, 'dead:public.h_dead');
    expect(f).toBeDefined();
    expect(f?.status).toBe('crit');
    expect(f?.action?.sql).toContain('VACUUM');
  });

  it('finds the idle-in-transaction session', async () => {
    const check: PgCheck = {
      id: 'sessions',
      section: 'overview',
      title: 'sessions',
      sql: LONG_SESSIONS_SQL,
      params: [LONG_RUNNING_SECONDS, 0],
      interpret: interpretLongSessions,
    };
    const r = await runPgCheck(check, queryFor(owner));
    const f = byId(r, `sess:${idlerPid}`);
    expect(f).toBeDefined();
    expect(f?.title).toContain('idle in transaction');
    expect(f?.action?.sql).toBe(`SELECT pg_terminate_backend(${idlerPid});`);
    expect(IDLE_IN_TXN_SECONDS).toBeGreaterThan(0);
  });

  it('builds a lock-wait graph from a blocked update', async () => {
    const u = new URL(url as string);
    const mk = () =>
      new pg.Client({
        host: u.hostname,
        port: Number(u.port),
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        database: u.pathname.slice(1),
      });
    const holder = mk();
    const waiter = mk();
    await holder.connect();
    await waiter.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('UPDATE h_parent SET id = id');
      const holderPid = Number((await holder.query('SELECT pg_backend_pid() p')).rows[0].p);
      await holder.query('LOCK TABLE h_parent IN ACCESS EXCLUSIVE MODE');
      const blocked = waiter.query('SELECT count(*) FROM h_parent').catch(() => {});
      await sleep(600);
      const rows = parseActivity(
        rowsToObjects(await owner.sidebandQuery(ACTIVITY_SQL, undefined, { timeoutMs: 5000 })),
      );
      const graph = buildLockGraph(rows);
      expect(graph.roots).toContain(holderPid);
      const waiterPid = [...graph.nodes.values()].find((n) => n.blockers.includes(holderPid))?.pid;
      expect(waiterPid).toBeDefined();
      expect(blockingChain(graph, waiterPid as number).has(holderPid)).toBe(true);
      await holder.query('ROLLBACK');
      await blocked;
    } finally {
      await holder.end().catch(() => {});
      await waiter.end().catch(() => {});
    }
  });

  it('runs every check without erroring, including the bloat estimates', async () => {
    for (const check of PG_CHECKS) {
      const r = await runPgCheck(check, queryFor(owner));
      expect(r.status, `${check.id}: ${r.summary}`).not.toBe('unknown');
    }
  });

  it('reports pg_stat_statements as not enabled when it is not installed', async () => {
    const out = await runStatementsCheck(queryFor(owner));
    expect(['not-installed', 'ok']).toContain(out.state);
  });

  it('degrades gracefully for a role without monitoring privileges', async () => {
    await limited.connect(configFrom(url as string, 'h_limited', LIMITED_PASSWORD), 0);
    limited.setConnectionGen(1);
    for (const check of PG_CHECKS) {
      const r = await runPgCheck(check, queryFor(limited));
      expect(['ok', 'warn', 'crit', 'unknown']).toContain(r.status);
    }
    const rows = parseActivity(
      rowsToObjects(await limited.sidebandQuery(ACTIVITY_SQL, undefined, { timeoutMs: 5000 })),
    );
    expect(activityIsPartial(rows)).toBe(true);
  });

  it('runs a fix (DROP INDEX CONCURRENTLY) on the sideband outside a transaction', async () => {
    await owner.sidebandQuery('DROP INDEX CONCURRENTLY IF EXISTS "public"."h_inv_a";');
    const r = await run('idx-invalid');
    expect(byId(r, 'invalid:public.h_inv_a')).toBeUndefined();
  });
});
