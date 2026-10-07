import type { ConnectionConfig } from '@shared/protocol';
import pg from 'pg';
import { expect } from 'vitest';
import { PostgresDriver } from '../../postgres';
import { allCapabilities } from '../capabilities';
import { buildEnv } from '../env';
import type { SqlFixture } from '../fixture';
import { bool, bytes, exactText, float, instant, int, json } from '../type-expect';

/** `PLASMA_LIVE_PG=postgres://user:pass@host:port/db`; the suite makes and drops its own database. */
export const POSTGRES_URL = process.env.PLASMA_LIVE_PG;

export function postgresFixture(): SqlFixture {
  const url = new URL(POSTGRES_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres');
  const scratch = `plasma_conf_${Math.random().toString(36).slice(2, 10)}`;
  const base = (database: string, o: { readOnly?: boolean; password?: string }): ConnectionConfig =>
    ({
      id: 'conf',
      name: 'conf',
      engine: 'postgres',
      host: url.hostname,
      port: Number(url.port || 5432),
      database,
      user: decodeURIComponent(url.username),
      password: o.password ?? decodeURIComponent(url.password),
      ssl: false,
      readOnly: o.readOnly === true,
    }) as ConnectionConfig;

  return {
    id: 'postgres',
    engine: 'postgres',
    versionPattern: /^PostgreSQL \d+/,
    caps: allCapabilities({}),

    async setup() {
      const admin = new pg.Client({ connectionString: url.toString() });
      await admin.connect();
      await admin.query(`CREATE DATABASE ${scratch}`);
      await admin.end();
      return buildEnv({
        schema: 'public',
        shared: true,
        create: () => new PostgresDriver(),
        base: (o) => base(scratch, o),
        server: { host: url.hostname, port: Number(url.port || 5432) },
        cleanup: async () => {
          const a = new pg.Client({ connectionString: url.toString() });
          await a.connect();
          await a.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
          await a.end();
        },
      });
    },

    ddl: (p) => [
      `CREATE TABLE ${p}users (id integer PRIMARY KEY, name text NOT NULL, age integer DEFAULT 18, bio text)`,
      `CREATE TABLE ${p}posts (id integer PRIMARY KEY, user_id integer NOT NULL REFERENCES ${p}users(id) ON DELETE CASCADE, title text)`,
      `CREATE TABLE ${p}pair (a integer NOT NULL, b integer NOT NULL, v text, PRIMARY KEY (a, b))`,
      `CREATE TABLE ${p}nokey (a integer, b text)`,
      `CREATE VIEW ${p}adults AS SELECT * FROM ${p}users WHERE age >= 18`,
    ],
    extraDdl: [
      'CREATE TABLE write_log (n integer)',
      'CREATE SEQUENCE conf_seq',
      'CREATE FUNCTION conf_write_fn() RETURNS integer LANGUAGE sql AS $$ INSERT INTO write_log VALUES (1) RETURNING 1 $$',
    ],

    sleepSql: 'SELECT pg_sleep(30)',
    syntaxErrorSql: 'SELEC 1',
    syntaxErrorPattern: /syntax error/i,
    syntaxErrorExtra: (err) => {
      // The server's character offset of the mistake, for the editor's squiggle.
      expect(Number((err as Error & { position?: string }).position)).toBeGreaterThan(0);
    },
    runtimeErrorSql: 'SELECT 1 / 0',
    rowsSql: (n) => `SELECT g AS n FROM generate_series(1, ${n}) g`,
    wideRowsSql: (n, size) => `SELECT repeat('x', ${size}) AS s FROM generate_series(1, ${n})`,

    writeProbes: [
      `INSERT INTO users (id, name) VALUES (50, 'ro')`,
      `UPDATE users SET name = 'ro'`,
      'DELETE FROM users',
      'TRUNCATE users',
      'CREATE TABLE ro_probe (a integer)',
      'DROP TABLE nokey',
      'ALTER TABLE users ADD COLUMN z integer',
      'SELECT conf_write_fn()',
      "SELECT nextval('conf_seq')",
    ],
    bypassProbes: [
      [
        'SET default_transaction_read_only = off',
        `INSERT INTO users (id, name) VALUES (51, 'bypass')`,
      ],
      [
        'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE',
        `INSERT INTO users (id, name) VALUES (52, 'bypass')`,
      ],
      ['BEGIN READ WRITE', `INSERT INTO users (id, name) VALUES (53, 'bypass')`, 'COMMIT'],
      [
        'BEGIN',
        'SET TRANSACTION READ WRITE',
        `INSERT INTO users (id, name) VALUES (54, 'bypass')`,
        'COMMIT',
      ],
      [
        "SELECT set_config('default_transaction_read_only', 'off', false)",
        `INSERT INTO users (id, name) VALUES (55, 'bypass')`,
      ],
      [
        "SELECT set_config('transaction_read_only', 'off', false)",
        `INSERT INTO users (id, name) VALUES (56, 'bypass')`,
      ],
      ['RESET default_transaction_read_only', `INSERT INTO users (id, name) VALUES (57, 'bypass')`],
      ['RESET ALL', `INSERT INTO users (id, name) VALUES (58, 'bypass')`],
      ['DISCARD ALL', `INSERT INTO users (id, name) VALUES (59, 'bypass')`],
      [
        `DO $$ BEGIN SET LOCAL transaction_read_only = off; INSERT INTO users (id, name) VALUES (61, 'bypass'); END $$`,
      ],
      [
        'SET SESSION AUTHORIZATION DEFAULT',
        'RESET default_transaction_read_only',
        `INSERT INTO users (id, name) VALUES (62, 'bypass')`,
      ],
    ],
    aiReadSql: 'SELECT count(*) AS c FROM users',
    aiWriteProbes: [
      `INSERT INTO users (id, name) VALUES (70, 'ai')`,
      `UPDATE users SET name = 'ai'`,
      'DELETE FROM users',
      'TRUNCATE users',
      'WITH d AS (DELETE FROM users RETURNING id) SELECT * FROM d',
      'WITH i AS (INSERT INTO write_log VALUES (1) RETURNING n) SELECT * FROM i',
      'SELECT conf_write_fn()',
      "SELECT nextval('conf_seq')",
      'CREATE TABLE ai_probe (a integer)',
      "SELECT set_config('transaction_read_only', 'off', false)",
      "SELECT set_config('default_transaction_read_only', 'off', false)",
      'SET default_transaction_read_only = off',
      'COMMIT',
    ],
    async probeSideEffects(env) {
      const leaked: string[] = [];
      const t = await env.admin(`SELECT to_regclass('ai_probe')::text`);
      if (t.rows[0]?.[0] !== null) leaked.push('ai_probe table was created');
      const seq = await env.admin('SELECT is_called FROM conf_seq');
      if (seq.rows[0]?.[0] !== false) leaked.push('the sequence was advanced');
      return leaked.length > 0 ? leaked.join('; ') : undefined;
    },

    textType: 'text',
    typeCases: [
      {
        name: 'integer',
        sqlType: 'integer',
        literal: '2147483647',
        param: '2147483647',
        expect: int('2147483647'),
        typeName: /^int4$/,
      },
      {
        name: 'bigint beyond 2^53',
        needs: 'bigint',
        sqlType: 'bigint',
        literal: '9007199254740993',
        param: '9007199254740993',
        expect: int('9007199254740993'),
        typeName: /^int8$/,
      },
      {
        name: 'bigint max',
        needs: 'bigint',
        sqlType: 'bigint',
        literal: '9223372036854775807',
        param: '9223372036854775807',
        expect: int('9223372036854775807'),
      },
      {
        name: 'decimal',
        needs: 'exactDecimal',
        sqlType: 'numeric(38,9)',
        literal: '12345678901234567890.123456789',
        param: '12345678901234567890.123456789',
        expect: exactText('12345678901234567890.123456789'),
        typeName: /^numeric$/,
      },
      {
        name: 'decimal with trailing zero',
        needs: 'exactDecimal',
        sqlType: 'numeric(10,2)',
        literal: '12.30',
        param: '12.30',
        expect: exactText('12.30'),
      },
      {
        name: 'double',
        sqlType: 'double precision',
        literal: '1.5',
        param: '1.5',
        expect: float(1.5),
      },
      {
        name: 'double 0.1',
        sqlType: 'double precision',
        literal: '0.1',
        param: '0.1',
        expect: float(0.1),
      },
      {
        name: 'real (float32) shows its shortest value',
        sqlType: 'real',
        literal: '1.1',
        param: '1.1',
        expect: float(1.1),
      },
      {
        name: 'boolean',
        sqlType: 'boolean',
        literal: 'true',
        param: 'true',
        expect: bool(true, 'boolean'),
      },
      {
        name: 'date',
        sqlType: 'date',
        literal: `'2024-02-29'`,
        param: '2024-02-29',
        expect: exactText('2024-02-29'),
      },
      {
        name: 'timestamp',
        sqlType: 'timestamp',
        literal: `'2024-01-02 03:04:05.123456'`,
        param: '2024-01-02 03:04:05.123456',
        expect: exactText('2024-01-02 03:04:05.123456'),
      },
      {
        name: 'timestamp with time zone',
        needs: 'timestamptz',
        sqlType: 'timestamptz',
        literal: `'2024-01-02 03:04:05.123456+02'`,
        param: '2024-01-02 03:04:05.123456+02',
        expect: instant('2024-01-02T01:04:05.123Z'),
      },
      {
        name: 'uuid',
        sqlType: 'uuid',
        literal: `'123e4567-e89b-12d3-a456-426614174000'`,
        param: '123e4567-e89b-12d3-a456-426614174000',
        expect: exactText('123e4567-e89b-12d3-a456-426614174000'),
      },
      {
        name: 'jsonb',
        needs: 'json',
        sqlType: 'jsonb',
        literal: `'{"a":[1,2],"u":"é"}'`,
        param: '{"a":[1,2],"u":"é"}',
        expect: json({ a: [1, 2], u: 'é' }),
      },
      {
        name: 'jsonb with an integer beyond 2^53',
        needs: 'json',
        sqlType: 'jsonb',
        literal: `'{"big":9007199254740993}'`,
        param: '{"big":9007199254740993}',
        expect: json({ big: '9007199254740993' }),
      },
      {
        name: 'bytea',
        needs: 'binary',
        sqlType: 'bytea',
        literal: `'\\xdeadbeef'`,
        param: '\\xdeadbeef',
        expect: bytes('deadbeef'),
      },
      {
        name: 'integer array',
        needs: 'arrays',
        sqlType: 'integer[]',
        literal: 'ARRAY[1,2,3]',
        param: '{1,2,3}',
        expect: exactText('{1,2,3}'),
      },
      {
        name: 'text array',
        needs: 'arrays',
        sqlType: 'text[]',
        literal: `ARRAY['a','b c']`,
        param: '{a,"b c"}',
        expect: exactText('{a,"b c"}'),
      },
    ],
  };
}
