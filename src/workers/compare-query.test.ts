import type { ConnectionConfig, QueryResult } from '@shared/protocol';
import { describe, expect, it, vi } from 'vitest';
import { type ReadOnlyDriver, runIsolatedReadOnlyQuery } from './test-connect';

const config = (over: Partial<ConnectionConfig> = {}): ConnectionConfig =>
  ({
    id: 'staging',
    name: 'Staging',
    host: 'h',
    port: 5432,
    database: 'd',
    user: 'u',
    password: 'p',
    ssl: false,
    engine: 'postgres',
    ...over,
  }) as ConnectionConfig;

const result: QueryResult = { columns: [], rows: [], rowCount: 0, durationMs: 1 };

function driver(over: Partial<ReadOnlyDriver> = {}) {
  return {
    connect: vi.fn(async () => 'PostgreSQL 16'),
    disconnect: vi.fn(async () => {}),
    aiQuery: vi.fn(async () => result),
    ...over,
  };
}

describe('runIsolatedReadOnlyQuery (Result Compare)', () => {
  it('connects read-only, runs through the agent path with the row cap, and disconnects', async () => {
    const d = driver();
    const out = await runIsolatedReadOnlyQuery(config({ readOnly: false }), 'select 1', 5000, {
      postgres: () => d,
    });
    expect(out).toBe(result);
    expect(d.connect).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
    expect(d.aiQuery).toHaveBeenCalledWith('select 1', undefined, { maxRows: 5000 });
    expect(d.disconnect).toHaveBeenCalledOnce();
  });

  it('disconnects when the query fails, and when connecting fails', async () => {
    const failing = driver({ aiQuery: vi.fn(async () => Promise.reject(new Error('boom'))) });
    await expect(
      runIsolatedReadOnlyQuery(config(), 'select 1', 10, { postgres: () => failing }),
    ).rejects.toThrow('boom');
    expect(failing.disconnect).toHaveBeenCalledOnce();

    const noConnect = driver({ connect: vi.fn(async () => Promise.reject(new Error('refused'))) });
    await expect(
      runIsolatedReadOnlyQuery(config(), 'select 1', 10, { postgres: () => noConnect }),
    ).rejects.toThrow('refused');
    expect(noConnect.disconnect).toHaveBeenCalledOnce();
  });

  it('refuses engines that are not SQL', async () => {
    await expect(
      runIsolatedReadOnlyQuery(config({ engine: 'redis' }), 'select 1', 10),
    ).rejects.toThrow(/SQL connection/);
  });
});
