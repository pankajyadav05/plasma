import type { ConnectionConfig } from '@shared/protocol';
import { expect } from 'vitest';
import { ClickhouseDriver } from '../../clickhouse';
import { allCapabilities } from '../capabilities';
import { buildEnv } from '../env';
import type { SqlFixture } from '../fixture';
import { bool, exactText, float, instant, int } from '../type-expect';

/** `PLASMA_LIVE_CLICKHOUSE=1 [PLASMA_CLICKHOUSE_HOST/PORT/USER/PASSWORD]` (HTTP interface). */
export function clickhouseLiveEnv() {
  const e = process.env;
  return {
    enabled: Boolean(e.PLASMA_LIVE_CLICKHOUSE),
    host: e.PLASMA_CLICKHOUSE_HOST ?? '127.0.0.1',
    port: Number(e.PLASMA_CLICKHOUSE_PORT ?? 8123),
    user: e.PLASMA_CLICKHOUSE_USER ?? 'default',
    password: e.PLASMA_CLICKHOUSE_PASSWORD ?? '',
  };
}

const ENGINE = 'ENGINE = MergeTree';

export function clickhouseFixture(): SqlFixture {
  const live = clickhouseLiveEnv();
  const scratch = `plasma_conf_${process.pid}`;
  const base = (database: string, o: { readOnly?: boolean; password?: string }): ConnectionConfig =>
    ({
      id: 'conf',
      name: 'conf',
      engine: 'clickhouse',
      host: live.host,
      port: live.port,
      database,
      user: live.user,
      password: o.password ?? live.password,
      ssl: false,
      readOnly: o.readOnly === true,
    }) as ConnectionConfig;

  return {
    id: 'clickhouse',
    engine: 'clickhouse',
    versionPattern: /^ClickHouse \d+\.\d+/,
    caps: allCapabilities({
      foreignKeys: { no: 'ClickHouse has no foreign keys' },
      constraints: {
        no: 'ClickHouse enforces no unique, not-null or key constraints: the primary key is a sorting key',
      },
      transactions: { no: 'ClickHouse has no transactions; begin / commit / rollback are no-ops' },
      rowEdit: {
        no: 'writes are asynchronous mutations (ALTER ... UPDATE); the grid refuses edits and the editor warns',
      },
      keylessEdit: { no: 'rows are not editable in the grid' },
      json: {
        no: 'the JSON column type is experimental in the supported servers; JSON text is a plain String',
      },
      binary: {
        no: 'a String holds arbitrary bytes but leaves the server as JSON text, which cannot carry invalid UTF-8',
      },
    }),

    async setup() {
      const admin = new ClickhouseDriver();
      await admin.connect(base('', {}));
      await admin.query(`DROP DATABASE IF EXISTS ${scratch}`);
      await admin.query(`CREATE DATABASE ${scratch}`);
      await admin.disconnect();
      return buildEnv({
        schema: scratch,
        shared: true,
        create: () => new ClickhouseDriver(),
        base: (o) => base(scratch, o),
        server: { host: live.host, port: live.port },
        cleanup: async () => {
          const a = new ClickhouseDriver();
          await a.connect(base('', {}));
          await a.query(`DROP DATABASE IF EXISTS ${scratch}`);
          await a.disconnect();
        },
      });
    },

    ddl: (p) => [
      `CREATE TABLE ${p}users (id Int32, name String, age Nullable(Int32) DEFAULT 18, bio Nullable(String)) ${ENGINE} ORDER BY id`,
      `CREATE TABLE ${p}posts (id Int32, user_id Int32, title Nullable(String)) ${ENGINE} ORDER BY id`,
      `CREATE TABLE ${p}pair (a Int32, b Int32, v Nullable(String)) ${ENGINE} ORDER BY (a, b)`,
      `CREATE TABLE ${p}nokey (a Nullable(Int32), b Nullable(String)) ${ENGINE} ORDER BY tuple()`,
      `CREATE VIEW ${p}adults AS SELECT * FROM ${p}users WHERE age >= 18`,
    ],
    extraDdl: ['CREATE TABLE write_log (n Int32) ENGINE = MergeTree ORDER BY n'],
    tableOf: (name, valueType) =>
      `CREATE TABLE ${name} (id Int32, v ${valueType}) ${ENGINE} ORDER BY id`,

    // One row per block, one second per row: runs for 30 s unless cancelled.
    sleepSql: 'SELECT sleepEachRow(1) FROM numbers(30) SETTINGS max_block_size = 1',
    syntaxErrorSql: 'SELEC 1',
    syntaxErrorPattern: /syntax error/i,
    runtimeErrorSql: `SELECT CAST('abc' AS Int32)`,
    rowsSql: (n) => `SELECT number + 1 AS n FROM numbers(${n}) ORDER BY n`,
    wideRowsSql: (n, size) => `SELECT repeat('x', ${size}) AS s FROM numbers(${n})`,

    writeProbes: [
      `INSERT INTO users (id, name) VALUES (50, 'ro')`,
      `ALTER TABLE users UPDATE name = 'ro' WHERE 1`,
      'ALTER TABLE users DELETE WHERE 1',
      'TRUNCATE TABLE users',
      'CREATE TABLE ro_probe (a Int32) ENGINE = Memory',
      'DROP TABLE nokey',
      'ALTER TABLE users ADD COLUMN z Int32',
      'OPTIMIZE TABLE users FINAL',
      'INSERT INTO write_log SELECT 1',
    ],
    bypassProbes: [
      ['SET readonly = 0', `INSERT INTO users (id, name) VALUES (51, 'bypass')`],
      [`SET readonly = 0; INSERT INTO users (id, name) VALUES (52, 'bypass')`],
      [`INSERT INTO users (id, name) SETTINGS readonly = 0 VALUES (53, 'bypass')`],
    ],
    aiReadSql: 'SELECT count() AS c FROM users',
    aiWriteProbes: [
      `INSERT INTO users (id, name) VALUES (70, 'ai')`,
      'ALTER TABLE users DELETE WHERE 1',
      `ALTER TABLE users UPDATE name = 'ai' WHERE 1`,
      'TRUNCATE TABLE users',
      'INSERT INTO write_log SELECT 1',
      'CREATE TABLE ai_probe (a Int32) ENGINE = Memory',
      'OPTIMIZE TABLE users FINAL',
      'SET readonly = 0',
    ],

    textType: 'Nullable(String)',
    typeCases: [
      {
        name: 'integer',
        sqlType: 'Nullable(Int32)',
        literal: '2147483647',
        param: '2147483647',
        expect: int('2147483647'),
      },
      {
        name: 'bigint beyond 2^53',
        needs: 'bigint',
        sqlType: 'Nullable(Int64)',
        literal: '9007199254740993',
        param: '9007199254740993',
        expect: int('9007199254740993'),
        typeName: /Int64/,
      },
      {
        name: 'bigint max',
        needs: 'bigint',
        sqlType: 'Nullable(Int64)',
        literal: '9223372036854775807',
        param: '9223372036854775807',
        expect: int('9223372036854775807'),
      },
      {
        name: 'unsigned bigint max',
        needs: 'bigint',
        sqlType: 'Nullable(UInt64)',
        literal: '18446744073709551615',
        param: '18446744073709551615',
        expect: int('18446744073709551615'),
      },
      {
        name: 'decimal',
        needs: 'exactDecimal',
        sqlType: 'Nullable(Decimal(38, 9))',
        literal: `toDecimal128('12345678901234567890.123456789', 9)`,
        param: '12345678901234567890.123456789',
        expect: exactText('12345678901234567890.123456789'),
      },
      {
        name: 'decimal with trailing zero',
        needs: 'exactDecimal',
        sqlType: 'Nullable(Decimal(10, 2))',
        literal: '12.30',
        param: '12.30',
        expect: exactText('12.30'),
      },
      {
        name: 'double',
        sqlType: 'Nullable(Float64)',
        literal: '1.5',
        param: '1.5',
        expect: float(1.5),
      },
      {
        name: 'double 0.1',
        sqlType: 'Nullable(Float64)',
        literal: '0.1',
        param: '0.1',
        expect: float(0.1),
      },
      {
        name: 'real (float32) shows its shortest value',
        sqlType: 'Nullable(Float32)',
        literal: '1.1',
        param: '1.1',
        expect: float(1.1),
      },
      {
        name: 'boolean',
        sqlType: 'Nullable(Bool)',
        literal: 'true',
        param: 'true',
        expect: bool(true, 'boolean'),
      },
      {
        name: 'date',
        sqlType: 'Nullable(Date)',
        literal: `'2024-02-29'`,
        param: '2024-02-29',
        expect: exactText('2024-02-29'),
      },
      {
        name: 'timestamp',
        sqlType: 'Nullable(DateTime64(6))',
        literal: `'2024-01-02 03:04:05.123456'`,
        param: '2024-01-02 03:04:05.123456',
        expect: exactText('2024-01-02 03:04:05.123456'),
      },
      {
        name: 'timestamp with time zone',
        needs: 'timestamptz',
        sqlType: `Nullable(DateTime64(6, 'UTC'))`,
        literal: `parseDateTime64BestEffort('2024-01-02 03:04:05.123456+02', 6, 'UTC')`,
        expect: instant('2024-01-02T01:04:05.123Z'),
      },
      {
        name: 'uuid',
        sqlType: 'Nullable(UUID)',
        literal: `'123e4567-e89b-12d3-a456-426614174000'`,
        param: '123e4567-e89b-12d3-a456-426614174000',
        expect: exactText('123e4567-e89b-12d3-a456-426614174000'),
      },
      {
        name: 'integer array',
        needs: 'arrays',
        sqlType: 'Array(Int32)',
        literal: '[1, 2, 3]',
        expect: (c) => expect(c).toEqual([1, 2, 3]),
      },
      {
        name: 'text array',
        needs: 'arrays',
        sqlType: 'Array(String)',
        literal: `['a', 'b c']`,
        expect: (c) => expect(c).toEqual(['a', 'b c']),
      },
    ],
  };
}
