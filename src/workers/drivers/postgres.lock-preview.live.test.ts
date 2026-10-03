import {
  LOCK_CONTEXT_SQL,
  analyzeLocks,
  describeLockTarget,
  lockTargetNames,
  parseLockContext,
} from '@shared/pg-lock-preview';
import { checkMigration, lintOptionsFromSettings } from '@shared/pg-migration-check';
import type { ConnectionConfig } from '@shared/protocol';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDriver } from './postgres';

/**
 * Lock preview opt-in live checks:
 *
 *   PLASMA_LIVE_PG=postgres://postgres@127.0.0.1:5502/postgres pnpm vitest run \
 *     src/workers/drivers/postgres.lock-preview.live.test.ts
 */
const url = process.env.PLASMA_LIVE_PG;
const suite = url ? describe : describe.skip;

function configFrom(raw: string): ConnectionConfig {
  const u = new URL(raw);
  return {
    id: 'live-lock-preview',
    name: 'live-lock-preview',
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

suite('lock preview (live)', () => {
  const d = new PostgresDriver();
  let holder: pg.Client;
  const ctxFor = async (names: string[]) => {
    const res = await d.sidebandQuery(LOCK_CONTEXT_SQL, [names], { timeoutMs: 5000 });
    const rows = res.rows.map((r) => Object.fromEntries(res.columns.map((c, i) => [c.name, r[i]])));
    return parseLockContext(rows);
  };

  beforeAll(async () => {
    await d.connect(configFrom(url as string), 0);
    d.setConnectionGen(1);
    await d.query('DROP SCHEMA IF EXISTS lp CASCADE');
    await d.query('CREATE SCHEMA lp');
    await d.query(
      'CREATE TABLE lp.orders (id serial PRIMARY KEY, customer_id int, note varchar(20), qty int)',
    );
    await d.query('CREATE INDEX orders_customer_idx ON lp.orders (customer_id, id)');
    await d.query(
      "INSERT INTO lp.orders (customer_id, note, qty) SELECT i % 100, 'n' || i, i FROM generate_series(1, 20000) i",
    );
    await d.query('ANALYZE lp.orders');
    await d.query('CREATE TABLE lp.idle (id int)');
    holder = new pg.Client({ connectionString: url, application_name: 'lock-holder' });
    await holder.connect();
  });

  afterAll(async () => {
    await holder?.end().catch(() => undefined);
    await d.query('DROP SCHEMA IF EXISTS lp CASCADE').catch(() => undefined);
    await d.disconnect();
  });

  it('reports row estimate, size, columns and indexes without other sessions', async () => {
    const m = await ctxFor(['lp.orders', 'lp.idle', 'lp.missing']);
    const o = m.get('lp.orders');
    expect(o?.resolved).toBe('lp.orders');
    expect(o?.estRows).toBe(20000);
    expect(o?.totalBytes).toBeGreaterThan(100_000);
    expect(o?.sessionCount).toBe(0);
    expect(o?.columns.find((c) => c.name === 'note')?.type).toBe('character varying(20)');
    expect(o?.indexes).toContainEqual(['customer_id', 'id']);
    expect(m.get('lp.idle')?.estRows === null || m.get('lp.idle')?.estRows === 0).toBe(true);
    expect(m.get('lp.missing')?.resolved).toBeNull();
  });

  it('reports a session holding a lock on the table, and the active query', async () => {
    await holder.query('BEGIN');
    await holder.query('SELECT count(*) FROM lp.orders');
    try {
      const sql = 'ALTER TABLE lp.orders ADD COLUMN extra int';
      const locks = analyzeLocks(sql);
      const m = await ctxFor(lockTargetNames(locks));
      const c = m.get('lp.orders');
      expect(c?.sessionCount).toBe(1);
      expect(c?.holders).toBe(1);
      expect(c?.waiters).toBe(0);
      expect(c?.sessions[0]).toMatchObject({ user: 'postgres', waiting: false });
      expect(c?.sessions[0]?.modes).toContain('AccessShareLock');
      const line = describeLockTarget(locks[0]!, locks[0]!.targets[0]!, c);
      expect(line.text).toMatch(
        /^This ALTER takes ACCESS EXCLUSIVE on lp\.orders \(≈20k rows, [\d.]+ [kM]B\); 1 session is using it now\.$/,
      );
      expect(line.blocks).toBe('reads and writes');
    } finally {
      await holder.query('ROLLBACK');
    }
  });

  it('reports waiting sessions queued behind a lock', async () => {
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE lp.orders IN ACCESS EXCLUSIVE MODE');
    const waiter = new pg.Client({ connectionString: url, application_name: 'lock-waiter' });
    await waiter.connect();
    const pending = waiter.query('SELECT 1 FROM lp.orders').catch(() => undefined);
    try {
      let c = (await ctxFor(['lp.orders'])).get('lp.orders');
      for (let i = 0; i < 40 && (c?.waiters ?? 0) < 1; i++) {
        await new Promise((r) => setTimeout(r, 50));
        c = (await ctxFor(['lp.orders'])).get('lp.orders');
      }
      expect(c?.sessionCount).toBe(2);
      expect(c?.waiters).toBe(1);
      expect(c?.sessions.some((s) => s.waiting)).toBe(true);
    } finally {
      await holder.query('ROLLBACK');
      await pending;
      await waiter.end();
    }
  });

  it('resolves an index name to its table', async () => {
    const m = await ctxFor(['lp.orders_customer_idx']);
    expect(m.get('lp.orders_customer_idx')?.resolved).toBe('lp.orders');
  });

  it('feeds live column types and indexes into the linter', async () => {
    const fk = 'ALTER TABLE lp.orders ADD FOREIGN KEY (qty) REFERENCES lp.idle (id) NOT VALID';
    const locks = analyzeLocks(fk);
    const ctx = await ctxFor(lockTargetNames(locks));
    const r = checkMigration(fk, lintOptionsFromSettings(undefined), ctx, '16.2');
    expect(r.findings.find((f) => f.ruleId === 'fk-missing-index')?.severity).toBe('warn');
    const widen = checkMigration(
      'ALTER TABLE lp.orders ALTER COLUMN note TYPE varchar(80)',
      lintOptionsFromSettings(undefined),
      await ctxFor(['lp.orders']),
    );
    expect(widen.findings.map((f) => f.ruleId)).not.toContain('change-column-type');
    const idx = checkMigration(
      'CREATE INDEX i ON lp.orders (qty)',
      lintOptionsFromSettings(undefined),
      await ctxFor(['lp.orders']),
    );
    expect(idx.findings.map((f) => f.ruleId)).toContain('create-index-non-concurrent');
  });
});
