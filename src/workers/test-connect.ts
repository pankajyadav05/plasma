import type { ConnectionConfig, ConnectionEngine } from '@shared/protocol';
import { OpenSearchDriver } from './drivers/opensearch';
import { PostgresDriver } from './drivers/postgres';
import { RedisDriver } from './drivers/redis';

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
};

/**
 * Probe a candidate connection on a throwaway driver instance.
 *
 * Never touches the worker's live drivers / activeEngine. Always disposes
 * the probe driver in `finally`, including when connect throws.
 */
export async function runIsolatedTestConnect(
  config: ConnectionConfig,
  factories: Record<ConnectionEngine, DriverFactory> = defaultFactories,
): Promise<{ serverVersion: string; engine: ConnectionEngine }> {
  const engine: ConnectionEngine = config.engine ?? 'postgres';
  const driver = factories[engine]();
  try {
    const serverVersion = await driver.connect(config);
    return { serverVersion, engine };
  } finally {
    await driver.disconnect();
  }
}
