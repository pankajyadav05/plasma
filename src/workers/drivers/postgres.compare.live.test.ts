import type { ConnectionConfig } from '@shared/protocol';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runIsolatedReadOnlyQuery } from '../test-connect';
import { PostgresDriver } from './postgres';

/**
 * Opt-in live check (C2): Result Compare's read path on a real Postgres.
 *
 *   PLASMA_LIVE_PG=postgres://postgres@127.0.0.1:5495/postgres pnpm vitest run \
 *     src/workers/drivers/postgres.compare.live.test.ts
 */
const url = process.env.PLASMA_LIVE_PG;
const suite = url ? describe : describe.skip;
const scratch = `plasma_cmp_${Math.random().toString(36).slice(2, 10)}`;

function configFor(database: string): ConnectionConfig {
  const u = new URL(url as string);
  return {
    id: `cmp-${database}`,
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

suite('result compare read path (live)', () => {
  let admin: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${scratch}`);
    const c = new pg.Client({ ...configFor(scratch), password: undefined });
    await c.connect();
    await c.query('CREATE TABLE t (id int primary key, v text)');
    await c.query("INSERT INTO t SELECT g, 'v' || g FROM generate_series(1, 30000) g");
    await c.end();
  });

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    await admin.end();
  });

  it('reads past the 10k display cap up to the requested rows, flags truncation', async () => {
    const all = await runIsolatedReadOnlyQuery(
      configFor(scratch),
      'SELECT * FROM t ORDER BY id',
      50_000,
    );
    expect(all.rows).toHaveLength(30_000);
    expect(all.truncated).toBeFalsy();
    const some = await runIsolatedReadOnlyQuery(
      configFor(scratch),
      'SELECT * FROM t ORDER BY id',
      12_000,
    );
    expect(some.rows).toHaveLength(12_000);
    expect(some.truncated).toBe(true);
  }, 30_000);

  it('the default agent path keeps its small cap', async () => {
    const d = new PostgresDriver();
    await d.connect(configFor(scratch), 0);
    try {
      const r = await d.aiQuery('SELECT * FROM t');
      expect(r.rows.length).toBeLessThanOrEqual(10_000);
      expect(r.truncated).toBe(true);
    } finally {
      await d.disconnect();
    }
  });

  it('the isolated session is read-only: a write hidden in a CTE fails and changes nothing', async () => {
    await expect(
      runIsolatedReadOnlyQuery(
        configFor(scratch),
        'WITH d AS (DELETE FROM t WHERE id = 1 RETURNING id) SELECT * FROM d',
        100,
      ),
    ).rejects.toThrow(/read-only/i);
    const check = await runIsolatedReadOnlyQuery(
      configFor(scratch),
      'SELECT count(*)::int AS n FROM t WHERE id = 1',
      10,
    );
    expect(check.rows[0]?.[0]).toBe(1);
  });
});
