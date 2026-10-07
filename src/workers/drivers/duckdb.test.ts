import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataFileSessionConfig } from '@shared/data-files';
import type { ConnectionConfig } from '@shared/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DuckdbDriver, duckdbBlobToHex, shortestFloat32 } from './duckdb';
import { writeTestXlsx } from './test-xlsx';

let dir: string;
let csv: string;
let tsv: string;
let ndjson: string;
let json: string;
let parquet: string;
let dbFile: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'plasma-duckdb-'));
  csv = join(dir, 'Sales 2024.csv');
  tsv = join(dir, 'people.tsv');
  ndjson = join(dir, 'events.ndjson');
  json = join(dir, 'config.json');
  parquet = join(dir, 'nums.parquet');
  dbFile = join(dir, 'warehouse.duckdb');
  writeFileSync(
    csv,
    'id,region,amount,day\n1,north,10.5,2024-01-02\n2,south,,2024-01-03\n3,north,7,\n',
  );
  writeFileSync(tsv, 'name\tage\nada\t36\nlin\t41\n');
  writeFileSync(ndjson, '{"k":1,"tags":["a","b"]}\n{"k":2,"tags":[]}\n');
  writeFileSync(json, '[{"x":1,"y":"one"},{"x":2,"y":"two"}]');
  // Parquet + a .duckdb file are produced by DuckDB itself.
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const inst = await DuckDBInstance.create(dbFile);
  const c = await inst.connect();
  await c.run('CREATE TABLE items (id INTEGER PRIMARY KEY, label VARCHAR NOT NULL, big BIGINT)');
  await c.run("INSERT INTO items VALUES (1,'a',9007199254740993),(2,'b',5)");
  await c.run(
    `COPY (SELECT range AS n, range * 2 AS d FROM range(1, 6)) TO '${parquet}' (FORMAT parquet)`,
  );
  c.closeSync();
  inst.closeSync();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let driver: DuckdbDriver | null = null;
afterEach(async () => {
  await driver?.disconnect();
  driver = null;
});

async function open(paths: string[], extra: Partial<ConnectionConfig> = {}) {
  driver = new DuckdbDriver();
  const config = { ...dataFileSessionConfig(paths), ...extra };
  const version = await driver.connect(config);
  return { d: driver, version };
}

