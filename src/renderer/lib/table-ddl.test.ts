import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { buildTableDdlSql, composeTableDdl } from './table-ddl';

describe('composeTableDdl', () => {
  it('composes a view from pg_get_viewdef instead of CREATE TABLE', () => {
    const ddl = composeTableDdl('public', 'v', [
      ['rel', 0, 'v', 'app', 'p', ''],
      ['viewdef', 0, ' SELECT t.id\n   FROM t;', null, null, null],
      ['col', 1, 'id', 'integer', '', null],
    ]);
    expect(ddl).toContain('CREATE OR REPLACE VIEW "public"."v" AS\n SELECT t.id\n   FROM t;');
    expect(ddl).not.toContain('CREATE TABLE');
    expect(ddl).toContain('ALTER VIEW "public"."v" OWNER TO "app";');
  });

  it('composes a table with identity, constraints, indexes, triggers and comments', () => {
    const ddl = composeTableDdl('s', 't', [
      ['rel', 0, 'r', 'o', 'p', 'on'],
      ['col', 1, 'id', 'integer', 'GENERATED ALWAYS AS IDENTITY NOT NULL', null],
      ['col', 2, 'a', 'text', "DEFAULT 'x'::text", "it's"],
      ['con', 1, 't_pkey', 'PRIMARY KEY (id)', 'p', null],
      ['idx', 0, 't_a_idx', 'CREATE INDEX t_a_idx ON s.t USING btree (a)', null, null],
      [
        'trg',
        0,
        'trg',
        'CREATE TRIGGER trg BEFORE INSERT ON s.t FOR EACH ROW EXECUTE FUNCTION f()',
        null,
        null,
      ],
      ['cmt', 0, 'the table', null, null, null],
    ]);
    expect(ddl).toContain('"id" integer GENERATED ALWAYS AS IDENTITY NOT NULL');
    expect(ddl).toContain('CONSTRAINT "t_pkey" PRIMARY KEY (id)');
    expect(ddl).toContain('CREATE INDEX t_a_idx ON s.t USING btree (a);');
    expect(ddl).toContain('CREATE TRIGGER trg BEFORE INSERT');
    expect(ddl).toContain(`COMMENT ON COLUMN "s"."t"."a" IS 'it''s';`);
    expect(ddl).toContain(`COMMENT ON TABLE "s"."t" IS 'the table';`);
    expect(ddl).toContain('ENABLE ROW LEVEL SECURITY');
  });
});

const url = process.env.PLASMA_LIVE_PG;
(url ? describe : describe.skip)('buildTableDdlSql (live)', () => {
  it('runs against a real catalog for tables, views and matviews', async () => {
    const c = new pg.Client(url);
    await c.connect();
    try {
      await c.query(`CREATE TEMP TABLE ddl_t (
        id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        a text COLLATE "C" DEFAULT 'x' NOT NULL,
        b int GENERATED ALWAYS AS (id * 2) STORED,
        u int UNIQUE CHECK (u > 0))`);
      await c.query('CREATE INDEX ON ddl_t (a)');
      await c.query("COMMENT ON COLUMN ddl_t.a IS 'col'");
      await c.query('CREATE TEMP VIEW ddl_v AS SELECT id FROM ddl_t');
      const schema = (
        await c.query('SELECT nspname FROM pg_namespace WHERE oid = pg_my_temp_schema()')
      ).rows[0].nspname;
      const run = async (name: string) => {
        const { sql, params } = buildTableDdlSql(schema, name);
        const res = await c.query({ text: sql, values: params, rowMode: 'array' });
        return composeTableDdl(schema, name, res.rows);
      };
      const t = await run('ddl_t');
      expect(t).toMatch(/"id" integer GENERATED ALWAYS AS IDENTITY NOT NULL/);
      expect(t).toMatch(/"a" text COLLATE "C" DEFAULT 'x'::text NOT NULL/);
      expect(t).toMatch(/GENERATED ALWAYS AS \(+id \* 2\)+ STORED/);
      expect(t).toMatch(/CONSTRAINT "ddl_t_pkey" PRIMARY KEY \(id\)/);
      expect(t).toMatch(/CREATE INDEX ddl_t_a_idx/);
      expect(t).toMatch(/COMMENT ON COLUMN .*"a" IS 'col'/);
      const v = await run('ddl_v');
      expect(v).toMatch(/CREATE OR REPLACE VIEW .* AS\n SELECT id\n\s+FROM ddl_t;/);
    } finally {
      await c.end();
    }
  });
});
