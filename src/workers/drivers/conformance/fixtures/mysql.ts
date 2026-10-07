import type { ConnectionConfig } from '@shared/protocol';
import { MysqlDriver } from '../../mysql';
import { allCapabilities } from '../capabilities';
import { buildEnv } from '../env';
import type { SqlFixture } from '../fixture';
import { bool, bytes, exactText, float, int, json } from '../type-expect';

export type MysqlFlavor = 'mysql' | 'mariadb';

/** Env switches of one flavor: `PLASMA_LIVE_MYSQL` + `PLASMA_MYSQL_*`, or the MARIADB twin. */
export function mysqlLiveEnv(flavor: MysqlFlavor) {
  const key = flavor === 'mysql' ? 'MYSQL' : 'MARIADB';
  const e = process.env;
  return {
    enabled: Boolean(e[`PLASMA_LIVE_${key}`]),
    host: e[`PLASMA_${key}_HOST`] ?? '127.0.0.1',
    port: Number(e[`PLASMA_${key}_PORT`] ?? 3306),
    user: e[`PLASMA_${key}_USER`] ?? 'root',
    password: e[`PLASMA_${key}_PASSWORD`] ?? '',
  };
}

/** MySQL 8 and MariaDB run the same fixture; the driver is one, the servers differ. */
export function mysqlFixture(flavor: MysqlFlavor): SqlFixture {
  const live = mysqlLiveEnv(flavor);
  const scratch = `plasma_conf_${process.pid}_${flavor}`;
  const base = (database: string, o: { readOnly?: boolean; password?: string }): ConnectionConfig =>
    ({
      id: 'conf',
      name: 'conf',
      engine: 'mysql',
      host: live.host,
      port: live.port,
      database,
      user: live.user,
      password: o.password ?? live.password,
      ssl: false,
      readOnly: o.readOnly === true,
    }) as ConnectionConfig;

  const heavyJoin = 'SELECT COUNT(*) FROM nums a, nums b, nums c WHERE (a.n * b.n + c.n) % 7 = 3';

  return {
    id: flavor,
    engine: 'mysql',
    versionPattern: flavor === 'mysql' ? /^MySQL \d+\.\d+/ : /^MariaDB \d+\.\d+/,
    caps: allCapabilities({
      timestamptz: {
        no: 'MySQL has no zone-carrying timestamp: TIMESTAMP is stored in UTC and shown in the session zone',
      },
      arrays: { no: 'MySQL has no array type' },
      keylessEdit: {
        no: 'MySQL has no row locator (no ctid / rowid): a table without a primary key is not editable',
      },
    }),

    async setup() {
      const admin = new MysqlDriver();
      await admin.connect(base('', {}));
      await admin.query(`DROP DATABASE IF EXISTS ${scratch}`);
      // utf8mb4 by name: a server default of latin1 would reject emoji in the type cases.
      await admin.query(
        `CREATE DATABASE ${scratch} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
      await admin.disconnect();
      return buildEnv({
        schema: scratch,
        shared: true,
        create: () => new MysqlDriver(),
        base: (o) => base(scratch, o),
        server: { host: live.host, port: live.port },
        cleanup: async () => {
          const a = new MysqlDriver();
          await a.connect(base('', {}));
          await a.query(`DROP DATABASE IF EXISTS ${scratch}`);
          await a.disconnect();
        },
      });
    },

    ddl: (p) => [
      `CREATE TABLE ${p}users (id INT PRIMARY KEY, name VARCHAR(40) NOT NULL, age INT DEFAULT 18, bio TEXT)`,
      `CREATE TABLE ${p}posts (id INT PRIMARY KEY, user_id INT NOT NULL, title VARCHAR(80), CONSTRAINT fk_${p}posts_user FOREIGN KEY (user_id) REFERENCES ${p}users(id) ON DELETE CASCADE)`,
      `CREATE TABLE ${p}pair (a INT NOT NULL, b INT NOT NULL, v VARCHAR(10), PRIMARY KEY (a, b))`,
      `CREATE TABLE ${p}nokey (a INT, b VARCHAR(10))`,
      `CREATE VIEW ${p}adults AS SELECT * FROM ${p}users WHERE age >= 18`,
    ],
    extraDdl: [
      'CREATE TABLE write_log (n INT)',
      // A procedure with a one-statement body: the driver splits scripts on `;`.
      'CREATE PROCEDURE conf_write_proc() INSERT INTO write_log VALUES (1)',
      // 1..100000, for row-cap queries (a recursive CTE stops at 1000 rows on MySQL).
      'CREATE TABLE digits (d INT)',
      'INSERT INTO digits VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)',
      'CREATE TABLE nums (n INT PRIMARY KEY)',
      'INSERT INTO nums SELECT a.d + b.d * 10 + c.d * 100 + d.d * 1000 + e.d * 10000 + 1 FROM digits a, digits b, digits c, digits d, digits e',
      'DROP TABLE digits',
    ],

    sleepSql: heavyJoin,
    syntaxErrorSql: 'SELEC 1',
    syntaxErrorPattern: /syntax/i,
    runtimeErrorSql: 'SELECT * FROM does_not_exist_zz',
    rowsSql: (n) => `SELECT n FROM nums WHERE n <= ${n} ORDER BY n`,
    wideRowsSql: (n, size) => `SELECT REPEAT('x', ${size}) AS s FROM nums WHERE n <= ${n}`,

    writeProbes: [
      `INSERT INTO users (id, name) VALUES (50, 'ro')`,
      `UPDATE users SET name = 'ro'`,
      'DELETE FROM users',
      'TRUNCATE TABLE users',
      'CREATE TABLE ro_probe (a INT)',
      'DROP TABLE nokey',
      'ALTER TABLE users ADD COLUMN z INT',
      'CALL conf_write_proc()',
    ],
    bypassProbes: [
      [`SET SESSION TRANSACTION READ WRITE; INSERT INTO users (id, name) VALUES (51, 'bypass')`],
      ['SET SESSION TRANSACTION READ WRITE', `INSERT INTO users (id, name) VALUES (52, 'bypass')`],
      ['SET SESSION tx_read_only = 0', `INSERT INTO users (id, name) VALUES (53, 'bypass')`],
      [
        'SET SESSION transaction_read_only = 0',
        `INSERT INTO users (id, name) VALUES (54, 'bypass')`,
      ],
      [
        'START TRANSACTION READ WRITE',
        `INSERT INTO users (id, name) VALUES (55, 'bypass')`,
        'COMMIT',
      ],
      ['SET TRANSACTION READ WRITE', `INSERT INTO users (id, name) VALUES (56, 'bypass')`],
      ['SET @@session.tx_read_only = 0', `INSERT INTO users (id, name) VALUES (57, 'bypass')`],
      [`START TRANSACTION READ WRITE; INSERT INTO users (id, name) VALUES (58, 'bypass'); COMMIT`],
    ],
    aiReadSql: 'SELECT count(*) AS c FROM users',
    aiWriteProbes: [
      `INSERT INTO users (id, name) VALUES (70, 'ai')`,
      `UPDATE users SET name = 'ai'`,
      'DELETE FROM users',
      'TRUNCATE TABLE users',
      'WITH x AS (SELECT 1) DELETE FROM users',
      'CALL conf_write_proc()',
      'CREATE TABLE ai_probe (a INT)',
      'SET SESSION TRANSACTION READ WRITE',
      'START TRANSACTION READ WRITE',
      'COMMIT',
    ],
    async cleanupAfterLoss(env) {
      const running = await env.admin(
        `SELECT id FROM information_schema.processlist WHERE info LIKE 'SELECT COUNT(*) FROM nums a, nums b%'`,
      );
      for (const [id] of running.rows) await env.admin(`KILL ${Number(id)}`).catch(() => undefined);
    },

    textType: 'VARCHAR(200)',
    typeCases: [
      {
        name: 'integer',
        sqlType: 'INT',
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
        name: 'unsigned bigint max',
        needs: 'bigint',
        sqlType: 'BIGINT UNSIGNED',
        literal: '18446744073709551615',
        param: '18446744073709551615',
        expect: int('18446744073709551615'),
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
        literal: 'TRUE',
        param: '1',
        expect: bool(true, 'integer'),
      },
      {
        name: 'date',
        sqlType: 'DATE',
        literal: `'2024-02-29'`,
        param: '2024-02-29',
        expect: exactText('2024-02-29'),
      },
      {
        name: 'datetime',
        sqlType: 'DATETIME(6)',
        literal: `'2024-01-02 03:04:05.123456'`,
        param: '2024-01-02 03:04:05.123456',
        expect: exactText('2024-01-02 03:04:05.123456'),
      },
      {
        name: 'timestamp (session zone)',
        sqlType: 'TIMESTAMP(6) NULL',
        literal: `'2024-01-02 03:04:05.123456'`,
        param: '2024-01-02 03:04:05.123456',
        expect: exactText('2024-01-02 03:04:05.123456'),
      },
      {
        name: 'uuid as text',
        sqlType: 'CHAR(36)',
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
