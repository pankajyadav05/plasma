import type { ConnectionConfig, QueryResult } from '@shared/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  COMPARE_TIMEOUT_MS,
  type ReadOnlyDriver,
  cancelIsolatedRun,
  runIsolatedIntrospect,
  runIsolatedReadOnlyQuery,
} from './test-connect';

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
    cancelQuery: vi.fn(async () => true),
    aiQuery: vi.fn(async () => result),
    ...over,
  };
}

describe('runIsolatedReadOnlyQuery (Result Compare)', () => {
  it('connects read-only with a timeout, runs through the agent path with the row cap, and disconnects', async () => {
    const d = driver();
    const out = await runIsolatedReadOnlyQuery(
      config({ readOnly: false }),
      'select 1',
      5000,
      undefined,
      { postgres: () => d },
    );
    expect(out).toBe(result);
    expect(d.connect).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true }),
      COMPARE_TIMEOUT_MS,
    );
    expect(d.aiQuery).toHaveBeenCalledWith('select 1', undefined, { maxRows: 5000 });
    expect(d.disconnect).toHaveBeenCalledOnce();
  });

  it('disconnects when the query fails, and when connecting fails', async () => {
    const failing = driver({ aiQuery: vi.fn(async () => Promise.reject(new Error('boom'))) });
    await expect(
      runIsolatedReadOnlyQuery(config(), 'select 1', 10, undefined, { postgres: () => failing }),
    ).rejects.toThrow('boom');
    expect(failing.disconnect).toHaveBeenCalledOnce();

    const noConnect = driver({ connect: vi.fn(async () => Promise.reject(new Error('refused'))) });
    await expect(
      runIsolatedReadOnlyQuery(config(), 'select 1', 10, undefined, { postgres: () => noConnect }),
    ).rejects.toThrow('refused');
    expect(noConnect.disconnect).toHaveBeenCalledOnce();
  });

  it('refuses engines that are not SQL', async () => {
    await expect(
      runIsolatedReadOnlyQuery(config({ engine: 'redis' }), 'select 1', 10),
    ).rejects.toThrow(/SQL connection/);
  });

  it('P2-8: a run in flight can be cancelled by id, which interrupts and closes its session only', async () => {
    let finish!: () => void;
    const d = driver({
      aiQuery: vi.fn(
        () =>
          new Promise<QueryResult>((_resolve, reject) => {
            finish = () => reject(new Error('interrupted'));
          }),
      ),
      cancelQuery: vi.fn(async () => {
        finish();
        return true;
      }),
    });
    const run = runIsolatedReadOnlyQuery(config(), 'select slow()', 10, 'run-1', {
      postgres: () => d,
    });
    run.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 10));
    expect(await cancelIsolatedRun('run-1')).toBe(true);
    await expect(run).rejects.toThrow('interrupted');
    expect(d.cancelQuery).toHaveBeenCalledOnce();
    expect(d.disconnect).toHaveBeenCalled();
    // Finished runs are forgotten: cancelling again is a no-op, never the live session.
    expect(await cancelIsolatedRun('run-1')).toBe(false);
    expect(await cancelIsolatedRun('never-started')).toBe(false);
  });
});

describe('runIsolatedReadOnlyQuery timeout (MCP run_query: 30 s)', () => {
  it('uses the timeout it is given instead of the Compare default', async () => {
    const d = driver();
    await runIsolatedReadOnlyQuery(
      config(),
      'select 1',
      10,
      undefined,
      { postgres: () => d },
      30_000,
    );
    expect(d.connect).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }), 30_000);
  });
});

describe('runIsolatedIntrospect (MCP get_schema on a connection that is not open)', () => {
  const info = {
    schemas: [],
    tables: [],
    columns: [],
    foreignKeys: [],
    routines: [],
    sequences: [],
    types: [],
    extensions: [],
  };
  it('connects read-only, introspects, always disconnects', async () => {
    const d = { ...driver(), introspect: vi.fn(async () => info as never) };
    const out = await runIsolatedIntrospect(config(), { columns: false }, { postgres: () => d });
    expect(out).toBe(info);
    expect(d.connect).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true }),
      COMPARE_TIMEOUT_MS,
    );
    expect(d.introspect).toHaveBeenCalledWith({ columns: false });
    expect(d.disconnect).toHaveBeenCalledOnce();
    const bad = { ...driver(), introspect: vi.fn(async () => Promise.reject(new Error('nope'))) };
    await expect(
      runIsolatedIntrospect(config(), undefined, { postgres: () => bad }),
    ).rejects.toThrow('nope');
    expect(bad.disconnect).toHaveBeenCalledOnce();
  });
  it('refuses engines that are not SQL', async () => {
    await expect(runIsolatedIntrospect(config({ engine: 'redis' }))).rejects.toThrow('SQL');
  });
});
