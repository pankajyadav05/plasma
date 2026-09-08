import { test, expect } from '@playwright/test';
import { launchPlasma, plasmaInvoke, type LaunchedPlasma } from '../lib/app';
import { pgConfig } from '../lib/fixture';

/**
 * L1 Connect scenarios (week-1).
 * E-CONN-01: connect + introspect against fixture Postgres.
 * E-CONN-04: Test Connection must not replace the live session (U02 / F2).
 *   Catching test — marked test.fail until U02 lands (main still uses kind connect).
 */

let plasma: LaunchedPlasma;

test.beforeAll(async () => {
  plasma = await launchPlasma();
});

test.afterAll(async () => {
  await plasma?.dispose();
});

test('E-CONN-01 connect + introspect lists seed tables with PK flags', async () => {
  const cfg = pgConfig({ id: 'e2e-conn-01', name: 'e2e-conn-01' });
  const info = await plasmaInvoke<{ serverVersion: string; engine: string; connectionGen?: number }>(
    plasma.page,
    'conn.connect',
    cfg,
  );
  expect(info.engine).toBe('postgres');
  expect(info.serverVersion).toMatch(/PostgreSQL/i);

  const schema = await plasmaInvoke<{
    tables: Array<{ schema: string; name: string }>;
    columns: Array<{ schema: string; table: string; name: string; isPrimaryKey: boolean }>;
  }>(plasma.page, 'conn.introspect');

  const seedTables = schema.tables.filter((t) => t.schema === 'e2e');
  const names = seedTables.map((t) => t.name).sort();
  expect(names).toEqual(expect.arrayContaining(['types', 'people', 'nopk']));

  const peoplePk = schema.columns.filter(
    (c) => c.schema === 'e2e' && c.table === 'people' && c.isPrimaryKey,
  );
  expect(peoplePk.map((c) => c.name)).toContain('id');

  const nopkPk = schema.columns.filter(
    (c) => c.schema === 'e2e' && c.table === 'nopk' && c.isPrimaryKey,
  );
  expect(nopkPk).toHaveLength(0);

  await plasmaInvoke(plasma.page, 'conn.disconnect');
});

test('E-CONN-04 Test Connection must not replace live session (U02)', async () => {
  // Catching test for U02: today ConnectionTest uses kind:'connect' and
  // tears down the live worker session. Expected to fail until main routes
  // through testConnect / runIsolatedTestConnect.
  test.fail(true, 'U02: ConnectionTest still uses kind connect (disconnectAll)');

  const cfgA = pgConfig({ id: 'e2e-conn-04-a', name: 'live-A' });
  const cfgB = pgConfig({ id: 'e2e-conn-04-b', name: 'probe-B' });
  const cfgBad = pgConfig({
    id: 'e2e-conn-04-bad',
    name: 'bad',
    password: 'definitely-wrong-password',
  });

  await plasmaInvoke(plasma.page, 'conn.connect', cfgA);
  await plasmaInvoke(plasma.page, 'txn.begin');
  await plasmaInvoke(
    plasma.page,
    'query.run',
    "INSERT INTO e2e.people(name, age) VALUES ('txn-probe', 99)",
  );

  const ok = await plasmaInvoke<{ ok: boolean; serverVersion?: string }>(
    plasma.page,
    'conn.test',
    cfgB,
  );
  expect(ok.ok).toBe(true);

  // Live session A must still be usable with open txn.
  const txid = await plasmaInvoke<{ rows: unknown[][]; rowCount: number }>(
    plasma.page,
    'query.run',
    'SELECT txid_current()',
  );
  expect(txid.rowCount).toBeGreaterThanOrEqual(1);

  const bad = await plasmaInvoke<{ ok: boolean }>(plasma.page, 'conn.test', cfgBad);
  expect(bad.ok).toBe(false);

  // Still on A after failed test.
  const still = await plasmaInvoke<{ rows: unknown[][] }>(plasma.page, 'query.run', 'SELECT 1');
  expect(still.rows.length).toBe(1);

  await plasmaInvoke(plasma.page, 'txn.rollback');
  await plasmaInvoke(plasma.page, 'conn.disconnect');
});
