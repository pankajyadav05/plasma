import type { ConnectionConfig } from '@shared/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClickhouseDriver } from './clickhouse';

/**
 * Opt-in: needs a ClickHouse server (HTTP interface).
 *   PLASMA_LIVE_CLICKHOUSE=1 [PLASMA_CLICKHOUSE_HOST/PORT/USER/PASSWORD]
 * Creates and drops its own database (`plasma_live_<pid>`).
 */
const live = process.env.PLASMA_LIVE_CLICKHOUSE ? describe : describe.skip;

const base = (): ConnectionConfig =>
  ({
    id: 'c',
    name: 'c',
    engine: 'clickhouse',
    host: process.env.PLASMA_CLICKHOUSE_HOST ?? '127.0.0.1',
    port: Number(process.env.PLASMA_CLICKHOUSE_PORT ?? 8123),
    database: '',
    user: process.env.PLASMA_CLICKHOUSE_USER ?? 'default',
    password: process.env.PLASMA_CLICKHOUSE_PASSWORD ?? '',
    ssl: false,
    readOnly: false,
  }) as ConnectionConfig;

const DB = `plasma_live_${process.pid}`;

live('clickhouse driver (live)', () => {
  let drv: ClickhouseDriver;

  beforeAll(async () => {
    const admin = new ClickhouseDriver();
    await admin.connect(base());
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    await admin.disconnect();
    drv = new ClickhouseDriver();
    await drv.connect({ ...base(), database: DB });
    await drv.query(`CREATE TABLE events (
      id UInt64, name String, ts DateTime, score Nullable(Float64), tags Array(String), amount Decimal(10, 2)
    ) ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (id, ts) TTL ts + INTERVAL 50 YEAR`);
    await drv.query(
      `INSERT INTO events VALUES
        (1, 'ada', '2024-05-06 07:08:09', 1.5, ['x', 'y'], 12.34),
        (18446744073709551615, 'bob', '2024-06-01 00:00:00', NULL, [], 0.01),
        (3, 'it''s', '2024-06-02 00:00:00', 3, ['z'], 5)`,
    );
    await drv.query('CREATE VIEW big_events AS SELECT * FROM events WHERE id > 1');
  });

  afterAll(async () => {
    const admin = new ClickhouseDriver();
    await admin.connect(base());
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.disconnect();
    await drv.disconnect();
  });

  it('connects and reports the server version', async () => {
    const d = new ClickhouseDriver();
    const version = await d.connect({ ...base(), database: DB });
    expect(version).toMatch(/^ClickHouse \d+\.\d+/);
    await d.disconnect();
  });

  it('returns typed columns and exact values', async () => {
    const r = await drv.query('SELECT id, name, score, tags, amount FROM events ORDER BY ts');
    expect(r.columns.map((c) => [c.name, c.dataTypeName])).toEqual([
      ['id', 'UInt64'],
      ['name', 'String'],
      ['score', 'Nullable(Float64)'],
      ['tags', 'Array(String)'],
      ['amount', 'Decimal(10, 2)'],
    ]);
    expect(r.rows[0]).toEqual([1, 'ada', 1.5, ['x', 'y'], '12.34']);
    // 2^64 - 1 stays text; nothing is rounded.
    expect(r.rows[1]).toEqual(['18446744073709551615', 'bob', null, [], '0.01']);
    expect(r.rows[2]?.[1]).toBe("it's");
    expect(r.command).toBe('SELECT');
  });

  it('binds $n parameters as escaped literals', async () => {
    const r = await drv.query('SELECT id FROM events WHERE name = $1 AND id < $2', ["it's", 100]);
    expect(r.rows).toEqual([[3]]);
    const evil = await drv.query('SELECT count() FROM events WHERE name = $1', ["x' OR 1=1 --"]);
    expect(evil.rows).toEqual([[0]]);
    const like = await drv.query('SELECT name FROM events WHERE toString(name) ILIKE $1', ['AD%']);
    expect(like.rows).toEqual([['ada']]);
  });

  it('caps rows and flags truncation', async () => {
    const r = await drv.query('SELECT number FROM system.numbers LIMIT 100000', undefined, {
      maxRows: 50,
    });
    expect(r.rows).toHaveLength(50);
    expect(r.truncated).toBe(true);
  });

  it('runs commands and reports written rows', async () => {
    await drv.query('CREATE TABLE scratch (a UInt8) ENGINE = Memory');
    const ins = await drv.query('INSERT INTO scratch VALUES (1), (2), (3)');
    expect(ins.command).toBe('INSERT');
    expect(ins.rowCount).toBe(3);
    expect((await drv.query('SELECT count() FROM scratch')).rows).toEqual([[3]]);
  });

  it('runs a mutation written in the editor', async () => {
    await drv.query(
      "ALTER TABLE events UPDATE score = 9 WHERE name = 'ada' SETTINGS mutations_sync = 1",
    );
    const r = await drv.query("SELECT score FROM events WHERE name = 'ada'");
    expect(r.rows).toEqual([[9]]);
  });

  it('shows a statement with its own FORMAT clause as text', async () => {
    const r = await drv.query('SELECT 1 AS a, 2 AS b FORMAT CSV');
    expect(r.rows).toEqual([['1,2']]);
  });

  it('introspects databases, tables, keys, columns and skipping indexes', async () => {
    await drv.query(
      'ALTER TABLE events ADD INDEX idx_name name TYPE bloom_filter GRANULARITY 4 SETTINGS mutations_sync = 1',
    );
    const schema = await drv.introspect({ columnSchemas: [DB] });
    expect(schema.schemas.map((s) => s.name)).toContain(DB);
    expect(schema.schemas.map((s) => s.name)).not.toContain('system');
    const events = schema.tables.find((t) => t.schema === DB && t.name === 'events');
    expect(events?.kind).toBe('table');
    expect(events?.rowCountEstimate).toBe(3);
    const details = Object.fromEntries((events?.details ?? []).map((d) => [d.label, d.value]));
    expect(details.Engine).toBe('MergeTree');
    expect(details['Sorting key']).toBe('id, ts');
    expect(details['Partition key']).toBe('toYYYYMM(ts)');
    expect(details.TTL).toMatch(/ts \+ toIntervalYear\(50\)/);
    expect(schema.tables.find((t) => t.name === 'big_events')?.kind).toBe('view');
    const cols = schema.columns.filter((c) => c.schema === DB && c.table === 'events');
    expect(cols.map((c) => c.name)).toEqual(['id', 'name', 'ts', 'score', 'tags', 'amount']);
    expect(cols.find((c) => c.name === 'score')?.isNullable).toBe(true);
    expect(cols.find((c) => c.name === 'id')?.isPrimaryKey).toBe(true);
    expect(schema.indexes?.find((i) => i.name === 'idx_name')?.definition).toMatch(
      /TYPE bloom_filter GRANULARITY 4/,
    );
  });

  it('explains a query as a plan tree', async () => {
    const r = await drv.explain('SELECT name FROM events WHERE id = 1', false);
    const plan = JSON.parse(String(r.rows[0]?.[0])) as Array<{ Plan: { Plans: unknown[] } }>;
    expect(plan[0]?.Plan.Plans.length).toBeGreaterThan(0);
    expect(JSON.stringify(plan)).toContain('ReadFromMergeTree');
  });

  it('exports in batches, header first even when empty', async () => {
    const rows: unknown[][] = [];
    for await (const b of drv.streamQueryForExport(
      'SELECT number FROM system.numbers LIMIT 1200',
    )) {
      rows.push(...b.rows);
    }
    expect(rows).toHaveLength(1200);
    const empty = [];
    for await (const b of drv.streamQueryForExport('SELECT number FROM system.numbers LIMIT 0')) {
      empty.push(b);
    }
    expect(empty).toHaveLength(1);
    expect(empty[0]?.columns.map((c) => c.name)).toEqual(['number']);
  });

  it('refuses grid edit batches', async () => {
    await expect(drv.commitEditBatch(0, [{ sql: 'x' }])).rejects.toThrow(/cannot be edited/);
  });

  it('cancels a long query on the server', async () => {
    const long = drv
      .query('SELECT sum(number) FROM numbers(100000000000) SETTINGS max_threads = 1')
      .then(
        () => null,
        (e: Error) => e,
      );
    await new Promise((r) => setTimeout(r, 400));
    expect(await drv.cancelQuery()).toBe(true);
    expect((await long)?.message).toMatch(/canceling statement/);
    expect((await drv.query('SELECT 1')).rows).toEqual([[1]]);
    // Nothing is left running on the server.
    const left = await drv.query(
      "SELECT count() FROM system.processes WHERE query LIKE '%numbers(100000000000)%' AND query NOT LIKE '%system.processes%'",
    );
    expect(left.rows).toEqual([[0]]);
  });

  it('enforces the statement timeout', async () => {
    await drv.setStatementTimeout(1000);
    await expect(
      drv.query('SELECT sum(number) FROM numbers(100000000000) SETTINGS max_threads = 1'),
    ).rejects.toThrow(/statement timeout/);
    await drv.setStatementTimeout(0);
  });

  it('sideband and AI queries are read-only on the server, even on a writable connection', async () => {
    await expect(drv.sidebandQuery('INSERT INTO scratch VALUES (9)')).rejects.toThrow(/readonly/i);
    await expect(drv.aiQuery('DROP TABLE scratch')).rejects.toThrow(/readonly/i);
    await expect(drv.aiQuery('SELECT 1; SELECT 2')).rejects.toThrow(/single/);
    expect((await drv.sidebandQuery('SELECT 7')).rows).toEqual([[7]]);
  });

  it('a read-only connection (readonly=1) refuses writes and cannot lift it', async () => {
    const ro = new ClickhouseDriver();
    await ro.connect({ ...base(), database: DB, readOnly: true });
    expect((await ro.query('SELECT count() FROM events')).rows).toEqual([[3]]);
    await expect(ro.query('INSERT INTO scratch VALUES (5)')).rejects.toThrow(/readonly/i);
    await expect(ro.query('ALTER TABLE events UPDATE score = 1 WHERE id = 1')).rejects.toThrow(
      /readonly/i,
    );
    await expect(ro.query('SELECT 1 SETTINGS readonly = 0')).rejects.toThrow(/readonly/i);
    await expect(ro.query('DROP TABLE scratch')).rejects.toThrow(/readonly/i);
    await ro.disconnect();
  });

  it('reports a wrong password and an unreachable server clearly', async () => {
    const bad = new ClickhouseDriver();
    await expect(bad.connect({ ...base(), user: 'nobody', password: 'wrong' })).rejects.toThrow(
      /Authentication failed|password|nobody/i,
    );
    const off = new ClickhouseDriver();
    await expect(off.connect({ ...base(), port: 1 })).rejects.toThrow(/ECONNREFUSED|connect/i);
  });
});

