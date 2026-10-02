import type { ConnectionConfig } from '@shared/protocol';
import { type VariableValues, bindVariables, runBound } from '@shared/sql-variables';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDriver } from './postgres';

/**
 * Query variables against a real Postgres: values bind as parameters,
 * raw mode pastes, a parameter whose type Postgres can't infer is retried
 * with a literal, and EXPLAIN accepts the same parameters.
 *
 *   PLASMA_LIVE_PG=postgres://postgres@127.0.0.1:5502/postgres pnpm vitest run \
 *     src/workers/drivers/postgres.variables.live.test.ts
 */
const url = process.env.PLASMA_LIVE_PG;
const suite = url ? describe : describe.skip;

function configFrom(raw: string): ConnectionConfig {
  const u = new URL(raw);
  return {
    id: 'live-vars',
    name: 'live-vars',
    engine: 'postgres',
    host: u.hostname,
    port: Number(u.port || 5432),
    database: u.pathname.slice(1) || 'postgres',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl: false,
  } as ConnectionConfig;
}

const t = (value: string) => ({ mode: 'text' as const, value });

suite('query variables (live)', () => {
  const pg = new PostgresDriver();
  const run = (sql: string, values: VariableValues) =>
    runBound(sql, values, (text, params) => pg.query(text, params));

  beforeAll(async () => {
    await pg.connect(configFrom(url as string), 0);
    pg.setConnectionGen(1);
    await pg.query('DROP TABLE IF EXISTS plasma_vars_t');
    await pg.query(
      'CREATE TABLE plasma_vars_t (id int PRIMARY KEY, name text, born date, active boolean, score numeric)',
    );
    await pg.query(
      `INSERT INTO plasma_vars_t VALUES
        (1, 'ada', '1815-12-10', true, 9.5),
        (2, 'alan', '1912-06-23', true, 8),
        (3, 'o''brien', '1900-01-01', false, NULL)`,
    );
  });

  afterAll(async () => {
    await pg.query('DROP TABLE IF EXISTS plasma_vars_t');
    await pg.disconnect();
  });

  it('binds text, number, date and boolean values by column type', async () => {
    const r = await run(
      'SELECT id FROM plasma_vars_t WHERE name = :n AND id >= :min AND born > :d AND active = :a ORDER BY id',
      {
        n: t('alan'),
        min: { mode: 'number', value: '2' },
        d: { mode: 'date', value: '1900-01-01' },
        a: { mode: 'boolean', value: 'true' },
      },
    );
    expect(r.rows).toEqual([[2]]);
  });

  it('treats a hostile text value as data', async () => {
    const r = await run('SELECT count(*) FROM plasma_vars_t WHERE name = :n', {
      n: t("x'; DROP TABLE plasma_vars_t; --"),
    });
    expect(Number(r.rows[0]?.[0])).toBe(0);
    expect(Number((await pg.query('SELECT count(*) FROM plasma_vars_t')).rows[0]?.[0])).toBe(3);
  });

  it('matches a name with a quote through a bound parameter', async () => {
    const r = await run("SELECT id FROM plasma_vars_t WHERE name = :'n'", { n: t("o'brien") });
    expect(r.rows).toEqual([[3]]);
  });

  it('binds null (IS NOT DISTINCT FROM) and reuses one name for several placeholders', async () => {
    const r = await run(
      'SELECT id FROM plasma_vars_t WHERE score IS NOT DISTINCT FROM :s ORDER BY id',
      { s: { mode: 'null', value: '' } },
    );
    expect(r.rows).toEqual([[3]]);
    const twice = await run('SELECT :v::int + :v::int AS x', {
      v: { mode: 'number', value: '21' },
    });
    expect(twice.rows).toEqual([[42]]);
  });

  it('raw mode substitutes identifiers and expressions', async () => {
    const r = await run('SELECT :col FROM :tbl WHERE id = :id', {
      col: { mode: 'raw', value: 'name' },
      tbl: { mode: 'raw', value: 'public.plasma_vars_t' },
      id: { mode: 'number', value: '1' },
    });
    expect(r.rows).toEqual([['ada']]);
  });

  it('retries with a literal when the parameter type cannot be inferred', async () => {
    // `$1 IS NULL` fails with "could not determine data type of parameter $1".
    const sql = "SELECT :'x' IS NULL AS missing, :'x' AS echoed";
    const bound = bindVariables(sql, { x: t('hello') });
    await expect(pg.query(bound.sql, bound.params)).rejects.toThrow(
      /could not determine data type/,
    );
    const r = await run(sql, { x: t('hello') });
    expect(r.rows).toEqual([[false, 'hello']]);
  });

  it('does not touch ::casts, strings or comments', async () => {
    const r = await run("SELECT ':nope' AS s, :n::int AS n -- :ignored", {
      n: { mode: 'number', value: '7' },
    });
    expect(r.rows).toEqual([[':nope', 7]]);
  });

  it('EXPLAIN takes the same parameters', async () => {
    const bound = bindVariables('SELECT * FROM plasma_vars_t WHERE id = :id', {
      id: { mode: 'number', value: '1' },
    });
    const plain = await pg.explain(bound.sql, false, bound.params);
    const raw = plain.rows[0]?.[0];
    const plan = typeof raw === 'string' ? JSON.parse(raw) : raw;
    expect(JSON.stringify(plan)).toContain('plasma_vars_t');
    const analyzed = await pg.explain(bound.sql, true, bound.params);
    expect(analyzed.rows.length).toBe(1);
  });
});
