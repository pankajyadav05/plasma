import { cellToText } from '@shared/cell-edit';
import type { GuardValue } from '@shared/edit-guard';
import type { ConnectionConfig } from '@shared/protocol';
import { POSTGRES_DIALECT } from '@shared/sql-dialect';
import { buildDeleteSql, buildUpdateSql } from '@shared/table-query';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDriver } from './postgres';

/**
 * Opt-in live checks (B1): a second client changes a row between "the grid
 * loaded it" and "the user committed". The originals are produced exactly as
 * the grid produces them (driver value -> cellToText), so a column type whose
 * text form does not round-trip through the guard shows up here as a false
 * conflict.
 *
 *   PLASMA_LIVE_PG=postgres://postgres@127.0.0.1:5496/postgres pnpm vitest run \
 *     src/workers/drivers/postgres.edit-conflicts.live.test.ts
 *
 * Skipped when PLASMA_LIVE_PG is unset. Uses a scratch database.
 */
const url = process.env.PLASMA_LIVE_PG;
const suite = url ? describe : describe.skip;
const scratch = `plasma_conflicts_${Math.random().toString(36).slice(2, 10)}`;

function configFor(raw: string, database: string): ConnectionConfig {
  const u = new URL(raw);
  return {
    id: `live-${database}`,
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

// column -> [type name as the driver reports it is read from the result; new value]
const TYPED: Array<[string, string, string]> = [
  ['i', 'int4', '8'],
  ['big', 'int8', '9007199254740993'],
  ['n', 'numeric', '2.50'],
  ['f', 'float8', '0.30000000000000004'],
  ['r', 'float4', '1.1'],
  ['t', 'text', 'new text 😀'],
  ['b', 'bool', 'false'],
  ['d', 'date', '2026-02-02'],
  ['ts', 'timestamp', '2026-02-02 10:11:12.5'],
  ['tz', 'timestamptz', '2026-02-02 10:11:12+00'],
  ['u', 'uuid', '11111111-1111-1111-1111-111111111111'],
  ['jb', 'jsonb', '{"z": [1, 2]}'],
  ['js', 'json', '{"z":  1}'],
  ['by', 'bytea', '\\xdeadbeef'],
  ['ia', '_int4', '{9,8}'],
  ['ta', '_text', '{"a b",NULL,"c,d"}'],
  ['iv', 'interval', '2 days 03:00:00'],
  ['en', 'mood', 'sad'],
  ['nul', 'text', 'was null'],
];

suite('postgres concurrent-edit detection (live)', () => {
  const drv = new PostgresDriver();
  let admin: pg.Client;
  let other: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${scratch}`);
    const u = new URL(url as string);
    u.pathname = `/${scratch}`;
    other = new pg.Client({ connectionString: u.toString() });
    await other.connect();
    await other.query(`
      CREATE TYPE mood AS ENUM ('happy', 'sad');
      CREATE TABLE wide (
        id int PRIMARY KEY, i int, big bigint, n numeric(10,2), f float8, r float4, t text,
        b bool, d date, ts timestamp, tz timestamptz, u uuid, jb jsonb, js json, by bytea,
        ia int[], ta text[], iv interval, en mood, nul text, pt point
      );
      INSERT INTO wide VALUES (1, 7, 9007199254740992, 1.25, 0.1, 1.5, 'old text', true,
        '2026-01-01', '2026-01-01 00:00:00.123456', '2026-01-01 00:00:00+00',
        '00000000-0000-0000-0000-000000000000', '{"a":1}', '{"a":  1}', '\\x0001',
        '{1,2}', '{x,"y z"}', '1 day', 'happy', NULL, '(1,2)');
      CREATE TABLE kv (a int, b int, v text, PRIMARY KEY (a, b));
      INSERT INTO kv VALUES (1, 1, 'one'), (1, 2, 'two'), (2, 1, 'three');
      CREATE TABLE people (id int PRIMARY KEY, name text UNIQUE);
      INSERT INTO people VALUES (1, 'ada'), (2, 'bob');
    `);
    await drv.connect(configFor(url as string, scratch), 0);
    drv.setConnectionGen(1);
  });

  afterAll(async () => {
    await drv.disconnect().catch(() => {});
    await other?.end().catch(() => {});
    await admin?.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`).catch(() => {});
    await admin?.end().catch(() => {});
  });

  /** What the grid holds for `table` row `where`: result columns + raw row. */
  async function load(table: string, where: string) {
    const res = await drv.query(`SELECT * FROM ${table} WHERE ${where}`);
    return { columns: res.columns, row: res.rows[0] as unknown[] };
  }

  async function updateStatement(
    table: string,
    pk: Record<string, string>,
    where: string,
    column: string,
    newValue: string | null,
  ) {
    const { columns, row } = await load(table, where);
    const idx = columns.findIndex((c) => c.name === column);
    const guard: GuardValue = {
      column,
      value: cellToText(row[idx], columns[idx]?.dataTypeName),
      type: columns[idx]?.dataTypeName,
    };
    const { sql, params } = buildUpdateSql({
      schema: 'public',
      table,
      set: { [column]: newValue },
      pkValues: pk,
      guards: [guard],
      dialect: POSTGRES_DIALECT,
    });
    return { sql, params: params as unknown[], kind: 'update' as const };
  }

  for (const [column, , next] of TYPED) {
    it(`${column}: an unchanged column commits; a column someone else changed conflicts`, async () => {
      const ok = await updateStatement('wide', { id: '1' }, 'id = 1', column, next);
      const first = await drv.commitEditBatch(1, [ok]);
      expect(first.conflicts, `false conflict on ${column}`).toEqual([]);
      expect(first.applied).toBe(1);

      // Someone else changes the same column after the grid loaded it.
      const stale = await updateStatement('wide', { id: '1' }, 'id = 1', column, next);
      const swap: Record<string, string> = {
        i: '100',
        big: '1',
        n: '9.99',
        f: '1.5',
        r: '2.5',
        t: 'theirs',
        b: 'true',
        d: '1999-09-09',
        ts: '1999-09-09 09:09:09',
        tz: '1999-09-09 09:09:09+00',
        u: '22222222-2222-2222-2222-222222222222',
        jb: '{"theirs":true}',
        js: '{"theirs":true}',
        by: '\\xff',
        ia: '{0}',
        ta: '{theirs}',
        iv: '9 days',
        en: 'happy',
        nul: 'theirs',
      };
      await other.query(`UPDATE wide SET ${column} = $1 WHERE id = 1`, [swap[column]]);
      const second = await drv.commitEditBatch(1, [stale]);
      expect(second.applied).toBe(0);
      expect(second.conflicts).toEqual([{ index: 0, reason: 'no-match' }]);
    });
  }

  it('NULL original: IS NOT DISTINCT FROM matches NULL; a later value conflicts', async () => {
    await other.query('UPDATE wide SET nul = NULL WHERE id = 1');
    const stmt = await updateStatement('wide', { id: '1' }, 'id = 1', 'nul', 'mine');
    expect(stmt.params).toContain(null);
    await other.query("UPDATE wide SET nul = 'theirs' WHERE id = 1");
    const r = await drv.commitEditBatch(1, [stmt]);
    expect(r.conflicts).toHaveLength(1);
    await other.query('UPDATE wide SET nul = NULL WHERE id = 1');
    expect((await drv.commitEditBatch(1, [stmt])).conflicts).toEqual([]);
  });

  it('a changed column that the edit does not touch is not a conflict', async () => {
    const stmt = await updateStatement('wide', { id: '1' }, 'id = 1', 't', 'mine');
    await other.query('UPDATE wide SET i = i + 1 WHERE id = 1');
    expect((await drv.commitEditBatch(1, [stmt])).conflicts).toEqual([]);
  });

  it('composite keys: only the addressed row is touched, and its change is detected', async () => {
    const stmt = await updateStatement('kv', { a: '1', b: '2' }, 'a = 1 AND b = 2', 'v', 'mine');
    await other.query("UPDATE kv SET v = 'theirs' WHERE a = 1 AND b = 2");
    expect((await drv.commitEditBatch(1, [stmt])).conflicts).toHaveLength(1);
    const fresh = await updateStatement('kv', { a: '1', b: '2' }, 'a = 1 AND b = 2', 'v', 'mine');
    expect((await drv.commitEditBatch(1, [fresh])).applied).toBe(1);
    const rows = await other.query('SELECT a, b, v FROM kv ORDER BY a, b');
    expect(rows.rows.map((r) => r.v)).toEqual(['one', 'mine', 'three']);
  });

  it('the whole commit rolls back when one of several rows conflicts (no partial commit)', async () => {
    const s1 = await updateStatement('people', { id: '1' }, 'id = 1', 'name', 'ada-mine');
    const s2 = await updateStatement('people', { id: '2' }, 'id = 2', 'name', 'bob-mine');
    await other.query("UPDATE people SET name = 'bob-theirs' WHERE id = 2");
    const r = await drv.commitEditBatch(1, [s1, s2]);
    expect(r.applied).toBe(0);
    expect(r.conflicts).toEqual([{ index: 1, reason: 'no-match' }]);
    expect(drv.getTxnState()).toBe('none');
    const rows = await other.query('SELECT name FROM people ORDER BY id');
    expect(rows.rows.map((x) => x.name)).toEqual(['ada', 'bob-theirs']);
  });

  it('a DELETE of a row that changed or is already gone is a conflict; an unchanged one deletes', async () => {
    const del = async (id: number) => {
      const { columns, row } = await load('people', `id = ${id}`);
      const guards: GuardValue[] = columns.map((c, i) => ({
        column: c.name,
        value: cellToText(row[i], c.dataTypeName),
        type: c.dataTypeName,
      }));
      const { sql, params } = buildDeleteSql({
        schema: 'public',
        table: 'people',
        pkValues: { id: String(id) },
        guards,
        dialect: POSTGRES_DIALECT,
      });
      return { sql, params: params as unknown[], kind: 'delete' as const };
    };
    const stale = await del(1);
    await other.query("UPDATE people SET name = 'ada-changed' WHERE id = 1");
    expect((await drv.commitEditBatch(1, [stale])).conflicts).toHaveLength(1);
    const gone = await del(2);
    await other.query('DELETE FROM people WHERE id = 2');
    expect((await drv.commitEditBatch(1, [gone])).conflicts).toHaveLength(1);
    const fine = await del(1);
    expect((await drv.commitEditBatch(1, [fine])).applied).toBe(1);
    await other.query("INSERT INTO people VALUES (1, 'ada'), (2, 'bob')");
  });

  it('an INSERT with a key that now exists is reported as a duplicate; the rest rolls back', async () => {
    const s1 = await updateStatement('people', { id: '1' }, 'id = 1', 'name', 'first-mine');
    const r = await drv.commitEditBatch(1, [
      s1,
      {
        sql: 'INSERT INTO "public"."people" ("id", "name") VALUES ($1, $2)',
        params: ['2', 'dup'],
        kind: 'insert',
      },
    ]);
    expect(r.applied).toBe(0);
    expect(r.conflicts).toEqual([{ index: 1, reason: 'duplicate' }]);
    expect((await other.query('SELECT name FROM people WHERE id = 1')).rows[0].name).toBe('ada');
  });

  it('inside the user transaction a conflict rolls back to the savepoint and keeps the transaction', async () => {
    await drv.beginTransaction();
    await drv.query("UPDATE people SET name = 'in-txn' WHERE id = 2");
    const s1 = await updateStatement('people', { id: '1' }, 'id = 1', 'name', 'mine');
    await other.query("UPDATE people SET name = 'theirs' WHERE id = 1");
    const r = await drv.commitEditBatch(1, [s1]);
    expect(r.conflicts).toHaveLength(1);
    expect(r.state).toBe('active');
    expect((await drv.query('SELECT name FROM people WHERE id = 2')).rows[0]?.[0]).toBe('in-txn');
    await drv.rollbackTransaction();
    await other.query("UPDATE people SET name = 'ada' WHERE id = 1");
  });

  it('a type with no usable equality (point) is not compared, so it never blocks an edit', async () => {
    const { columns, row } = await load('wide', 'id = 1');
    const idx = columns.findIndex((c) => c.name === 'pt');
    const { sql, params } = buildUpdateSql({
      schema: 'public',
      table: 'wide',
      set: { pt: '(5,6)' },
      pkValues: { id: '1' },
      guards: [
        {
          column: 'pt',
          value: cellToText(row[idx], columns[idx]?.dataTypeName),
          type: columns[idx]?.dataTypeName,
        },
      ],
      dialect: POSTGRES_DIALECT,
    });
    expect(sql).not.toContain('IS NOT DISTINCT');
    const r = await drv.commitEditBatch(1, [{ sql, params: params as unknown[], kind: 'update' }]);
    expect(r.applied).toBe(1);
  });
});
