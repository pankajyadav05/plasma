import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectionConfig } from '@shared/protocol';
import Database from 'better-sqlite3';
import { SqliteDriver } from '../../sqlite';
import { allCapabilities } from '../capabilities';
import { buildEnv } from '../env';
import type { SqlFixture } from '../fixture';
import { bool, bytes, exactText, float, instant, int, json } from '../type-expect';

/** SQLite: a temp file, so the app session and the admin session see the same data. */
export function sqliteFixture(): SqlFixture {
  let evilPath = '';
  let otherPath = '';
  return {
    id: 'sqlite',
    engine: 'sqlite',
    versionPattern: /^\d+\.\d+\.\d+/,
    caps: allCapabilities({
      badCredentials: { no: 'a file has no credentials' },
      statementTimeout: true,
      connectionLoss: { no: 'an embedded file engine has no server connection to lose' },
      exactDecimal: {
        no: 'SQLite stores NUMERIC / DECIMAL as binary floating point; exact decimals belong in TEXT',
      },
      timestamptz: { no: 'SQLite has no timestamp-with-time-zone type; timestamps are plain text' },
      arrays: { no: 'SQLite has no array type' },
    }),

    async setup() {
      const dir = mkdtempSync(join(tmpdir(), 'plasma-conf-sqlite-'));
      const file = join(dir, 'conf.db');
      new Database(file).close();
      evilPath = join(dir, 'evil.db');
      // Another database on the same disk, with something the session must not reach.
      otherPath = join(dir, 'other.db');
      const other = new Database(otherPath);
      other.exec(`CREATE TABLE secret (s TEXT); INSERT INTO secret VALUES ('hidden')`);
      other.close();
      const base = (o: { readOnly?: boolean }): ConnectionConfig =>
        ({
          id: 'conf',
          name: 'conf',
          engine: 'sqlite',
          host: 'local',
          port: 1,
          database: file,
          user: '',
          password: '',
          ssl: false,
          readOnly: o.readOnly === true,
        }) as ConnectionConfig;
      const env = await buildEnv({
        schema: 'main',
        shared: true,
        create: () => new SqliteDriver(),
        base,
        cleanup: async () => rmSync(dir, { recursive: true, force: true }),
      });
      return env;
    },

    ddl: (p) => [
      `CREATE TABLE ${p}users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER DEFAULT 18, bio TEXT)`,
      `CREATE TABLE ${p}posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES ${p}users(id) ON DELETE CASCADE, title TEXT)`,
      `CREATE TABLE ${p}pair (a INTEGER NOT NULL, b INTEGER NOT NULL, v TEXT, PRIMARY KEY (a, b))`,
      `CREATE TABLE ${p}nokey (a INTEGER, b TEXT)`,
      `CREATE VIEW ${p}adults AS SELECT * FROM ${p}users WHERE age >= 18`,
    ],
    extraDdl: ['CREATE TABLE write_log (n INTEGER)'],

    // Rows keep arriving (one in 2000 steps), which is what lets a cancel be heard:
    // better-sqlite3 cannot interrupt a step that produces no row.
    sleepSql:
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 400000000) SELECT x FROM c WHERE x % 2000 = 0',
    syntaxErrorSql: 'SELEC 1',
    syntaxErrorPattern: /syntax error/i,
    runtimeErrorSql: 'SELECT abs(-9223372036854775808)',
    rowsSql: (n) =>
      `WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < ${n}) SELECT n FROM c`,
    wideRowsSql: (n, bytes_) =>
      `WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < ${n}) SELECT replace(hex(zeroblob(${Math.floor(bytes_ / 2)})), '0', 'x') AS s FROM c`,

    writeProbes: [
      `INSERT INTO users (id, name) VALUES (50, 'ro')`,
      `UPDATE users SET name = 'ro'`,
      'DELETE FROM users',
      'CREATE TABLE ro_probe (a INTEGER)',
      'DROP TABLE nokey',
      'ALTER TABLE users ADD COLUMN z INTEGER',
    ],
    bypassProbes: [
      [`PRAGMA query_only = OFF; INSERT INTO users (id, name) VALUES (51, 'bypass')`],
      ['PRAGMA query_only = OFF', `INSERT INTO users (id, name) VALUES (52, 'bypass')`],
      [
        'BEGIN',
        'PRAGMA query_only = OFF',
        `INSERT INTO users (id, name) VALUES (53, 'bypass')`,
        'COMMIT',
      ],
    ],
    aiReadSql: 'SELECT count(*) AS c FROM users',
    get aiWriteProbes() {
      return [
        `INSERT INTO users (id, name) VALUES (60, 'ai')`,
        `UPDATE users SET name = 'ai'`,
        'DELETE FROM users',
        'WITH x AS (SELECT 1) DELETE FROM users',
        'WITH x AS (SELECT 1 AS n) INSERT INTO write_log SELECT n FROM x',
        'CREATE TABLE ai_probe (a INTEGER)',
        'PRAGMA user_version = 9',
        `ATTACH DATABASE '${evilPath}' AS evil`,
        `ATTACH DATABASE '${otherPath}' AS other`,
        `VACUUM INTO '${evilPath}'`,
      ];
    },
    async probeSideEffects(_env, session) {
      const leaked: string[] = [];
      const tables = await session.query(`SELECT name FROM sqlite_master WHERE name = 'ai_probe'`);
      if (tables.rows.length > 0) leaked.push('ai_probe table was created');
      const v = await session.query('PRAGMA user_version');
      if (Number(v.rows[0]?.[0]) !== 0) leaked.push(`user_version is ${v.rows[0]?.[0]}`);
      if (existsSync(evilPath)) leaked.push('a database file was created next to the database');
      // An ATTACH that was let through would make the other file readable by the next query.
      const peek = await session.aiQuery('SELECT s FROM other.secret').catch(() => null);
      if (peek && peek.rows.length > 0) leaked.push('another database file became readable');
      return leaked.length > 0 ? leaked.join('; ') : undefined;
    },

    textType: 'TEXT',
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
        name: 'decimal',
        needs: 'exactDecimal',
        sqlType: 'NUMERIC',
        literal: `'12345678901234567890.123456789'`,
        param: '12345678901234567890.123456789',
        expect: exactText('12345678901234567890.123456789'),
      },
      { name: 'double', sqlType: 'REAL', literal: '1.5', param: '1.5', expect: float(1.5) },
      { name: 'double 0.1', sqlType: 'REAL', literal: '0.1', param: '0.1', expect: float(0.1) },
      { name: 'boolean', sqlType: 'BOOLEAN', literal: '1', expect: bool(true, 'integer') },
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
        sqlType: 'TEXT',
        literal: `'2024-01-02 03:04:05.123456+02'`,
        expect: instant('2024-01-02T01:04:05.123Z'),
      },
      {
        name: 'uuid',
        sqlType: 'TEXT',
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
        literal: `x'deadbeef'`,
        param: Buffer.from('deadbeef', 'hex'),
        expect: bytes('deadbeef'),
      },
    ],
  };
}
