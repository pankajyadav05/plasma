import { describe, expect, it, vi } from 'vitest';
import type { ConnectionConfig } from '@shared/protocol';
import { runIsolatedTestConnect, type TestableDriver } from './test-connect';

function baseConfig(over: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: 'cand-b',
    name: 'Candidate B',
    host: '127.0.0.1',
    port: 5432,
    database: 'b',
    user: 'u',
    password: 'p',
    ssl: false,
    engine: 'postgres',
    ...over,
  };
}

function mockDriver(opts: {
  version?: string;
  connectError?: Error;
  disconnectError?: Error;
}): TestableDriver & { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> } {
  return {
    connect: vi.fn(async () => {
      if (opts.connectError) throw opts.connectError;
      return opts.version ?? 'PostgreSQL 16.0';
    }),
    disconnect: vi.fn(async () => {
      if (opts.disconnectError) throw opts.disconnectError;
    }),
  };
}

describe('runIsolatedTestConnect (U02)', () => {
  it('uses a throwaway driver and always disconnects on success', async () => {
    const liveDisconnect = vi.fn();
    const probe = mockDriver({ version: 'PostgreSQL 16.1' });
    const factories = {
      postgres: () => probe,
      redis: () => mockDriver({}),
      opensearch: () => mockDriver({}),
    };

    const res = await runIsolatedTestConnect(baseConfig(), factories);

    expect(res).toEqual({ serverVersion: 'PostgreSQL 16.1', engine: 'postgres' });
    expect(probe.connect).toHaveBeenCalledOnce();
    expect(probe.disconnect).toHaveBeenCalledOnce();
    expect(liveDisconnect).not.toHaveBeenCalled();
  });

  it('disconnects the throwaway driver even when connect fails', async () => {
    const probe = mockDriver({ connectError: new Error('ECONNREFUSED') });
    const factories = {
      postgres: () => probe,
      redis: () => mockDriver({}),
      opensearch: () => mockDriver({}),
    };

    await expect(runIsolatedTestConnect(baseConfig(), factories)).rejects.toThrow('ECONNREFUSED');
    expect(probe.connect).toHaveBeenCalledOnce();
    expect(probe.disconnect).toHaveBeenCalledOnce();
  });

  it('does not share driver instances across probes (isolation)', async () => {
    const created: TestableDriver[] = [];
    const factories = {
      postgres: () => {
        const d = mockDriver({ version: `v${created.length}` });
        created.push(d);
        return d;
      },
      redis: () => mockDriver({}),
      opensearch: () => mockDriver({}),
    };

    await runIsolatedTestConnect(baseConfig({ id: 'b1' }), factories);
    await runIsolatedTestConnect(baseConfig({ id: 'b2' }), factories);

    expect(created).toHaveLength(2);
    expect(created[0]).not.toBe(created[1]);
    expect(created[0]!.disconnect).toHaveBeenCalledOnce();
    expect(created[1]!.disconnect).toHaveBeenCalledOnce();
  });

  it('routes redis/opensearch to their own factories without touching postgres', async () => {
    const pg = mockDriver({ version: 'pg' });
    const redis = mockDriver({ version: '7.2.0' });
    const os = mockDriver({ version: '2.11.0' });
    const factories = {
      postgres: () => pg,
      redis: () => redis,
      opensearch: () => os,
    };

    const r = await runIsolatedTestConnect(baseConfig({ engine: 'redis' }), factories);
    expect(r).toEqual({ serverVersion: '7.2.0', engine: 'redis' });
    expect(redis.connect).toHaveBeenCalledOnce();
    expect(pg.connect).not.toHaveBeenCalled();
    expect(os.connect).not.toHaveBeenCalled();

    const o = await runIsolatedTestConnect(baseConfig({ engine: 'opensearch' }), factories);
    expect(o).toEqual({ serverVersion: '2.11.0', engine: 'opensearch' });
    expect(os.connect).toHaveBeenCalledOnce();
  });
});
