import type { ConnectionConfig, ConnectionEngine, QueryResult } from '@shared/protocol';
import { ClickhouseDriver } from './drivers/clickhouse';
import { DuckdbDriver } from './drivers/duckdb';
import { MysqlDriver } from './drivers/mysql';
import { OpenSearchDriver } from './drivers/opensearch';
import { PostgresDriver } from './drivers/postgres';
import { RedisDriver } from './drivers/redis';
import type { AiQueryOpts } from './drivers/sql-engine';
import { SqliteDriver } from './drivers/sqlite';

/** Minimal driver surface needed for an isolated connectivity probe. */
export interface TestableDriver {
  connect(config: ConnectionConfig): Promise<string>;
  disconnect(): Promise<void>;
}

export type DriverFactory = () => TestableDriver;

const defaultFactories: Record<ConnectionEngine, DriverFactory> = {
  postgres: () => new PostgresDriver(),
  redis: () => new RedisDriver(),
  opensearch: () => new OpenSearchDriver(),
  sqlite: () => new SqliteDriver(),
  mysql: () => new MysqlDriver(),
  clickhouse: () => new ClickhouseDriver(),
  duckdb: () => new DuckdbDriver(),
};

/**
 * Probe a candidate connection on a throwaway driver instance.
 *
 * Never touches the worker's live drivers / activeEngine. Always disposes
 * the probe driver in `finally`, including when connect throws.
 */
export async function runIsolatedTestConnect(
  config: ConnectionConfig,
  overrides: Partial<Record<ConnectionEngine, DriverFactory>> = {},
): Promise<{ serverVersion: string; engine: ConnectionEngine }> {
  const engine: ConnectionEngine = config.engine ?? 'postgres';
  const driver = (overrides[engine] ?? defaultFactories[engine])();
  try {
    const serverVersion = await driver.connect(config);
    return { serverVersion, engine };
  } finally {
    await driver.disconnect();
  }
}

/** The slice of a SQL driver a one-off compare read needs. */
export type ReadOnlyDriver = TestableDriver & {
  aiQuery(sql: string, params?: unknown[], opts?: AiQueryOpts): Promise<QueryResult>;
};

const SQL_ENGINES = new Set<ConnectionEngine>([
  'postgres',
  'mysql',
  'sqlite',
  'clickhouse',
  'duckdb',
]);

/**
 * Result Compare against another saved connection: open a throwaway driver
 * in a read-only session, run ONE statement through the same read-only path
 * the agent uses (`aiQuery`), and always disconnect. The live session and
 * `activeEngine` are never touched.
 */
export async function runIsolatedReadOnlyQuery(
  config: ConnectionConfig,
  sql: string,
  maxRows: number,
  overrides: Partial<Record<ConnectionEngine, () => ReadOnlyDriver>> = {},
): Promise<QueryResult> {
  const engine: ConnectionEngine = config.engine ?? 'postgres';
  if (!SQL_ENGINES.has(engine)) throw new Error(`Compare needs a SQL connection, not ${engine}.`);
  const driver = (
    overrides[engine] ?? (defaultFactories[engine] as unknown as () => ReadOnlyDriver)
  )();
  try {
    await driver.connect({ ...config, readOnly: true });
    return await driver.aiQuery(sql, undefined, { maxRows });
  } finally {
    await driver.disconnect().catch(() => undefined);
  }
}
