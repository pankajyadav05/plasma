import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectionConfig } from '@shared/protocol';
import { expect } from 'vitest';
import { DuckdbDriver } from '../../duckdb';
import type { SqlEngineDriver } from '../../sql-engine';
import { allCapabilities } from '../capabilities';
import type { EngineEnv, OpenOpts, SqlFixture } from '../fixture';
import { seedStatements } from '../seed';
import { bool, bytes, exactText, float, instant, int, json } from '../type-expect';

const DDL = (p: string): string[] => [
  `CREATE TABLE ${p}users (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL, age INTEGER DEFAULT 18, bio VARCHAR)`,
  `CREATE TABLE ${p}posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES ${p}users(id), title VARCHAR)`,
  `CREATE TABLE ${p}pair (a INTEGER NOT NULL, b INTEGER NOT NULL, v VARCHAR, PRIMARY KEY (a, b))`,
  `CREATE TABLE ${p}nokey (a INTEGER, b VARCHAR)`,
  `CREATE VIEW ${p}adults AS SELECT * FROM ${p}users WHERE age >= 18`,
];
const EXTRA = ['CREATE TABLE write_log (n INTEGER)', 'CREATE SEQUENCE conf_seq'];

/**
 * DuckDB: every in-memory session is its own database, so each new session
 * is seeded by the env. A read-only session is a seeded `.duckdb` file
 * (DuckDB opens those read-only), which is also how the app uses it.
 */