describe('DuckDB values', () => {
  it('shows a FLOAT as its shortest float32 value, not the widened double', () => {
    expect(shortestFloat32(1.100000023841858)).toBe(1.1);
    expect(shortestFloat32(Math.fround(0.1))).toBe(0.1);
    expect(shortestFloat32(Math.fround(16777217))).toBe(16777216);
    expect(shortestFloat32(0)).toBe(0);
    expect(shortestFloat32(Number.NaN)).toBeNaN();
    expect(shortestFloat32(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  it('shows a BLOB as `\\x` + lower-case hex like every other engine', () => {
    expect(duckdbBlobToHex('\\xDE\\xAD\\xBE\\xEF')).toBe('\\xdeadbeef');
    expect(duckdbBlobToHex('ab\\x00c')).toBe('\\x61620063');
    expect(duckdbBlobToHex('')).toBe('\\x');
    // A backslash is printed as \x5C, so a literal "\x" pair in text cannot be misread.
    expect(duckdbBlobToHex('\\x5Cx41')).toBe('\\x5c783431');
  });

  it('refuses a read that writes: nextval() moves a sequence', async () => {
    driver = new DuckdbDriver();
    await driver.connect({ ...dataFileSessionConfig([]), database: ':memory:' });
    await driver.query('CREATE SEQUENCE seq_a');
    await expect(driver.aiQuery("SELECT nextval('seq_a')")).rejects.toThrow(/read-only/i);
    await expect(driver.sidebandQuery("SELECT nextval('seq_a')")).rejects.toThrow(/read-only/i);
    // Nothing moved, the session still reads, and the editor itself may call it.
    expect((await driver.aiQuery('SELECT 1')).rows).toEqual([[1]]);
    expect((await driver.query("SELECT nextval('seq_a')")).rows).toEqual([[1]]);
  });

  it('refuses AI reads while the user has a transaction open', async () => {
    driver = new DuckdbDriver();
    await driver.connect({ ...dataFileSessionConfig([]), database: ':memory:' });
    await driver.query('BEGIN');
    await expect(driver.aiQuery('SELECT 1')).rejects.toThrow(/transaction is open/);
    await driver.query('ROLLBACK');
    expect((await driver.aiQuery('SELECT 1')).rows).toEqual([[1]]);
  });
});

describe('DuckDB data-file session', () => {
  it('turns each file into a view named after it and queries them', async () => {
    const { d, version } = await open([csv, tsv, ndjson, json, parquet]);
    expect(version).toMatch(/^\d+\.\d+/);
    const schema = await d.introspect();
    const names = schema.tables.map((t) => t.name).sort();
    expect(names).toEqual(['Sales_2024', 'config', 'events', 'nums', 'people']);
    expect(schema.tables.every((t) => t.kind === 'view')).toBe(true);
    const sales = schema.tables.find((t) => t.name === 'Sales_2024');
    expect(sales?.details).toEqual(
      expect.arrayContaining([
        { label: 'Source file', value: csv },
        { label: 'Format', value: 'CSV' },
      ]),
    );
    const cols = schema.columns.filter((c) => c.table === 'Sales_2024').map((c) => c.name);
    expect(cols).toEqual(['id', 'region', 'amount', 'day']);

    const r = await d.query(
      'SELECT region, sum(amount) AS total FROM "Sales_2024" GROUP BY region ORDER BY region',
    );
    expect(r.columns.map((c) => c.name)).toEqual(['region', 'total']);
    expect(r.rows[0]?.[0]).toBe('north');
    expect(Number(r.rows[0]?.[1])).toBe(17.5);
    expect(r.rows[1]).toEqual(['south', null]);
    const tsvRows = await d.query('SELECT name, age FROM people ORDER BY age');
    expect(tsvRows.rows).toEqual([
      ['ada', 36],
      ['lin', 41],
    ]);
    const nd = await d.query('SELECT k, tags FROM events ORDER BY k');
    expect(nd.rows).toEqual([
      [1, ['a', 'b']],
      [2, []],
    ]);
    const js = await d.query('SELECT x, y FROM config ORDER BY x');
    expect(js.rows).toEqual([
      [1, 'one'],
      [2, 'two'],
    ]);
    const pq = await d.query('SELECT sum(n) AS s, count(*) AS c FROM nums');
    expect(pq.rows[0]?.[1]).toBe(5);
  });

  it('binds $n parameters and reports the row cap', async () => {
    const { d } = await open([parquet]);
    const r = await d.query('SELECT n FROM nums WHERE n > $1 ORDER BY n LIMIT $2', [2, 10]);
    expect(r.rows).toEqual([[3], [4], [5]]);
    const capped = await d.query('SELECT n FROM nums ORDER BY n', undefined, { maxRows: 2 });
    expect(capped.rows).toEqual([[1], [2]]);
    expect(capped.truncated).toBe(true);
  });

  it('profiles a file with SUMMARIZE (type, null %, distinct estimate, min/max)', async () => {
    const { d } = await open([csv]);
    const r = await d.query('SUMMARIZE "Sales_2024"');
    const col = (name: string) => r.columns.findIndex((c) => c.name === name);
    const amount = r.rows.find((row) => row[col('column_name')] === 'amount');
    expect(amount?.[col('column_type')]).toMatch(/DOUBLE|DECIMAL/);
    expect(Number(amount?.[col('null_percentage')])).toBeCloseTo(33.33, 1);
    expect(amount?.[col('min')]).toBeDefined();
    expect(amount?.[col('approx_unique')]).toBeDefined();
  });

  it('sandboxes the session: no other files, no writes, no lifting the lock', async () => {
    const { d } = await open([csv]);
    await expect(d.query("SELECT * FROM read_csv_auto('/etc/hostname')")).rejects.toThrow(
      /file system operations are disabled|Permission/i,
    );
    await expect(d.query(`COPY "Sales_2024" TO '${join(dir, 'out.csv')}'`)).rejects.toThrow(
      /outside the session|file system operations are disabled/,
    );
    await expect(d.query('SET enable_external_access = true')).rejects.toThrow();
    await expect(d.query("ATTACH ':memory:' AS other")).rejects.toThrow(/outside the session/);
    await expect(d.query('INSTALL httpfs')).rejects.toThrow();
    // The opened file itself stays readable.
    expect((await d.query('SELECT count(*) FROM "Sales_2024"')).rows[0]?.[0]).toBe(3);
  });

  it('refuses writes on sideband / AI queries and edit batches', async () => {
    const { d } = await open([csv]);
    await expect(d.sidebandQuery('CREATE TABLE t (a int)')).rejects.toThrow(/read-only/);
    await expect(d.aiQuery('DROP VIEW "Sales_2024"')).rejects.toThrow(/read-only/);
    await expect(d.aiQuery('SELECT 1; SELECT 2')).rejects.toThrow(/single/);
    await expect(d.commitEditBatch(0, [{ sql: 'x' }])).rejects.toThrow(/cannot be edited/);
    expect((await d.sidebandQuery('SELECT 1 AS one')).rows).toEqual([[1]]);
  });

  it('allows scratch tables in memory unless the connection is read-only', async () => {
    const { d } = await open([csv]);
    await d.query('CREATE TABLE scratch AS SELECT * FROM "Sales_2024" WHERE id = 1');
    expect((await d.query('SELECT count(*) FROM scratch')).rows[0]?.[0]).toBe(1);
    await d.disconnect();
    const ro = await open([csv], { readOnly: true });
    await expect(ro.d.query('CREATE TABLE s2 (a int)')).rejects.toThrow(/read-only/);
    expect((await ro.d.query('SELECT 1')).rows).toEqual([[1]]);
  });

  it('reports which file failed and rejects glob characters', async () => {
    const bad = join(dir, 'bad.csv');
    writeFileSync(bad, '');
    driver = new DuckdbDriver();
    await expect(driver.connect(dataFileSessionConfig([join(dir, 'a[1].csv')]))).rejects.toThrow(
      /a\[1\]\.csv/,
    );
    await expect(driver.connect(dataFileSessionConfig([join(dir, 'missing.csv')]))).rejects.toThrow(
      /not found/,
    );
  });

  it('exports in batches with the header even when empty', async () => {
    const { d } = await open([parquet]);
    const batches = [];
    for await (const b of d.streamQueryForExport('SELECT n FROM nums ORDER BY n')) batches.push(b);
    expect(batches.flatMap((b) => b.rows)).toEqual([[1], [2], [3], [4], [5]]);
    const empty = [];
    for await (const b of d.streamQueryForExport('SELECT n FROM nums WHERE n > 99')) empty.push(b);
    expect(empty).toHaveLength(1);
    expect(empty[0]?.columns.map((c) => c.name)).toEqual(['n']);
  });

  it('cancels a long statement', async () => {
    const { d } = await open([parquet]);
    const long = d.query('SELECT count(*) FROM range(5000000000) a, range(1000) b');
    await new Promise((r) => setTimeout(r, 200));
    expect(await d.cancelQuery()).toBe(true);
    await expect(long).rejects.toThrow(/canceling statement due to user request/);
    expect((await d.query('SELECT 1')).rows).toEqual([[1]]);
  });

  it('enforces the statement timeout', async () => {
    const { d } = await open([parquet]);
    await d.setStatementTimeout(300);
    await expect(
      d.query('SELECT count(*) FROM range(5000000000) a, range(1000) b'),
    ).rejects.toThrow(/statement timeout/);
  });
});

describe('DuckDB database file', () => {
  it('opens a .duckdb file read-only, with keys in the structure', async () => {
    const { d } = await open([dbFile]);
    const schema = await d.introspect();
    const items = schema.columns.filter((c) => c.table === 'items');
    expect(items.map((c) => [c.name, c.isPrimaryKey, c.isNullable])).toEqual([
      ['id', true, false],
      ['label', false, false],
      ['big', false, true],
    ]);
    const big = await d.query('SELECT big FROM items ORDER BY id');
    // Past 2^53 the value stays text so nothing is rounded.
    expect(big.rows).toEqual([['9007199254740993'], [5]]);
    await expect(d.query("INSERT INTO items VALUES (3,'c',1)")).rejects.toThrow(/read-only/);
  });

  it('attaches a database next to data files without writing to it', async () => {
    const { d } = await open([dbFile, csv]);
    const schema = await d.introspect();
    const item = schema.tables.find((t) => t.name === 'items');
    expect(item?.schema).toBe('warehouse.main');
    const r = await d.query('SELECT count(*) FROM warehouse.main.items i, "Sales_2024" s');
    expect(r.rows[0]?.[0]).toBe(6);
    await expect(d.query("INSERT INTO warehouse.main.items VALUES (9,'z',1)")).rejects.toThrow();
  });
});

/**
 * Opt-in: needs a Postgres server (the same PLASMA_LIVE_PG url the other live
 * suites use). Attaches it read-only and joins it with a CSV.
 */
const livePg = process.env.PLASMA_LIVE_PG ? describe : describe.skip;

livePg('DuckDB attached Postgres (live)', () => {
  const url = new URL(process.env.PLASMA_LIVE_PG ?? 'postgres://postgres@127.0.0.1:5432/postgres');
  const attach = {
    alias: 'pg_live',
    host: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.replace(/^\//, '') || 'postgres',
    user: decodeURIComponent(url.username || 'postgres'),
    password: decodeURIComponent(url.password || ''),
    sslmode: 'prefer' as const,
  };
  let table: string;

  beforeAll(async () => {
    const pg = (await import('pg')).default;
    const client = new pg.Client({ connectionString: process.env.PLASMA_LIVE_PG });
    await client.connect();
    table = `plasma_duck_${process.pid}`;
    await client.query(`DROP TABLE IF EXISTS ${table}`);
    await client.query(`CREATE TABLE ${table} (id int primary key, region text)`);
    await client.query(`INSERT INTO ${table} VALUES (1, 'north'), (2, 'south')`);
    await client.end();
  });

  afterAll(async () => {
    const pg = (await import('pg')).default;
    const client = new pg.Client({ connectionString: process.env.PLASMA_LIVE_PG });
    await client.connect();
    await client.query(`DROP TABLE IF EXISTS ${table}`);
    await client.end();
  });

  it('joins a CSV with a live table and keeps the attachment read-only', async () => {
    const { d } = await open([csv], {
      duckdb: { files: [csv], installPostgresExtension: true, attach: [attach] },
    });
    const schema = await d.introspect();
    const t = schema.tables.find((x) => x.name === table);
    expect(t?.schema).toBe('pg_live.public');
    expect(schema.columns.find((c) => c.table === table && c.name === 'id')?.isPrimaryKey).toBe(
      true,
    );
    const r = await d.query(
      `SELECT s.region, count(*) AS n FROM "Sales_2024" s JOIN pg_live.public.${table} p ON p.region = s.region GROUP BY s.region ORDER BY s.region`,
    );
    expect(r.rows).toEqual([
      ['north', 2],
      ['south', 1],
    ]);
    await expect(d.query(`DELETE FROM pg_live.public.${table}`)).rejects.toThrow(
      /read-only|READ_ONLY/i,
    );
    await expect(d.query(`INSERT INTO pg_live.public.${table} VALUES (9, 'x')`)).rejects.toThrow();
  });

  it('does not leak the password through the catalog or secrets', async () => {
    // A trust-auth server accepts any password, so the check also runs there.
    const pw = attach.password || 'sup3r-s3cret';
    const { d } = await open([csv], {
      duckdb: {
        files: [csv],
        installPostgresExtension: true,
        attach: [{ ...attach, password: pw }],
      },
    });
    const dbs = await d.query('SELECT * FROM duckdb_databases()');
    expect(JSON.stringify(dbs.rows)).not.toContain(pw);
    const secrets = await d.query('SELECT * FROM duckdb_secrets()');
    expect(JSON.stringify(secrets.rows)).not.toContain(pw);
    await expect(d.query('SELECT * FROM duckdb_secrets(redact = false)')).rejects.toThrow();
  });

  it('reports a failed attach without the password', async () => {
    driver = new DuckdbDriver();
    const bad = { ...attach, port: 1, password: 'hunter2' };
    const err = await driver
      .connect({
        ...dataFileSessionConfig([csv]),
        duckdb: { files: [csv], installPostgresExtension: true, attach: [bad] },
      })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Could not attach Postgres as pg_live/);
    expect((err as Error).message).not.toContain('hunter2');
  });
});

/**
 * Opt-in like the attach suite: reading .xlsx needs DuckDB's Excel extension,
 * a one-time download, so it runs where the live suites run (network).
 */
const liveExt =
  process.env.PLASMA_LIVE_PG || process.env.PLASMA_LIVE_DUCKDB_EXT ? describe : describe.skip;

liveExt('DuckDB Excel workbooks (live: downloads the Excel extension)', () => {
  it('opens every visible sheet as its own view, typed, alongside a CSV', async () => {
    const book = join(dir, 'Sales Book.xlsx');
    writeTestXlsx(book, [
      {
        name: 'Q1',
        rows: [
          ['region', 'amount'],
          ['north', 120.5],
          ['south', 99],
        ],
      },
      {
        name: 'Reps & Regions',
        rows: [
          ['region', 'rep'],
          ['north', 'Ada'],
          ['south', 'Grace'],
        ],
      },
      { name: 'Lookup', rows: [['x'], ['y']], state: 'hidden' },
    ]);
    const { d } = await open([book, csv], {
      duckdb: { files: [book, csv], installExcelExtension: true },
    });
    const schema = await d.introspect();
    const views = schema.tables.map((t) => t.name).sort();
    expect(views).toEqual(['Sales_2024', 'Sales_Book_Q1', 'Sales_Book_Reps_Regions']);
    const q1 = schema.tables.find((t) => t.name === 'Sales_Book_Q1');
    expect(q1?.details).toEqual(
      expect.arrayContaining([
        { label: 'Format', value: 'Excel workbook' },
        { label: 'Sheet', value: 'Q1' },
      ]),
    );
    const r = await d.query(
      'SELECT q.region, q.amount + 0.5 AS a, r.rep FROM "Sales_Book_Q1" q JOIN "Sales_Book_Reps_Regions" r USING (region) ORDER BY 1',
    );
    expect(r.rows).toEqual([
      ['north', 121, 'Ada'],
      ['south', 99.5, 'Grace'],
    ]);
  });

  it('names a single-sheet workbook after the file', async () => {
    const book = join(dir, 'single.xlsx');
    writeTestXlsx(book, [{ name: 'Sheet1', rows: [['n'], [1], [2]] }]);
    const { d } = await open([book], { duckdb: { files: [book], installExcelExtension: true } });
    const r = await d.query('SELECT sum(n) AS s FROM single');
    expect(r.rows).toEqual([[3]]);
  });

  it('keeps the sandbox: other workbooks stay unreachable', async () => {
    const book = join(dir, 'open.xlsx');
    const other = join(dir, 'other.xlsx');
    writeTestXlsx(book, [{ name: 'S', rows: [['n'], [1]] }]);
    writeTestXlsx(other, [{ name: 'S', rows: [['n'], [2]] }]);
    const { d } = await open([book], { duckdb: { files: [book], installExcelExtension: true } });
    await expect(d.query(`SELECT * FROM read_xlsx('${other}')`)).rejects.toThrow();
  });
});
