/**
 * Live introspection check against a real Postgres. Opt-in:
 *   PLASMA_LIVE_PG=postgres://postgres:postgres@127.0.0.1:5432/<scratch db> pnpm vitest run <this file>
 * Creates and drops its own `plasma_introspect_test` schema.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { plasmaPgTypes } from './pg-type-parsers';
import { introspectPostgres } from './postgres-introspect';

const url = process.env.PLASMA_LIVE_PG;
const S = 'plasma_introspect_test';

describe.skipIf(!url)('introspectPostgres (live)', () => {
  // Same type parsers as the app's clients, so text-form arrays are caught.
  const client = new pg.Client({ connectionString: url, types: plasmaPgTypes });

  beforeAll(async () => {
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S};
      CREATE TABLE ${S}.users (id serial PRIMARY KEY, email text NOT NULL);
      CREATE TABLE ${S}.orders (id int PRIMARY KEY, user_id int REFERENCES ${S}.users(id));
      CREATE TABLE ${S}.events (id int, at date) PARTITION BY RANGE (at);
      CREATE TABLE ${S}.events_2025 PARTITION OF ${S}.events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
      CREATE VIEW ${S}.v AS SELECT id FROM ${S}.users;
      CREATE FUNCTION ${S}.add(a int, b int) RETURNS int LANGUAGE sql AS 'SELECT a + b';
      CREATE PROCEDURE ${S}.noop() LANGUAGE sql AS 'SELECT 1';
      CREATE SEQUENCE ${S}.counter;
      CREATE TYPE ${S}.mood AS ENUM ('sad', 'ok');
      CREATE TYPE ${S}.pair AS (a int, b text);
      CREATE DOMAIN ${S}.pos AS int CHECK (VALUE > 0);`);
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await client.end();
  });

  it('lists objects with partitions, routines, sequences and types', async () => {
    const info = await introspectPostgres(client, { columns: false });
    expect(info.columns).toEqual([]);
    expect(info.schemas.map((s) => s.name)).toContain(S);
    const tables = info.tables.filter((t) => t.schema === S);
    expect(tables.find((t) => t.name === 'events_2025')?.partitionOf).toEqual({
      schema: S,
      name: 'events',
    });
    expect(tables.find((t) => t.name === 'users')?.partitionOf).toBeNull();
    expect(tables.find((t) => t.name === 'events')?.kind).toBe('partitioned');
    const routines = info.routines.filter((r) => r.schema === S);
    expect(routines).toEqual([
      expect.objectContaining({
        name: 'add',
        kind: 'function',
        args: 'a integer, b integer',
        returns: 'integer',
      }),
      expect.objectContaining({ name: 'noop', kind: 'procedure', returns: null }),
    ]);
    const seqs = info.sequences
      .filter((s) => s.schema === S)
      .map((s) => s.name)
      .sort();
    expect(seqs).toEqual(['counter', 'users_id_seq']);
    const types = info.types.filter((t) => t.schema === S);
    expect(types).toEqual([
      { schema: S, name: 'mood', kind: 'enum', values: ['sad', 'ok'] },
      { schema: S, name: 'pair', kind: 'composite' },
      { schema: S, name: 'pos', kind: 'domain' },
    ]);
    expect(info.extensions.some((e) => e.name === 'plpgsql')).toBe(true);
  });

  it('loads columns and FKs for selected schemas only', async () => {
    const info = await introspectPostgres(client, { objects: false, columnSchemas: [S] });
    expect(info.tables).toEqual([]);
    expect(new Set(info.columns.map((c) => c.schema))).toEqual(new Set([S]));
    expect(info.columns.find((c) => c.table === 'users' && c.name === 'id')?.isPrimaryKey).toBe(
      true,
    );
    expect(info.foreignKeys).toEqual([
      {
        schema: S,
        table: 'orders',
        column: 'user_id',
        refSchema: S,
        refTable: 'users',
        refColumn: 'id',
        constraint: 'orders_user_id_fkey',
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
      },
    ]);
    // R-10: defaults, identity and indexes travel with the snapshot.
    const idCol = info.columns.find((c) => c.table === 'users' && c.name === 'id');
    expect(idCol?.defaultExpr).toMatch(/^nextval\(/);
    expect(info.indexes?.filter((i) => i.schema === S && i.table === 'orders')).toEqual([
      expect.objectContaining({ name: 'orders_pkey', primary: true, unique: true }),
    ]);
    const none = await introspectPostgres(client, { objects: false, columnSchemas: [] });
    expect(none.columns).toEqual([]);
  });

  it('keeps the full snapshot by default', async () => {
    const info = await introspectPostgres(client);
    expect(info.tables.length).toBeGreaterThan(0);
    expect(info.columns.some((c) => c.schema === S)).toBe(true);
  });
});