export function duckdbFixture(): SqlFixture {
  return {
    id: 'duckdb',
    engine: 'duckdb',
    versionPattern: /^\d+\.\d+\.\d+/,
    caps: allCapabilities({
      badCredentials: { no: 'a local session has no credentials' },
      connectionLoss: { no: 'an in-process engine has no server connection to lose' },
      transactions: {
        no: 'the driver does not track transactions: begin / commit / rollback() and txnState always answer "none" (a BEGIN typed by the user is still a real DuckDB transaction, see userTransactions)',
      },
      rowEdit: {
        no: 'data-file sessions are read-mostly; grid edits are refused in favour of SQL',
      },
      keylessEdit: { no: 'rows are not editable in a data-file session' },
    }),

    async setup() {
      const dir = mkdtempSync(join(tmpdir(), 'plasma-conf-duckdb-'));
      const seedFile = join(dir, 'seed.duckdb');
      const { DuckDBInstance } = await import('@duckdb/node-api');
      const inst = await DuckDBInstance.create(seedFile);
      const c = await inst.connect();
      for (const sql of [
        ...DDL(''),
        ...DDL('edit_'),
        ...EXTRA,
        ...seedStatements(''),
        ...seedStatements('edit_'),
      ]) {
        await c.run(sql);
      }
      c.closeSync();
      inst.closeSync();

      const config = (o: OpenOpts = {}): ConnectionConfig =>
        ({
          id: 'conf',
          name: 'conf',
          engine: 'duckdb',
          host: 'local',
          port: 1,
          database: o.readOnly ? seedFile : ':memory:',
          user: '',
          password: '',
          ssl: false,
          readOnly: o.readOnly === true,
        }) as ConnectionConfig;
      const sessions: SqlEngineDriver[] = [];
      let admin: SqlEngineDriver | null = null;
      const env: EngineEnv = {
        schema: 'main',
        shared: false,
        create: () => new DuckdbDriver(),
        config,
        async open(o = {}) {
          const d = new DuckdbDriver();
          sessions.push(d);
          await d.connect(config(o), o.statementTimeoutMs ?? 0);
          if (!o.readOnly) {
            for (const sql of [...DDL(''), ...EXTRA, ...seedStatements('')]) await d.query(sql);
          }
          d.setConnectionGen(1);
          return d;
        },
        async admin(sql, params) {
          if (!admin) admin = await env.open();
          return admin.query(sql, params);
        },
        async teardown() {
          await Promise.allSettled(sessions.map((s) => s.disconnect()));
          rmSync(dir, { recursive: true, force: true });
        },
      };
      return env;
    },
    ddl: DDL,
    extraDdl: EXTRA,

    sleepSql: 'SELECT count(*) FROM range(100000000000) t(a) WHERE a % 7 = 3',
    syntaxErrorSql: 'SELEC 1',
    syntaxErrorPattern: /syntax error/i,
    runtimeErrorSql: `SELECT CAST('abc' AS INTEGER)`,
    rowsSql: (n) => `SELECT range + 1 AS n FROM range(${n})`,
    wideRowsSql: (n, size) => `SELECT repeat('x', ${size}) AS s FROM range(${n})`,

    writeProbes: [
      `INSERT INTO users (id, name) VALUES (50, 'ro')`,
      `UPDATE users SET name = 'ro'`,
      'DELETE FROM users',
      'CREATE TABLE ro_probe (a INTEGER)',
      'DROP TABLE nokey',
      'ALTER TABLE users ADD COLUMN z INTEGER',
    ],
    bypassProbes: [
      [`SET access_mode = 'read_write'`, `INSERT INTO users (id, name) VALUES (51, 'bypass')`],
      [`ATTACH ':memory:' AS m`, `INSERT INTO users (id, name) VALUES (52, 'bypass')`],
      ['PRAGMA enable_external_access', `COPY users TO 'x.csv'`],
    ],
    aiReadSql: 'SELECT count(*) AS c FROM users',
    aiWriteProbes: [
      `INSERT INTO users (id, name) VALUES (60, 'ai')`,
      `UPDATE users SET name = 'ai'`,
      'DELETE FROM users',
      'WITH x AS (SELECT 1) DELETE FROM users',
      'WITH x AS (SELECT 1 AS n) INSERT INTO write_log SELECT n FROM x',
      'CREATE TABLE ai_probe (a INTEGER)',
      "SELECT nextval('conf_seq')",
      `ATTACH ':memory:' AS evil`,
      `COPY users TO 'users.csv'`,
    ],
    async probeSideEffects(_env, session) {
      const leaked: string[] = [];
      const tables = await session.query(
        `SELECT table_name FROM information_schema.tables WHERE table_name = 'ai_probe'`,
      );
      if (tables.rows.length > 0) leaked.push('ai_probe table was created');
      // The first nextval of an untouched sequence is 1.
      const next = await session.query("SELECT nextval('conf_seq')");
      if (Number(next.rows[0]?.[0]) !== 1)
        leaked.push(`sequence moved (nextval is ${next.rows[0]?.[0]})`);
      return leaked.length > 0 ? leaked.join('; ') : undefined;
    },

    textType: 'VARCHAR',
    typeCases: [
      {
        name: 'integer',
        sqlType: 'INTEGER',
        literal: '2147483647',
        param: '2147483647',
        expect: int('2147483647'),
      },
      {
        name: 'bigint beyond 2^53',
        needs: 'bigint',
        sqlType: 'BIGINT',
        literal: '9007199254740993',
        param: '9007199254740993',
        expect: int('9007199254740993'),
        typeName: /^bigint$/,
      },
      {
        name: 'bigint max',
        needs: 'bigint',
        sqlType: 'BIGINT',
        literal: '9223372036854775807',
        param: '9223372036854775807',
        expect: int('9223372036854775807'),
      },
      {
        name: 'hugeint',
        needs: 'bigint',
        sqlType: 'HUGEINT',
        literal: '170141183460469231731687303715884105727',
        expect: int('170141183460469231731687303715884105727'),
      },
      {
        name: 'decimal',
        needs: 'exactDecimal',
        sqlType: 'DECIMAL(38,9)',
        literal: '12345678901234567890.123456789',
        param: '12345678901234567890.123456789',
        expect: exactText('12345678901234567890.123456789'),
      },
      {
        name: 'decimal with trailing zero',
        needs: 'exactDecimal',
        sqlType: 'DECIMAL(10,2)',
        literal: '12.30',
        param: '12.30',
        expect: exactText('12.30'),
      },
      { name: 'double', sqlType: 'DOUBLE', literal: '1.5', param: '1.5', expect: float(1.5) },
      { name: 'double 0.1', sqlType: 'DOUBLE', literal: '0.1', param: '0.1', expect: float(0.1) },
      {
        name: 'real (float32) shows its shortest value',
        sqlType: 'FLOAT',
        literal: '1.1',
        param: '1.1',
        expect: float(1.1),
      },
      {
        name: 'boolean',
        sqlType: 'BOOLEAN',
        literal: 'true',
        param: 'true',
        expect: bool(true, 'boolean'),
      },
      {
        name: 'date',
        sqlType: 'DATE',
        literal: `'2024-02-29'`,
        param: '2024-02-29',
        expect: exactText('2024-02-29'),
      },
      {
        name: 'timestamp',
        sqlType: 'TIMESTAMP',
        literal: `'2024-01-02 03:04:05.123456'`,
        param: '2024-01-02 03:04:05.123456',
        expect: exactText('2024-01-02 03:04:05.123456'),
      },
      {
        name: 'timestamp with time zone',
        needs: 'timestamptz',
        sqlType: 'TIMESTAMPTZ',
        literal: `'2024-01-02 03:04:05.123456+02'`,
        param: '2024-01-02 03:04:05.123456+02',
        expect: instant('2024-01-02T01:04:05.123Z'),
      },
      {
        name: 'uuid',
        sqlType: 'UUID',
        literal: `'123e4567-e89b-12d3-a456-426614174000'`,
        param: '123e4567-e89b-12d3-a456-426614174000',
        expect: exactText('123e4567-e89b-12d3-a456-426614174000'),
      },
      {
        name: 'json',
        needs: 'json',
        sqlType: 'JSON',
        literal: `'{"a":[1,2],"u":"é"}'`,
        param: '{"a":[1,2],"u":"é"}',
        expect: json({ a: [1, 2], u: 'é' }),
      },
      {
        name: 'blob',
        needs: 'binary',
        sqlType: 'BLOB',
        literal: `'\\xDE\\xAD\\xBE\\xEF'::BLOB`,
        expect: bytes('deadbeef'),
      },
      {
        name: 'blob with printable bytes',
        needs: 'binary',
        sqlType: 'BLOB',
        literal: `'ab\\x00c'::BLOB`,
        expect: bytes('61620063'),
      },
      {
        name: 'integer list',
        needs: 'arrays',
        sqlType: 'INTEGER[]',
        literal: '[1, 2, 3]',
        expect: (c) => expect(c).toEqual([1, 2, 3]),
      },
    ],
  };
}
