/**
 * Live check of the grid's FK navigation against a real Postgres: incoming
 * FKs come from the real introspection, and the count / peek SQL runs.
 *   PLASMA_LIVE_PG=postgres://postgres@127.0.0.1:5503/plasma_c pnpm vitest run src/workers/drivers/postgres.fk-nav.live.test.ts
 * Creates and drops its own `plasma_fknav_test` schema.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INCOMING_COUNT_CAP,
  buildIncomingCountSql,
  buildPeekSql,
  incomingFks,
  incomingRequestsForRow,
  lookupForRow,
  outgoingFks,
  parseIncomingCounts,
} from '../../shared/fk-nav';
import { plasmaPgTypes } from './pg-type-parsers';
import { introspectPostgres } from './postgres-introspect';

const url = process.env.PLASMA_LIVE_PG;
const S = 'plasma_fknav_test';

describe.skipIf(!url)('FK navigation (live)', () => {
  const client = new pg.Client({ connectionString: url, types: plasmaPgTypes });
  let foreignKeys: Awaited<ReturnType<typeof introspectPostgres>>['foreignKeys'];

  beforeAll(async () => {
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S};
      CREATE TABLE ${S}.users (id serial PRIMARY KEY, name text);
      CREATE TABLE ${S}.orders (
        id int PRIMARY KEY,
        user_id int REFERENCES ${S}.users(id),
        approver_id int REFERENCES ${S}.users(id));
      CREATE TABLE ${S}.order_items (id serial PRIMARY KEY, order_id int REFERENCES ${S}.orders(id));
      CREATE TABLE ${S}.pairs (a int, b text, PRIMARY KEY (a, b));
      CREATE TABLE ${S}.ledger (
        id serial PRIMARY KEY, pa int, pb text,
        FOREIGN KEY (pa, pb) REFERENCES ${S}.pairs (a, b));
      CREATE TABLE ${S}."we""ird" ("pk""col" int PRIMARY KEY);
      CREATE TABLE ${S}."kid""s" (id serial PRIMARY KEY, "c""ol" int REFERENCES ${S}."we""ird"("pk""col"));

      INSERT INTO ${S}.users (name) VALUES ('ann'), ('bob'), ('cy');
      INSERT INTO ${S}.orders VALUES (10, 1, 2), (11, 1, NULL), (12, 2, 1);
      INSERT INTO ${S}.order_items (order_id) VALUES (10), (10), (11), (12);
      INSERT INTO ${S}.pairs VALUES (1, 'x'), (1, 'y');
      INSERT INTO ${S}.ledger (pa, pb) VALUES (1, 'x'), (1, 'x'), (1, 'y');
      INSERT INTO ${S}."we""ird" VALUES (5);
      INSERT INTO ${S}."kid""s" ("c""ol") VALUES (5), (5);`);
    const info = await introspectPostgres(client, { columnSchemas: [S] });
    foreignKeys = info.foreignKeys;
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await client.end();
  });

  const countsFor = async (table: string, columns: string[], row: unknown[]) => {
    const groups = incomingFks(foreignKeys, S, table);
    const requests = incomingRequestsForRow(
      groups,
      columns.map((name) => ({ name, dataTypeName: 'text' })),
      row,
      (v) => (v === null || v === undefined ? null : String(v)),
    );
    const { sql, params } = buildIncomingCountSql(requests);
    const res = await client.query({ text: sql, values: params, rowMode: 'array' });
    const parsed = parseIncomingCounts(res.rows[0] ?? [], requests.length);
    return requests.map((r, i) => ({
      from: `${r.group.table}.${r.group.pairs.map((p) => p.column).join(',')}`,
      count: parsed[i]?.count,
      capped: parsed[i]?.capped,
    }));
  };

  it('finds every incoming FK of users, one per constraint', () => {
    const groups = incomingFks(foreignKeys, S, 'users');
    expect(groups.map((g) => `${g.table}.${g.pairs[0]?.column}`).sort()).toEqual([
      'orders.approver_id',
      'orders.user_id',
    ]);
  });

  it('counts the rows referencing a user, per foreign key', async () => {
    const counts = await countsFor('users', ['id', 'name'], ['1', 'ann']);
    expect(counts.sort((a, b) => a.from.localeCompare(b.from))).toEqual([
      { from: 'orders.approver_id', count: 1, capped: false }, // order 12
      { from: 'orders.user_id', count: 2, capped: false }, // orders 10, 11
    ]);
    const none = await countsFor('users', ['id', 'name'], ['3', 'cy']);
    expect(none.every((c) => c.count === 0)).toBe(true);
  });

  it('follows a chain: order -> order_items', async () => {
    expect(await countsFor('orders', ['id'], ['10'])).toEqual([
      { from: 'order_items.order_id', count: 2, capped: false },
    ]);
  });

  it('matches composite keys on every column', async () => {
    expect(await countsFor('pairs', ['a', 'b'], ['1', 'x'])).toEqual([
      { from: 'ledger.pa,pb', count: 2, capped: false },
    ]);
    expect(await countsFor('pairs', ['a', 'b'], ['1', 'y'])).toEqual([
      { from: 'ledger.pa,pb', count: 1, capped: false },
    ]);
  });

  it('survives identifiers with quotes', async () => {
    expect(await countsFor('we"ird', ['pk"col'], ['5'])).toEqual([
      { from: 'kid"s.c"ol', count: 2, capped: false },
    ]);
  });

  it('caps huge counts instead of scanning everything', async () => {
    await client.query(
      `INSERT INTO ${S}.order_items (order_id) SELECT 12 FROM generate_series(1, ${INCOMING_COUNT_CAP + 50})`,
    );
    const [c] = await countsFor('orders', ['id'], ['12']);
    expect(c).toEqual({ from: 'order_items.order_id', count: INCOMING_COUNT_CAP, capped: true });
  });

  it('skips a NULL referenced value instead of matching it', async () => {
    const groups = incomingFks(foreignKeys, S, 'users');
    expect(
      incomingRequestsForRow(groups, [{ name: 'id', dataTypeName: 'int4' }], [null], (v) =>
        v === null ? null : String(v),
      ),
    ).toEqual([]);
  });

  it('peeks the referenced row (outgoing FK, composite too)', async () => {
    const [toUsers] = outgoingFks(foreignKeys, S, 'orders').filter(
      (g) => g.pairs[0]?.column === 'user_id',
    );
    const lookup = lookupForRow(toUsers!, 'outgoing', (c) => ({ user_id: '2' })[c as 'user_id']);
    const { sql, params } = buildPeekSql(toUsers!.refSchema, toUsers!.refTable, lookup!);
    const res = await client.query({ text: sql, values: params, rowMode: 'array' });
    expect(res.rows).toEqual([[2, 'bob']]);

    const [toPairs] = outgoingFks(foreignKeys, S, 'ledger');
    const pairLookup = lookupForRow(toPairs!, 'outgoing', (c) => ({ pa: '1', pb: 'y' })[c as 'pa']);
    const q = buildPeekSql(toPairs!.refSchema, toPairs!.refTable, pairLookup!);
    expect((await client.query({ text: q.sql, values: q.params, rowMode: 'array' })).rows).toEqual([
      [1, 'y'],
    ]);
  });
});
