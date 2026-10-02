import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAlterPlan, buildCreateTable } from '@shared/pg-ddl';
import type { ConnectionConfig, ImportJobSpec } from '@shared/protocol';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDriver } from './postgres';

/**
 * Opt-in live check of structure DDL + import against a real server:
 *
 *   PLASMA_LIVE_PG=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm vitest run \
 *     src/workers/drivers/postgres.structure-import.live.test.ts
 *
 * Creates a scratch database and drops it afterwards.
 */
const url = process.env.PLASMA_LIVE_PG;
const suite = url ? describe : describe.skip;
const scratch = `plasma_live_${process.pid}_${Date.now()}`;

function configFor(raw: string, database: string): ConnectionConfig {
  const u = new URL(raw);
  return {
    id: 'live',
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

suite('structure editing + import (live)', () => {
  const driver = new PostgresDriver();
  let dir: string;
  const gen = 1;
  const noHooks = { isCancelled: () => false, onProgress: () => {} };

  const rows = async (sql: string) => (await driver.query(sql)).rows;
  const job = (over: Partial<ImportJobSpec>): ImportJobSpec => ({
    jobId: 'j',
    connectionGen: gen,
    filePath: '',
    format: 'csv',
    schema: 'public',
    table: 'people',
    columns: [
      { target: 'id', source: 0 },
      { target: 'full_name', source: 1 },
    ],
    csv: { delimiter: ',', quote: '"', header: true, nullString: '' },
    preStatements: [],
    ...over,
  });

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${scratch}`);
    await admin.end();
    await driver.connect(configFor(url as string, scratch), 0);
    driver.setConnectionGen(gen);
    dir = mkdtempSync(join(tmpdir(), 'plasma-live-'));
  });

  afterAll(async () => {
    await driver.disconnect().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    await admin.end();
  });

  it('creates a table, then alters it in one transaction plus a concurrent index', async () => {
    const create = buildCreateTable({
      schema: 'public',
      name: 'people',
      comment: "the people's table",
      columns: [
        { name: 'id', type: 'integer', nullable: false, primaryKey: true },
        { name: 'name', type: 'text', nullable: true, comment: 'display name' },
        { name: 'Weird Col', type: 'varchar(20)', nullable: false, default: 'x', unique: true },
      ],
    });
    const made = await driver.applyDdl({
      connectionGen: gen,
      transactional: create,
      concurrent: [],
    });
    expect(made.error).toBeUndefined();

    const plan = buildAlterPlan('public', 'people', [
      { kind: 'addColumn', column: { name: 'age', type: 'text', nullable: true, default: '7' } },
      { kind: 'alterType', name: 'age', type: 'integer', using: 'age::integer' },
      { kind: 'renameColumn', from: 'name', to: 'full_name' },
      { kind: 'setNullable', name: 'full_name', nullable: false },
      { kind: 'setDefault', name: 'full_name', type: 'text', default: 'anon' },
      { kind: 'setComment', name: 'age', comment: 'years' },
      {
        kind: 'addConstraint',
        constraint: { type: 'check', name: 'age_ok', expression: 'age >= 0' },
      },
      {
        kind: 'addIndex',
        index: { name: 'people_age_idx', columns: ['age'], where: 'age > 0', concurrently: true },
      },
    ]);
    const res = await driver.applyDdl({ connectionGen: gen, ...plan });
    expect(res).toEqual({ executed: plan.transactional.length + 1 });

    const cols = await rows(
      "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'people' ORDER BY ordinal_position",
    );
    expect(cols.map((c) => c[0])).toEqual(['id', 'full_name', 'Weird Col', 'age']);
    expect(cols[3]?.[1]).toBe('integer');
    expect(cols[1]?.[2]).toBe('NO');
    const idx = await rows("SELECT indexdef FROM pg_indexes WHERE indexname = 'people_age_idx'");
    expect(String(idx[0]?.[0])).toContain('WHERE (age > 0)');

    // drop it again, plus a failing batch must leave everything untouched.
    const dropIdx = buildAlterPlan('public', 'people', [
      { kind: 'dropIndex', schema: 'public', name: 'people_age_idx', concurrently: true },
    ]);
    expect((await driver.applyDdl({ connectionGen: gen, ...dropIdx })).error).toBeUndefined();

    const bad = await driver.applyDdl({
      connectionGen: gen,
      transactional: [
        'ALTER TABLE public.people DROP COLUMN age',
        'ALTER TABLE public.people DROP COLUMN nope',
      ],
      concurrent: [],
    });
    expect(bad.error?.index).toBe(1);
    const still = await rows(
      "SELECT 1 FROM information_schema.columns WHERE table_name='people' AND column_name='age'",
    );
    expect(still).toHaveLength(1);
  });

  it('imports CSV, streaming thousands of rows in one transaction', async () => {
    await driver.applyDdl({
      connectionGen: gen,
      transactional: [
        'ALTER TABLE public.people DROP COLUMN "Weird Col"',
        'ALTER TABLE public.people DROP COLUMN age',
      ],
      concurrent: [],
    });
    const body = Array.from({ length: 7000 }, (_, i) => `${i + 1},"Name, ${i + 1}"`).join('\n');
    const filePath = join(dir, 'people.csv');
    writeFileSync(filePath, `id,name\n${body}\n`);
    const res = await driver.runImport(job({ filePath }), noHooks);
    expect(res).toMatchObject({ ok: true, rowsImported: 7000 });
    expect((await rows('SELECT count(*) FROM public.people'))[0]?.[0]).toBe('7000');
    expect((await rows('SELECT full_name FROM public.people WHERE id = 42'))[0]?.[0]).toBe(
      'Name, 42',
    );
  });

  it('rolls back on a bad row and names it', async () => {
    const filePath = join(dir, 'bad.csv');
    writeFileSync(filePath, 'id,name\n9001,ok\n9002,ok\nnotanint,x\n9004,ok\n');
    const res = await driver.runImport(job({ filePath }), noHooks);
    expect(res.ok).toBe(false);
    // File line numbers (the header is line 1), so they match an editor (P2-17).
    expect(res.error?.row).toBe(4);
    expect(res.error?.message).toMatch(/integer/);
    expect((await rows('SELECT count(*) FROM public.people WHERE id > 9000'))[0]?.[0]).toBe('0');
    // duplicate keys inside a single batch are located too
    writeFileSync(filePath, 'id,name\n9001,a\n9002,b\n9001,c\n');
    const dup = await driver.runImport(job({ filePath }), noHooks);
    expect(dup.error?.row).toBe(4);
  });

  it('creates a new table from a file (types inferred) inside the import transaction', async () => {
    const filePath = join(dir, 'events.ndjson');
    writeFileSync(
      filePath,
      '{"id":1,"at":"2024-01-01T00:00:00Z","meta":{"a":1}}\n{"id":2,"at":"2024-02-01T00:00:00Z","meta":null}\n',
    );
    const pre = buildCreateTable({
      schema: 'public',
      name: 'events',
      columns: [
        { name: 'id', type: 'integer', nullable: true },
        { name: 'at', type: 'timestamptz', nullable: true },
        { name: 'meta', type: 'jsonb', nullable: true },
      ],
    });
    const res = await driver.runImport(
      job({
        format: 'ndjson',
        table: 'events',
        filePath,
        csv: undefined,
        preStatements: pre,
        columns: [
          { target: 'id', source: 'id' },
          { target: 'at', source: 'at' },
          { target: 'meta', source: 'meta' },
        ],
      }),
      noHooks,
    );
    expect(res).toMatchObject({ ok: true, rowsImported: 2 });
    expect((await rows("SELECT meta->>'a' FROM public.events WHERE id = 1"))[0]?.[0]).toBe('1');
    expect((await rows('SELECT meta IS NULL FROM public.events WHERE id = 2'))[0]?.[0]).toBe(true);
  });

  it('runs a .sql file, and rolls all of it back when a statement fails', async () => {
    const good = join(dir, 'good.sql');
    writeFileSync(
      good,
      'BEGIN;\nCREATE TABLE public.from_sql (a int);\nINSERT INTO public.from_sql VALUES (1), (2);\nCOMMIT;\n',
    );
    const ok = await driver.runImport(
      job({ format: 'sql', filePath: good, columns: [], csv: undefined }),
      noHooks,
    );
    expect(ok).toMatchObject({ ok: true, statements: 2 });
    const bad = join(dir, 'bad.sql');
    writeFileSync(
      bad,
      'INSERT INTO public.from_sql VALUES (3);\nINSERT INTO public.nope VALUES (4);\n',
    );
    const fail = await driver.runImport(
      job({ format: 'sql', filePath: bad, columns: [], csv: undefined }),
      noHooks,
    );
    expect(fail.error?.row).toBe(2);
    expect((await rows('SELECT count(*) FROM public.from_sql'))[0]?.[0]).toBe('2');
  });

  it('cancels mid-import and keeps nothing', async () => {
    const filePath = join(dir, 'big.csv');
    writeFileSync(
      filePath,
      `id,name\n${Array.from({ length: 5000 }, (_, i) => `${100000 + i},n`).join('\n')}\n`,
    );
    let n = 0;
    const res = await driver.runImport(job({ filePath, batchRows: 100 }), {
      isCancelled: () => ++n > 2,
      onProgress: () => {},
    });
    expect(res.cancelled).toBe(true);
    expect((await rows('SELECT count(*) FROM public.people WHERE id >= 100000'))[0]?.[0]).toBe('0');
  });
});