/**
 * Opt-in on top of the live suite: an HTTPS endpoint with a self-signed
 * certificate for `localhost`.
 *   PLASMA_CLICKHOUSE_TLS_PORT=8443 PLASMA_CLICKHOUSE_TLS_CA=/path/to/server.crt
 */
const liveTls =
  process.env.PLASMA_LIVE_CLICKHOUSE && process.env.PLASMA_CLICKHOUSE_TLS_PORT
    ? describe
    : describe.skip;

liveTls('clickhouse driver over TLS (live)', () => {
  const tlsBase = (): ConnectionConfig => ({
    ...base(),
    host: 'localhost',
    port: Number(process.env.PLASMA_CLICKHOUSE_TLS_PORT),
    ssl: true,
  });

  it('connects with require (encrypted, certificate not checked)', async () => {
    const d = new ClickhouseDriver();
    await d.connect({ ...tlsBase(), tls: { mode: 'require' } });
    expect((await d.query('SELECT 1')).rows).toEqual([[1]]);
    await d.disconnect();
  });

  it('refuses an untrusted certificate under verify-full, accepts it with its CA', async () => {
    const refused = new ClickhouseDriver();
    await expect(refused.connect({ ...tlsBase(), tls: { mode: 'verify-full' } })).rejects.toThrow(
      /self.signed|unable to verify|certificate/i,
    );
    const ca = (await import('node:fs')).readFileSync(
      process.env.PLASMA_CLICKHOUSE_TLS_CA ?? '',
      'utf8',
    );
    const ok = new ClickhouseDriver();
    await ok.connect({ ...tlsBase(), tls: { mode: 'verify-full', ca } });
    expect((await ok.query('SELECT 2')).rows).toEqual([[2]]);
    await ok.disconnect();
  });

  it('fails verify-full when the certificate names another host', async () => {
    const ca = (await import('node:fs')).readFileSync(
      process.env.PLASMA_CLICKHOUSE_TLS_CA ?? '',
      'utf8',
    );
    const d = new ClickhouseDriver();
    await expect(
      d.connect({
        ...tlsBase(),
        host: '127.0.0.2',
        tls: { mode: 'verify-full', ca, servername: 'other.example' },
      }),
    ).rejects.toThrow(/altnames|hostname|identity|ECONNREFUSED/i);
  });
});
