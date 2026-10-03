import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type LaunchedPlasma, launchPlasma, plasmaInvoke } from '../lib/app';
import { pgConfig } from '../lib/fixture';

/**
 * DuckDB "Open data file": main validates and allowlists picked files, the
 * worker (a real utilityProcess) loads the native DuckDB module and runs the
 * session sandboxed. No database server is needed.
 */

let plasma: LaunchedPlasma;
let dir: string;
let csv: string;
let notes: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'plasma-e2e-data-'));
  csv = join(dir, 'sales.csv');
  notes = join(dir, 'notes.txt');
  writeFileSync(csv, 'id,region,amount\n1,north,10.5\n2,south,7\n3,north,2\n');
  writeFileSync(notes, 'not a data file');
  plasma = await launchPlasma();
});

test.afterAll(async () => {
  await plasma?.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const config = (files: string[], id = 'duckdb-e2e') => ({
  id,
  name: 'sales.csv',
  engine: 'duckdb',
  host: 'local',
  port: 1,
  database: ':memory:',
  user: '',
  password: '',
  ssl: false,
  readOnly: false,
  duckdb: { files },
});

test('E-DUCK-01 picked CSV becomes a view you can query; other files stay out of reach', async () => {
  // The native dialog cannot be driven: answer it from the main process.
  await plasma.app.evaluate(
    ({ dialog }, files) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: files })) as never;
    },
    [csv, notes],
  );

  const picked = await plasmaInvoke<{ files: string[]; problems: string[] }>(
    plasma.page,
    'conn.pickDataFiles',
    'files',
  );
  expect(picked.files).toEqual([csv]);
  expect(picked.problems.join()).toMatch(/notes\.txt/);

  const info = await plasmaInvoke<{ engine: string; serverVersion: string }>(
    plasma.page,
    'conn.connect',
    config(picked.files),
  );
  expect(info.engine).toBe('duckdb');

  const schema = await plasmaInvoke<{ tables: Array<{ name: string; kind: string }> }>(
    plasma.page,
    'conn.introspect',
  );
  expect(schema.tables.map((t) => [t.name, t.kind])).toEqual([['sales', 'view']]);

  const res = await plasmaInvoke<{ rows: unknown[][] }>(
    plasma.page,
    'query.run',
    'SELECT region, sum(amount) AS total FROM sales GROUP BY region ORDER BY region',
  );
  expect(res.rows).toEqual([
    ['north', 12.5],
    ['south', 7],
  ]);

  await expect(
    plasmaInvoke(plasma.page, 'query.run', "SELECT * FROM read_csv_auto('/etc/hostname')"),
  ).rejects.toThrow(/file system operations are disabled/);
});

test('E-DUCK-02 main refuses a file nobody picked or dropped', async () => {
  await expect(
    plasmaInvoke(plasma.page, 'conn.connect', config([join(dir, 'other.csv')], 'duckdb-evil')),
  ).rejects.toThrow(/file picker|drop it on the window/);
});

test('E-DUCK-03 a saved Postgres connection attaches read-only and joins with the file', async () => {
  const saved = pgConfig({ id: 'e2e-duck-pg', name: 'duck pg' });
  try {
    await plasmaInvoke(plasma.page, 'vault.save', saved);
  } catch (err) {
    // Saving a connection needs a working OS keychain, which headless runners lack.
    test.skip(/OS-level encryption/.test(String(err)), 'no OS keychain on this machine');
    throw err;
  }

  await plasmaInvoke(plasma.page, 'conn.connect', {
    ...config([csv], 'duckdb-e2e-attach'),
    duckdb: { files: [csv], attachConnectionIds: ['e2e-duck-pg'] },
  });
  const schema = await plasmaInvoke<{ tables: Array<{ schema: string; name: string }> }>(
    plasma.page,
    'conn.introspect',
  );
  expect(schema.tables.map((t) => `${t.schema}.${t.name}`)).toEqual(
    expect.arrayContaining(['main.sales', 'pg_duck_pg.e2e.people']),
  );

  const joined = await plasmaInvoke<{ rows: unknown[][] }>(
    plasma.page,
    'query.run',
    'SELECT s.region, count(*) AS n FROM sales s JOIN pg_duck_pg.e2e.people p ON p.region = s.region GROUP BY s.region ORDER BY s.region',
  );
  expect(joined.rows).toEqual([['north', 2]]);

  await expect(
    plasmaInvoke(plasma.page, 'query.run', 'DELETE FROM pg_duck_pg.e2e.people'),
  ).rejects.toThrow(/read-only|READ_ONLY|attached/i);
  // The attachment is a session detail, never a saved connection of its own.
  const saved2 = await plasmaInvoke<Array<{ id: string }>>(plasma.page, 'vault.list');
  expect(saved2.map((c) => c.id)).toEqual(['e2e-duck-pg']);
});
