import type { PgNotification } from '@shared/pg-listen';
import type { ConnectionConfig } from '@shared/protocol';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDriver } from './postgres';

/**
 * LISTEN/NOTIFY tail opt-in live checks (throwaway cluster):
 *
 *   PLASMA_LIVE_PG=postgres://postgres@127.0.0.1:5503/postgres pnpm vitest run \
 *     src/workers/drivers/postgres.listen.live.test.ts
 */
const url = process.env.PLASMA_LIVE_PG;
const suite = url ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function configFrom(raw: string): ConnectionConfig {
  const u = new URL(raw);
  return {
    id: 'live-listen',
    name: 'live-listen',
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

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(25);
}

suite('LISTEN/NOTIFY tail (live)', () => {
  const d = new PostgresDriver();
  const seen: PgNotification[] = [];
  let other: pg.Client;
  const backends = async () =>
    Number(
      (
        await d.sidebandQuery(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'plasma-listen'",
        )
      ).rows[0]?.[0],
    );

  beforeAll(async () => {
    await d.connect(configFrom(url as string), 0);
    d.setConnectionGen(1);
    d.setNotificationListener((n) => seen.push(n));
    other = new pg.Client({ connectionString: url });
    await other.connect();
  });

  afterAll(async () => {
    d.setNotificationListener(null);
    await other.end();
    await d.disconnect();
  });

  it('delivers notifications from another session on a dedicated connection', async () => {
    expect(await backends()).toBe(0);
    await d.listen('orders');
    expect(await backends()).toBe(1);
    await other.query("SELECT pg_notify('orders', $1)", ['{"id":7}']);
    await until(() => seen.length >= 1);
    expect(seen[0]).toMatchObject({ channel: 'orders', payload: '{"id":7}' });
    expect(seen[0]?.pid).toBeGreaterThan(0);
  });

  it('keeps the primary session free: an open transaction there does not hold notifications back', async () => {
    seen.length = 0;
    await d.query('BEGIN');
    await other.query("NOTIFY orders, 'during-txn'");
    await until(() => seen.length >= 1);
    expect(seen.map((n) => n.payload)).toEqual(['during-txn']);
    await d.query('ROLLBACK');
  });

  it('sends NOTIFY from the app (aux session) and receives it back', async () => {
    seen.length = 0;
    await d.notify('orders', 'from-plasma');
    await until(() => seen.length >= 1);
    expect(seen[0]?.payload).toBe('from-plasma');
  });

  it('listens to several channels, ignores unlistened ones and handles odd names', async () => {
    seen.length = 0;
    await d.listen('Mixed Case "q"');
    await d.listen('orders'); // duplicate is a no-op
    await other.query('SELECT pg_notify($1, $2)', ['Mixed Case "q"', 'x']);
    await other.query("SELECT pg_notify('nobody', 'y')");
    await until(() => seen.length >= 1);
    await sleep(150);
    expect(seen.map((n) => [n.channel, n.payload])).toEqual([['Mixed Case "q"', 'x']]);
  });

  it('stops delivering after unlisten and drops the connection with the last channel', async () => {
    await d.unlisten('orders');
    seen.length = 0;
    await other.query("SELECT pg_notify('orders', 'late')");
    await sleep(200);
    expect(seen).toHaveLength(0);
    await d.unlisten('Mixed Case "q"');
    expect(await backends()).toBe(0);
  });

  it('caps a flood and reports the drop count', async () => {
    seen.length = 0;
    await d.listen('flood');
    await other.query("SELECT pg_notify('flood', i::text) FROM generate_series(1, 1000) i");
    await until(() => seen.some((n) => n.channel === '(plasma)'), 4000);
    const real = seen.filter((n) => n.channel === 'flood');
    const note = seen.find((n) => n.channel === '(plasma)');
    expect(real.length).toBeGreaterThan(0);
    expect(real.length).toBeLessThan(1000);
    expect(note?.payload).toMatch(/notifications were dropped/);
    await d.unlisten('flood');
  });

  it('cleans the listener up on disconnect', async () => {
    await d.listen('orders');
    expect(await backends()).toBe(1);
    const probe = new pg.Client({ connectionString: url });
    await probe.connect();
    await d.disconnect();
    const n = await probe.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'plasma-listen'",
    );
    await probe.end();
    expect(n.rows[0].n).toBe(0);
  });
});
