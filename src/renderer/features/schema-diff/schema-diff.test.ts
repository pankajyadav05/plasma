import type { SchemaInfo } from '@shared/protocol';
import { describe, expect, it } from 'vitest';
import { buildMigration, computeDiff, summary } from './schema-diff';

type Col = SchemaInfo['columns'][number];

function col(
  schema: string,
  table: string,
  name: string,
  dataType: string,
  ordinal: number,
  extra: Partial<Col> = {},
): Col {
  return {
    schema,
    table,
    name,
    dataType,
    ordinal,
    isPrimaryKey: false,
    isNullable: true,
    hasDefault: false,
    ...extra,
  };
}

function schema(partial: Partial<SchemaInfo>): SchemaInfo {
  return {
    schemas: [{ name: 'public' }],
    tables: [],
    columns: [],
    foreignKeys: [],
    routines: [],
    sequences: [],
    types: [],
    extensions: [],
    ...partial,
  };
}

const rel = (name: string, kind: SchemaInfo['tables'][number]['kind'] = 'table', s = 'public') => ({
  schema: s,
  name,
  kind,
  rowCountEstimate: null,
});

describe('schema diff migration (R-10)', () => {
  it('drops views and matviews with the right verb, never DROP TABLE', () => {
    const a = schema({
      tables: [rel('v1', 'view'), rel('m1', 'matview'), rel('f1', 'foreign'), rel('t1')],
    });
    const b = schema({});
    const sql = buildMigration(computeDiff(a, b), b);
    expect(sql).toContain('DROP VIEW public.v1;');
    expect(sql).toContain('DROP MATERIALIZED VIEW public.m1;');
    expect(sql).toContain('DROP FOREIGN TABLE public.f1;');
    expect(sql).toContain('DROP TABLE public.t1;');
    expect(sql).not.toContain('DROP TABLE public.v1');
    expect(sql).toMatch(/^-- WARNING/);
    // dependents (views) are dropped before the table
    expect(sql.indexOf('DROP VIEW')).toBeLessThan(sql.indexOf('DROP TABLE public.t1'));
  });

  it('generates a real CREATE TABLE with columns, PK, FKs and indexes', () => {
    const a = schema({
      tables: [rel('users')],
      columns: [
        col('public', 'users', 'id', 'integer', 1, { isPrimaryKey: true, isNullable: false }),
      ],
    });
    const b = schema({
      tables: [rel('users'), rel('orders')],
      columns: [
        col('public', 'users', 'id', 'integer', 1, { isPrimaryKey: true, isNullable: false }),
        col('public', 'orders', 'id', 'integer', 1, {
          isPrimaryKey: true,
          isNullable: false,
          hasDefault: true,
          defaultExpr: "nextval('orders_id_seq'::regclass)",
        }),
        col('public', 'orders', 'user_id', 'integer', 2, { isNullable: false }),
        col('public', 'orders', 'status', 'text', 3, {
          hasDefault: true,
          defaultExpr: "'new'::text",
        }),
        col('public', 'orders', 'total', 'numeric(10,2)', 4),
      ],
      foreignKeys: [
        {
          schema: 'public',
          table: 'orders',
          column: 'user_id',
          refSchema: 'public',
          refTable: 'users',
          refColumn: 'id',
          constraint: 'orders_user_id_fkey',
          onDelete: 'CASCADE',
          onUpdate: 'NO ACTION',
        },
      ],
      indexes: [
        {
          schema: 'public',
          table: 'orders',
          name: 'orders_pkey',
          definition: 'CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)',
          unique: true,
          primary: true,
        },
        {
          schema: 'public',
          table: 'orders',
          name: 'orders_status_idx',
          definition: 'CREATE INDEX orders_status_idx ON public.orders USING btree (status)',
          unique: false,
          primary: false,
        },
      ],
    });
    const sql = buildMigration(computeDiff(a, b), b);
    expect(sql).not.toContain('TODO');
    expect(sql).toContain('CREATE TABLE public.orders (');
    expect(sql).toContain('id serial NOT NULL');
    expect(sql).not.toContain('nextval');
    expect(sql).toContain('user_id integer NOT NULL');
    expect(sql).toContain("status text DEFAULT 'new'::text");
    expect(sql).toContain('total numeric(10,2)');
    expect(sql).toContain('PRIMARY KEY (id)');
    expect(sql).toContain(
      'ALTER TABLE public.orders ADD CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE CASCADE;',
    );
    expect(sql).toContain('CREATE INDEX orders_status_idx ON public.orders USING btree (status);');
    // primary key index is not re-created separately
    expect(sql).not.toContain('orders_pkey');
    // FKs/indexes come after every CREATE TABLE
    expect(sql.indexOf('ADD CONSTRAINT')).toBeGreaterThan(sql.lastIndexOf('CREATE TABLE'));
  });

  it('groups composite foreign keys by constraint name', () => {
    const b = schema({
      tables: [rel('a'), rel('b')],
      columns: [
        col('public', 'a', 'x', 'integer', 1, { isPrimaryKey: true, isNullable: false }),
        col('public', 'a', 'y', 'integer', 2, { isPrimaryKey: true, isNullable: false }),
        col('public', 'b', 'ax', 'integer', 1),
        col('public', 'b', 'ay', 'integer', 2),
        col('public', 'b', 'bx', 'integer', 3),
      ],
      foreignKeys: [
        {
          schema: 'public',
          table: 'b',
          column: 'ax',
          refSchema: 'public',
          refTable: 'a',
          refColumn: 'x',
          constraint: 'b_fk',
        },
        {
          schema: 'public',
          table: 'b',
          column: 'ay',
          refSchema: 'public',
          refTable: 'a',
          refColumn: 'y',
          constraint: 'b_fk',
        },
        {
          schema: 'public',
          table: 'b',
          column: 'bx',
          refSchema: 'public',
          refTable: 'a',
          refColumn: 'x',
          constraint: 'b_other',
        },
      ],
    });
    const sql = buildMigration(computeDiff(schema({}), b), b);
    expect(sql).toContain('FOREIGN KEY (ax, ay) REFERENCES public.a (x, y)');
    expect(sql).toContain('FOREIGN KEY (bx) REFERENCES public.a (x)');
  });

  it('does not invent SQL for added views; it says what to do', () => {
    const b = schema({ tables: [rel('v', 'view')] });
    const sql = buildMigration(computeDiff(schema({}), b), b);
    expect(sql).toContain('view public.v was added');
    expect(sql).not.toMatch(/CREATE (OR REPLACE )?VIEW/);
  });

  it('handles names containing dots and quotes', () => {
    const a = schema({ tables: [rel('my.table', 'view', 'we.ird')] });
    const sql = buildMigration(computeDiff(a, schema({})), schema({}));
    expect(sql).toContain('DROP VIEW "we.ird"."my.table";');
  });

  it('skips column ALTERs for views and leaves a note', () => {
    const a = schema({
      tables: [rel('v', 'view')],
      columns: [col('public', 'v', 'a', 'integer', 1)],
    });
    const b = schema({
      tables: [rel('v', 'view')],
      columns: [col('public', 'v', 'a', 'integer', 1), col('public', 'v', 'b', 'text', 2)],
    });
    const sql = buildMigration(computeDiff(a, b), b);
    expect(sql).not.toContain('ALTER TABLE');
    expect(sql).toContain('view public.v changed (+b)');
  });

  it('alters columns on tables as before', () => {
    const a = schema({
      tables: [rel('t')],
      columns: [col('public', 't', 'a', 'integer', 1), col('public', 't', 'old', 'text', 2)],
    });
    const b = schema({
      tables: [rel('t')],
      columns: [
        col('public', 't', 'a', 'bigint', 1, { isNullable: false }),
        col('public', 't', 'new', 'text', 2, { isNullable: false }),
      ],
    });
    const sql = buildMigration(computeDiff(a, b), b);
    expect(sql).toContain('ALTER TABLE public.t ADD COLUMN new text NOT NULL;');
    expect(sql).toContain('ALTER TABLE public.t DROP COLUMN old;');
    expect(sql).toContain('ALTER TABLE public.t ALTER COLUMN a TYPE bigint; -- was integer');
    expect(sql).toContain('ALTER TABLE public.t ALTER COLUMN a SET NOT NULL;');
  });

  it('drops and re-creates a relation whose kind changed', () => {
    const a = schema({
      tables: [rel('x', 'table')],
      columns: [col('public', 'x', 'a', 'integer', 1)],
    });
    const b = schema({ tables: [rel('x', 'view')] });
    const d = computeDiff(a, b);
    expect(d.kindChanges).toEqual([{ schema: 'public', name: 'x', from: 'table', to: 'view' }]);
    const sql = buildMigration(d, b);
    expect(sql).toContain('DROP TABLE public.x;');
    expect(sql).toContain('view public.x was added');
  });

  it('emits identity columns', () => {
    const b = schema({
      tables: [rel('t')],
      columns: [
        col('public', 't', 'id', 'bigint', 1, {
          isPrimaryKey: true,
          isNullable: false,
          identity: 'always',
        }),
      ],
    });
    expect(buildMigration(computeDiff(schema({}), b), b)).toContain(
      'id bigint NOT NULL GENERATED ALWAYS AS IDENTITY',
    );
  });

  it('summarises by kind', () => {
    const a = schema({ tables: [rel('v', 'view')] });
    const b = schema({ tables: [rel('t')] });
    expect(summary(computeDiff(a, b))).toBe('+1 table · -1 view');
    expect(summary(computeDiff(a, a))).toBe('no changes');
  });
});
