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
  /** OpenSearch: `green` / `yellow` / `red` from the cluster health, null when it did not say. */
  clusterStatus?(): Promise<string | null>;
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
): Promise<{ serverVersion: string; engine: ConnectionEngine; clusterStatus?: string | null }> {
  const engine: ConnectionEngine = config.engine ?? 'postgres';
  const driver = (overrides[engine] ?? defaultFactories[engine])();
  try {
    const serverVersion = await driver.connect(config);
    // A cluster state is worth a note, never a failure: the connection itself worked.
    const clusterStatus = driver.clusterStatus
      ? await driver.clusterStatus().catch(() => null)
      : undefined;
    return { serverVersion, engine, ...(clusterStatus !== undefined ? { clusterStatus } : {}) };
  } finally {
    await driver.disconnect();
  }
}

/** The slice of a SQL driver a one-off compare read needs. */
export type ReadOnlyDriver = Omit<TestableDriver, 'connect'> & {
  connect(config: ConnectionConfig, statementTimeoutMs?: number): Promise<string>;
  cancelQuery(): Promise<boolean>;
  aiQuery(sql: string, params?: unknown[], opts?: AiQueryOpts): Promise<QueryResult>;
};

const SQL_ENGINES = new Set<ConnectionEngine>([
  'postgres',
  'mysql',
  'sqlite',
  'clickhouse',
  'duckdb',
]);

/** Compare runs in flight, so a deadline or "Stop" can interrupt them (never the live session). */
const isolatedRuns = new Map<string, ReadOnlyDriver>();

/** Per-statement timeout of an isolated compare session (ClickHouse, DuckDB, SQLite have no other). */
export const COMPARE_TIMEOUT_MS = 120_000;

/** Interrupt a compare run and close its session. False when it already ended. */
export async function cancelIsolatedRun(runId: string): Promise<boolean> {
  const driver = isolatedRuns.get(runId);
  if (!driver) return false;
  isolatedRuns.delete(runId);
  let delivered = false;
  try {
    delivered = await driver.cancelQuery();
  } finally {
    // The run may be stuck on a dead peer: closing the session ends it either way.
    await driver.disconnect().catch(() => undefined);
  }
  return delivered;
}

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
  runId?: string,
  overrides: Partial<Record<ConnectionEngine, () => ReadOnlyDriver>> = {},
): Promise<QueryResult> {
  const engine: ConnectionEngine = config.engine ?? 'postgres';
  if (!SQL_ENGINES.has(engine)) throw new Error(`Compare needs a SQL connection, not ${engine}.`);
  const driver = (
    overrides[engine] ?? (defaultFactories[engine] as unknown as () => ReadOnlyDriver)
  )();
  if (runId) isolatedRuns.set(runId, driver);
  try {
    await driver.connect({ ...config, readOnly: true }, COMPARE_TIMEOUT_MS);
    return await driver.aiQuery(sql, undefined, { maxRows });
  } finally {
    if (runId) isolatedRuns.delete(runId);
    await driver.disconnect().catch(() => undefined);
  }
}
